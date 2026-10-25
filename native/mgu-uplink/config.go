package main

import (
	"bufio"
	"fmt"
	"os"
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
	Uplink    string   // "usb", "usbecm" or "netdev:<ifname>"
	Apps      []string // OAP app names, resolved to uids through uids.txt
	UIDs      []int    // static uids (non-app processes)
	Table     int      // routing table holding the uplink's default route
	Pref      int      // first of the three ip rule priorities this tool owns
	OAPDir    string   // OAP install root: oap_<uid>/ per app
	RunDir    string   // lease.json and the DHCP hook socket
	USBDevice string   // optional VID:PID: the usb uplink uses only this adapter
	LocalConf string   // read on top of this file when it exists; survives updates
}

func defaults() config {
	return config{
		Uplink: "usb",
		Table:  110,
		Pref:   1100,
		OAPDir: "/var/opt/public/oap",
		RunDir: "/run/mgu-uplink",
	}
}

var (
	appNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	vidPidRe  = regexp.MustCompile(`^[0-9a-f]{4}:[0-9a-f]{4}$`)
)

// loadConfig reads path and then, if it exists, the local_conf it names.
func loadConfig(path string) (config, error) {
	c := defaults()
	if err := c.read(path, true); err != nil {
		return c, err
	}
	if c.LocalConf != "" {
		if err := c.read(c.LocalConf, false); err != nil && !os.IsNotExist(err) {
			return c, err
		}
	}
	return c, c.validate()
}

// read applies a file of "key = value" lines; '#' starts a comment.
func (c *config) read(path string, top bool) error {
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
			return fmt.Errorf("%s:%d: expected key = value", path, n)
		}
		key, val := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		if key == "local_conf" && top {
			c.LocalConf = val
			continue
		}
		// The shipped uids are the services the unit needs (the updater, the
		// shared Tailscale node); a local uids adds to them, so an override
		// written for an older list can never take their egress away.
		if key == "uids" && !top {
			shipped := c.UIDs
			if err := c.set(key, val); err != nil {
				return fmt.Errorf("%s:%d: %v", path, n, err)
			}
			c.UIDs = unionUIDs(shipped, c.UIDs)
			continue
		}
		if err := c.set(key, val); err != nil {
			return fmt.Errorf("%s:%d: %v", path, n, err)
		}
	}
	return sc.Err()
}

// unionUIDs is a followed by the uids of b it lacks, in order.
func unionUIDs(a, b []int) []int {
	out := append([]int(nil), a...)
	seen := map[int]bool{}
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
		c.Uplink = val
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
		c.USBDevice = strings.ToLower(val)
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
	if c.USBDevice != "" && !vidPidRe.MatchString(c.USBDevice) {
		return fmt.Errorf("usb_device: %q is not VID:PID in hex", c.USBDevice)
	}
	return nil
}

func (c config) uidsFile() string   { return c.OAPDir + "/oap_12201/security/uids.txt" }
func (c config) leaseFile() string  { return c.RunDir + "/lease.json" }
func (c config) hookSocket() string { return c.RunDir + "/hook.sock" }
func (c config) linkFile() string   { return c.RunDir + "/link.json" }
