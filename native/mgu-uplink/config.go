package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Ifname is the kernel interface every uplink presents. It keeps a prefix on
// connman's NetworkInterfaceBlacklist (/etc/connman/main.conf: vlan, socnet0,
// wlan_bridge, eth, enp, veth): under any other name connmand adopts the link,
// runs its own DHCP and puts a default route for the whole unit in the main
// table.
const Ifname = "vethuplink"

const defaultConfig = "/var/opt/mgu-uplink/current/mgu-uplink.conf"

type config struct {
	Uplink    string   // auto, or netdev:<ifname> (see uplinkChoices)
	Apps      []string // OAP app names, resolved to uids through uids.txt
	UIDs      []int    // static uids (non-app processes)
	Table     int      // routing table holding the uplink's default route
	Pref      int      // first of the three ip rule priorities this tool owns
	OAPDir    string   // OAP install root: oap_<uid>/ per app
	RunDir    string   // lease.json and the DHCP hook socket
	LocalConf string   // read on top of this file when it exists; survives updates
	Settings  string   // read on top of LocalConf when it exists: what requests set (ctl.go); survives updates
	StateDir  string   // uids.d/ and apps.d/; survives updates
	Ignored   []string // settings that pick a device kind or adapter: the uplink takes whatever is plugged in
	Preferred string   // the group tried first (preferGroups; "": the order of autoKinds)
	Skipped   []string // settings left out, logged at the start: a preferred value that is no group, settings_conf lines this version does not take
	WiFi      bool     // the Wi-Fi provider is switched on
	WiFi5     bool     // Wi-Fi joins use 5 GHz too (wifiband.go)
	USBPhone  bool     // phones over USB (rndis, ncm, iphone) are taken (scan.go)
	WiFiIf    string   // the Wi-Fi interface
}

func defaults() config {
	return config{
		Uplink:   "auto",
		Table:    110,
		Pref:     1100,
		OAPDir:   "/var/opt/public/oap",
		RunDir:   "/run/mgu-uplink",
		StateDir: "/var/opt/mgu-uplink",
		WiFiIf:   wifiIfname,
		USBPhone: true,
	}
}

var appNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// loadConfig reads path and then, if they exist, the local_conf and the
// settings_conf it names. Requests write settings_conf only, a file older
// versions do not read, so a rollback never meets a key it lacks.
func loadConfig(path string) (config, error) {
	c := defaults()
	if err := c.read(path, true, false); err != nil {
		return c, err
	}
	if c.LocalConf != "" {
		if err := c.read(c.LocalConf, false, false); err != nil && !os.IsNotExist(err) {
			return c, err
		}
	}
	if c.Settings != "" {
		if err := c.read(c.Settings, false, true); err != nil && !os.IsNotExist(err) {
			return c, err
		}
	}
	return c, c.validate()
}

// read applies a file of "key = value" lines; '#' starts a comment. lenient
// (settings_conf, which newer versions may write): a line it can't apply is
// skipped and noted in Skipped, so a rollback still starts.
func (c *config) read(path string, top, lenient bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 {
			if lenient {
				c.Skipped = append(c.Skipped, fmt.Sprintf("%s:%d: expected key = value", path, n))
				continue
			}
			return fmt.Errorf("%s:%d: expected key = value", path, n)
		}
		key, val := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		if lenient && key != "preferred" && key != "wifi" && key != "wifi_5ghz" && key != "usb_phone" {
			c.Skipped = append(c.Skipped, fmt.Sprintf("%s:%d: unknown key %q", path, n, key))
			continue
		}
		if key == "local_conf" && top {
			c.LocalConf = val
			continue
		}
		if key == "settings_conf" && top {
			c.Settings = val
			continue
		}
		// A local uids adds to the shipped list, so an override written
		// for an older list can never take a shipped uid's egress away.
		if key == "uids" && !top {
			shipped := c.UIDs
			if err := c.set(key, val); err != nil {
				return fmt.Errorf("%s:%d: %v", path, n, err)
			}
			c.UIDs = union(shipped, c.UIDs)
			continue
		}
		if err := c.set(key, val); err != nil {
			if lenient {
				c.Skipped = append(c.Skipped, fmt.Sprintf("%s:%d: %v", path, n, err))
				continue
			}
			return fmt.Errorf("%s:%d: %v", path, n, err)
		}
	}
	return sc.Err()
}

// union is a followed by the elements of b it lacks, in order.
func union[T comparable](a, b []T) []T {
	out := append([]T(nil), a...)
	seen := map[T]bool{}
	for _, u := range a {
		seen[u] = true
	}
	for _, u := range b {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (c *config) set(key, val string) error {
	var err error
	switch key {
	case "uplink":
		// A device kind (usb, usbecm, rndis, ncm, iphone) is not a choice:
		// the uplink takes whatever is plugged in. Such a setting, left on a
		// unit by hand, is ignored rather than refused, so the service starts.
		if val == "auto" || strings.HasPrefix(val, "netdev:") {
			c.Uplink = val
		} else if kindRank(val) < len(autoKinds) {
			c.Ignored = append(c.Ignored, key+" = "+val)
		} else {
			return fmt.Errorf("uplink: %q is none of %s", val, uplinkChoices)
		}
	case "apps":
		c.Apps = splitList(val)
	case "uids":
		c.UIDs = nil
		for _, s := range splitList(val) {
			uid, e := strconv.ParseUint(s, 10, 32)
			if e != nil {
				return fmt.Errorf("uids: %q is not a uid", s)
			}
			c.UIDs = append(c.UIDs, int(uid))
		}
	case "table":
		c.Table, err = strconv.Atoi(val)
	case "rule_pref":
		c.Pref, err = strconv.Atoi(val)
	case "usb_device":
		c.Ignored = append(c.Ignored, key+" = "+val)
	case "preferred":
		if err := checkPreferred(val); err != nil {
			c.Skipped = append(c.Skipped, err.Error())
			break
		}
		c.Preferred = val
	case "wifi":
		if val != "on" && val != "off" {
			return fmt.Errorf("wifi: on or off, not %q", val)
		}
		c.WiFi = val == "on"
	case "wifi_5ghz":
		if val != "on" && val != "off" {
			return fmt.Errorf("wifi_5ghz: on or off, not %q", val)
		}
		c.WiFi5 = val == "on"
	case "usb_phone":
		if val != "on" && val != "off" {
			return fmt.Errorf("usb_phone: on or off, not %q", val)
		}
		c.USBPhone = val == "on"
	default:
		return fmt.Errorf("unknown key %q", key)
	}
	if err != nil {
		return fmt.Errorf("%s: %v", key, err)
	}
	return nil
}

func (c *config) validate() error {
	if _, err := parseUplink(*c); err != nil {
		return err
	}
	for _, a := range c.Apps {
		if !appNameRe.MatchString(a) {
			return fmt.Errorf("apps: bad app name %q", a)
		}
	}
	for _, u := range c.UIDs {
		// uid 0 would hand the uplink to every root process on the unit.
		if u <= 0 {
			return fmt.Errorf("uids: %d is not allowed", u)
		}
	}
	// 253-255 are the kernel's default, main and local tables.
	if c.Table <= 0 || c.Table >= 253 && c.Table <= 255 {
		return fmt.Errorf("table: %d is reserved", c.Table)
	}
	if c.Pref <= 0 || c.Pref+rulePrefs > 32766 {
		return fmt.Errorf("rule_pref: %d must leave room for %d rules before main (32766)", c.Pref, rulePrefs)
	}
	return nil
}

func (c config) uidsFile() string   { return c.OAPDir + "/oap_12201/security/uids.txt" }
func (c config) leaseFile() string  { return c.RunDir + "/lease.json" }
func (c config) hookSocket() string { return c.RunDir + "/hook.sock" }
func (c config) linkFile() string   { return c.RunDir + "/link.json" }
func (c config) statusFile() string { return c.RunDir + "/status.json" }
func (c config) ctlSocket() string  { return c.RunDir + "/ctl.sock" }
func (c config) wifiFile() string   { return c.RunDir + "/wifi.json" }
func (c config) wpaCtrl() string    { return c.RunDir + "/wpa" }     // wpa_supplicant's control socket folder
func (c config) wpaLocal() string   { return c.RunDir + "/wpa-ctl" } // our end of it

// pairDir holds the unit's host identity for iPhone pairing; updates keep it.
func (c config) pairDir() string { return c.StateDir + "/pairing" }

// wpaConf holds the saved Wi-Fi networks, in a folder only root can read;
// updates keep it.
func (c config) wpaConf() string { return c.StateDir + "/wifi/wpa.conf" }

// setSetting makes the conf file path say key = val, or drop key when val
// is "", and keeps every other line as it is.
func setSetting(path, key, val string) error {
	if path == "" {
		return fmt.Errorf("no settings_conf to keep %s in", key)
	}
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var out []string
	done := val == ""
	for _, line := range strings.SplitAfter(string(b), "\n") {
		k := line
		if i := strings.IndexByte(k, '#'); i >= 0 {
			k = k[:i]
		}
		if kv := strings.SplitN(k, "=", 2); len(kv) == 2 && strings.TrimSpace(kv[0]) == key {
			if !done {
				out = append(out, key+" = "+val+"\n")
				done = true
			}
			continue
		}
		if line != "" {
			out = append(out, line)
		}
	}
	if n := len(out); n > 0 && !strings.HasSuffix(out[n-1], "\n") {
		out[n-1] += "\n"
	}
	if !done {
		out = append(out, key+" = "+val+"\n")
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(out, "")), 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Drop-in folders the deploy tool fills per installed component that
// declares "internet": true: uids.d/<id> holds numeric uids, apps.d/<id>
// app names, one per line ('#' starts a comment); an apps.d file with no
// name in it stands for the app named like the file.
func (c config) uidsDir() string { return c.StateDir + "/uids.d" }
func (c config) appsDir() string { return c.StateDir + "/apps.d" }

// dropIns reads the drop-in folders. Entries that are not a valid uid or
// app name are skipped and reported in bad.
func dropIns(c config) (uids []int, apps []string, bad []string) {
	for _, f := range dropInFiles(c.uidsDir()) {
		for _, s := range f.lines {
			uid, err := strconv.ParseUint(s, 10, 32)
			if err != nil || uid == 0 {
				bad = append(bad, fmt.Sprintf("%s: %q", f.path, s))
				continue
			}
			uids = append(uids, int(uid))
		}
	}
	for _, f := range dropInFiles(c.appsDir()) {
		names := f.lines
		if len(names) == 0 {
			names = []string{filepath.Base(f.path)}
		}
		for _, s := range names {
			if !appNameRe.MatchString(s) {
				bad = append(bad, fmt.Sprintf("%s: %q", f.path, s))
				continue
			}
			apps = append(apps, s)
		}
	}
	return uids, apps, bad
}

type dropInFile struct {
	path  string
	lines []string
}

// dropInFiles reads the regular files in dir (names starting with '.' and
// ending in '.tmp' are skipped: in-progress writes), in name order.
func dropInFiles(dir string) []dropInFile {
	entries, _ := os.ReadDir(dir)
	var out []dropInFile
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".") || strings.HasSuffix(n, ".tmp") || !e.Type().IsRegular() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil || len(b) > 4096 {
			continue
		}
		f := dropInFile{path: filepath.Join(dir, n)}
		for _, line := range strings.Split(string(b), "\n") {
			if i := strings.IndexByte(line, '#'); i >= 0 {
				line = line[:i]
			}
			for _, s := range strings.FieldsFunc(line, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\r' }) {
				f.lines = append(f.lines, s)
			}
		}
		out = append(out, f)
	}
	return out
}
