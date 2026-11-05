package main

import (
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeWPAEnv makes the test binary, started as "<binary> -i <iface> ... -c
// <conf>", a fake wpa_supplicant (fakeWPA); its value is the scan file.
const fakeWPAEnv = "MGU_UPLINK_FAKE_WPA"

// fakeRfkillEnv: the rfkill soft file the fake wpa_supplicant reads.
const fakeRfkillEnv = "MGU_UPLINK_FAKE_RFKILL"

func TestMain(m *testing.M) {
	if scan := os.Getenv(fakeWPAEnv); scan != "" && len(os.Args) > 1 && os.Args[1] == "-i" {
		os.Exit(fakeWPA(scan, os.Args[1:]))
	}
	os.Exit(m.Run())
}

func TestParseScan(t *testing.T) {
	r := "bssid / frequency / signal level / flags / ssid\n" +
		"0a:3c:ff:5b:bc:a7\t2437\t-36\t[WPA2-PSK-CCMP][ESS]\tiPhone - Mario\n" +
		"40:d6:3c:68:0c:b7\t2462\t-31\t[WPA2-PSK-CCMP][ESS]\tMHD ENET 7777\n" +
		"aa:aa:aa:aa:aa:aa\t2437\t-80\t[WPA2-PSK-CCMP][ESS]\tiPhone - Mario\n" +
		"bb:bb:bb:bb:bb:bb\t2412\t-70\t[ESS]\tCafe\\x20Free\n" +
		"cc:cc:cc:cc:cc:cc\t2412\t-50\t[ESS]\t\n"
	n := parseScan(r)
	if len(n) != 3 || n[0].SSID != "MHD ENET 7777" || n[1].SSID != "iPhone - Mario" || n[1].Signal != -36 {
		t.Fatalf("scan: %+v", n)
	}
	if n[2].SSID != "Cafe Free" || n[2].Secure || !n[1].Secure {
		t.Fatalf("open / escaped: %+v", n[2])
	}
	var many strings.Builder
	many.WriteString("bssid / frequency / signal level / flags / ssid\n")
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&many, "aa:aa:aa:aa:aa:%02x\t2412\t-%d\t[ESS]\tnet%d\n", i, 40+i, i)
	}
	if n := parseScan(many.String()); len(n) != maxNetworks || n[0].SSID != "net0" {
		t.Fatalf("%d networks, first %+v", len(n), n[0])
	}
}

func TestParseSaved(t *testing.T) {
	m := parseSaved("network id / ssid / bssid / flags\n0\tiPhone - Mario\tany\t[CURRENT]\n3\tHome\tany\t[DISABLED]\n")
	if m["iPhone - Mario"] != 0 || m["Home"] != 3 || len(m) != 2 {
		t.Fatalf("saved: %v", m)
	}
	if kv := parseKV("wpa_state=COMPLETED\nssid=a=b\n"); kv["wpa_state"] != "COMPLETED" || kv["ssid"] != "a=b" {
		t.Fatalf("kv: %v", kv)
	}
	for _, name := range []string{"Mario’s iPhone", `a\b"c`, "tab\there\x1b", "plain"} {
		if s := unescape(printfEncode(name)); s != name {
			t.Errorf("unescape(%q) = %q", printfEncode(name), s)
		}
	}
}

func TestWiFiChecks(t *testing.T) {
	if checkPSK("1234567") == nil || checkPSK("12345678") != nil || checkPSK("bad\npassword") == nil ||
		checkPSK(strings.Repeat("a", 64)) == nil || checkPSK("päss-word") == nil {
		t.Fatal("psk checks")
	}
	// wpa.conf gives these back as written (wpaConfValue reads it as
	// wpa_supplicant does) ...
	for _, ok := range []string{`pa"ss"#word1`, "pass#word1", `pa"ssword1`, `#"a"b#c"d"#`, `x"y"z"w"q#1`} {
		if err := checkPSK(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
		if v, read := wpaConfValue("\tpsk=\"" + ok + "\""); !read || v != ok {
			t.Errorf("%q read back as %q", ok, v)
		}
	}
	// ... and not these, which are refused
	for _, bad := range []string{`pa"ss#word1`, `"a#bcdefgh`, `a"b"c"#defgh`} {
		if err := checkPSK(bad); err == nil || !strings.Contains(err.Error(), "can't be saved") {
			t.Errorf("%q: %v", bad, err)
		}
		if v, ok := wpaConfValue("\tpsk=\"" + bad + "\""); ok && v == bad {
			t.Errorf("%q reads back whole", bad)
		}
	}
	if checkSSID("") == nil || checkSSID(strings.Repeat("a", 33)) == nil || checkSSID("ok") != nil {
		t.Fatal("ssid checks")
	}
	// a name SAVE_CONFIG writes between quotes: refused where wpa.conf would cut it
	for name, ok := range map[string]bool{`Joe"s #2`: false, `Joe's "Cafe" #2`: true, `a#b`: true, `"x"#"y"#`: true,
		"Mario’s \"#1": true /* hex: has a byte outside ASCII */} {
		if err := checkSSID(name); (err == nil) != ok {
			t.Errorf("checkSSID(%q): %v", name, err)
		}
		if ok && wpaConfString(name)[0] == '"' {
			if v, read := wpaConfValue("\tssid=" + wpaConfString(name)); !read || v != name {
				t.Errorf("%q read back as %q %v", name, v, read)
			}
		}
	}
	for d, want := range map[time.Duration]string{30 * time.Second: "30 s", time.Minute: "1 min", 4 * time.Minute: "4 min", 100 * time.Millisecond: "100 ms"} {
		if got := humanDuration(d); got != want {
			t.Errorf("humanDuration(%v) = %q", d, got)
		}
	}
}

// The stock system's users of the interface.
func TestStockUsers(t *testing.T) {
	dir := t.TempDir()
	conf := "/var/opt/mgu-uplink/wifi/wpa.conf"
	main := filepath.Join(dir, "main.conf")
	writeFile(t, main, "[General]\nNetworkInterfaceBlacklist=vlan,socnet0,wlan_bridge,eth,enp,veth\n")
	hap := filepath.Join(dir, "hostapd.conf")
	writeFile(t, hap, "ctrl_interface=/run/hostapd\ninterface=wlan1\nssid=car\n")
	hapOther := filepath.Join(dir, "hostapd-wfd.conf")
	writeFile(t, hapOther, "interface=wfd0\n")
	// the unit's (connman.service, wpa_supplicant.service)
	nxpConnman := []string{"/usr/sbin/connmand_nxp", "-n", "-d", "src/technology.c:plugins/wifi.c", "-i", "wfd0,p2p-wfd0-0,p2p-wfd0-1", "-r", "--nobacktrace"}
	connman := []string{"/usr/sbin/connmand", "-n", "-d", "src/technology.c:plugins/wifi.c", "-r", "--nobacktrace"}
	dbusWPA := []string{"/usr/sbin/wpa_supplicant_nxp", "-u", "-s", "-d"}
	for _, tc := range []struct {
		args [][]string
		why  string
		dbus bool
	}{
		{nil, "", false},
		{[][]string{{"/var/opt/mgu-uplink/current/wpa_supplicant", "-i", "wlan1", "-D", "nl80211", "-c", conf}}, "", false},
		{[][]string{{"/usr/sbin/wpa_supplicant_nxp", "-iwlan1", "-c/etc/wpa.conf"}}, "another wpa_supplicant", false},
		{[][]string{{"/usr/sbin/wpa_supplicant_nxp", "-iwfd0", "-Dnl80211"}}, "", false},
		{[][]string{dbusWPA, nxpConnman}, "", true},
		{[][]string{dbusWPA, connman}, "connman manages", true},
		{[][]string{dbusWPA, append([]string{"/usr/sbin/connmand_nxp"}, connman[1:]...)}, "connman manages", true},
		{[][]string{{"/usr/sbin/connmand_nxp", "-n", "-iwfd0,wlan*"}}, "connman manages", false},
		{[][]string{{"/usr/sbin/connmand-wait-online_nxp", "-i", "wlan1"}}, "", false},
		{[][]string{{"/usr/sbin/wpa_supplicant", "-dsu"}}, "", true},
		{[][]string{{"/usr/sbin/wpa_supplicant", "-c/etc/u.conf", "-iwfd0"}}, "", false},
		{[][]string{{"/usr/sbin/connmand", "-n", "--device=wlan*"}}, "connman manages", false},
		{[][]string{{"/usr/sbin/connmand", "-n", "-I", "wlan1"}}, "", false},
		{[][]string{{"/usr/sbin/connmand", "-n", "-Pwifi"}}, "", false},
		{[][]string{{"/usr/sbin/connmand", "-n", "--plugin=ethernet"}}, "", false},
		{[][]string{{"/usr/sbin/hostapd", "-B", "-P", "/run/h.pid", hap}}, "hostapd runs", false},
		{[][]string{{"/usr/sbin/hostapd", hapOther}}, "", false},
		{[][]string{{"/usr/sbin/hostapd", "-i", "wfd0,wlan1", hapOther}}, "hostapd runs", false},
		{[][]string{{"/bin/sleep", "-i", "wlan1", "-u"}}, "", false},
	} {
		proc := t.TempDir()
		for i, a := range tc.args {
			writeFile(t, filepath.Join(proc, strconv.Itoa(100+i), "cmdline"), strings.Join(a, "\x00")+"\x00")
		}
		u := stockUsers(proc, "wlan1", conf, main)
		why := u.why + u.connman
		if tc.why == "" && why != "" || !strings.Contains(why, tc.why) || u.dbus != tc.dbus {
			t.Errorf("%v: %+v, want %q dbus %v", tc.args, u, tc.why, tc.dbus)
		}
	}
	writeFile(t, main, "[General]\nNetworkInterfaceBlacklist=vlan,wlan\n")
	if connmanManages(connman[1:], "wlan1", main) {
		t.Error("blacklisted in main.conf, managed")
	}
}

// Only a wpa_supplicant with our config is ours, under its own name (mgu-wpa)
// or the stock one; one on the interface with another config is someone
// else's; one on another interface is not seen.
func TestSupplicants(t *testing.T) {
	proc := t.TempDir()
	conf := "/var/opt/mgu-uplink/wifi/wpa.conf"
	for pid, args := range map[string][]string{
		"101": {"/var/opt/mgu-uplink/current/wpa_supplicant", "-i", "wlan1", "-D", "nl80211", "-c", conf},
		"102": {"/usr/sbin/wpa_supplicant_nxp", "-iwlan1", "-c/etc/wpa.conf"},
		"103": {"/usr/sbin/wpa_supplicant_nxp", "-iwfd0", "-Dnl80211"},
		"104": {"/bin/sleep", "-i", "wlan1"},
		"105": {"/var/opt/mgu-uplink/current/mgu-wpa", "-i", "wlan1", "-D", "nl80211", "-c", conf},
	} {
		writeFile(t, filepath.Join(proc, pid, "cmdline"), strings.Join(args, "\x00")+"\x00")
	}
	got := supplicants(proc, "wlan1", conf)
	if len(got) != 3 || !got[101] || got[102] || !got[105] {
		t.Fatalf("supplicants %v", got)
	}
}

// ---- a fake wpa_supplicant ----

// The scan file: one access point per line, tab-separated: bssid,
// frequency, signal, flags, ssid and the password it takes ("" open).
func writeScan(t *testing.T, path string, rows ...string) {
	t.Helper()
	writeFile(t, path, strings.Join(rows, "\n")+"\n")
}

type fakeNet struct {
	ssid, psk, keyMgmt string
	prio               int
	off                bool
}

// printfEncode escapes a name as wpa_supplicant's printf_encode does in
// STATUS, LIST_NETWORKS and SCAN_RESULTS.
func printfEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c == 033:
			b.WriteString(`\e`)
		case c == '\n':
			b.WriteString(`\n`)
		case c == '\r':
			b.WriteString(`\r`)
		case c == '\t':
			b.WriteString(`\t`)
		case c >= 32 && c <= 126:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, `\x%02x`, c)
		}
	}
	return b.String()
}

// wpaConfValue reads a "key=value" line of wpa.conf as wpa_supplicant 2.10
// does: wpa_config_get_line cuts it at a '#' outside a pair of quotes, and
// wpa_config_parse_string takes a quoted value that ends in its last quote
// (else refuses it) and an unquoted one as hex.
func wpaConfValue(line string) (string, bool) {
	pos := strings.TrimLeft(line, " \t\r")
	end := strings.IndexByte(pos, '#')
	for start := 0; end >= 0; {
		q := strings.IndexByte(pos[start:], '"')
		if q < 0 || start+q > end {
			break
		}
		q2 := strings.IndexByte(pos[start+q+1:], '"')
		if q2 < 0 {
			break
		}
		start += q + 1 + q2 + 1
		if start > end {
			end = strings.IndexByte(pos[start:], '#')
			if end >= 0 {
				end += start
			}
		}
	}
	if end >= 0 {
		pos = pos[:end]
	}
	_, v, _ := strings.Cut(strings.TrimRight(pos, " \t\r\n"), "=")
	if !strings.HasPrefix(v, `"`) {
		b, err := hex.DecodeString(v)
		return string(b), err == nil
	}
	v = v[1:]
	i := strings.LastIndexByte(v, '"')
	if i < 0 || i != len(v)-1 {
		return v, false
	}
	return v[:i], true
}

// wpaConfString writes a name as SAVE_CONFIG does: hex when it has a byte
// outside printable ASCII, else between quotes as it is.
func wpaConfString(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] < 32 || s[i] >= 127 {
			return hex.EncodeToString([]byte(s))
		}
	}
	return `"` + s + `"`
}

// fakeWPA serves the control commands wpa.go sends, joining the enabled
// network of the highest priority whose password matches an access point
// of the scan file. Like wpa_supplicant it refuses a config whose
// passphrase reads back shorter than 8, and selecting the network it is
// joined to keeps the association. A scan file starting with "crash"
// makes it exit at once.
func fakeWPA(scanFile string, args []string) int {
	if b, _ := os.ReadFile(scanFile); strings.HasPrefix(string(b), "crash") {
		return 1
	}
	var iface, conf string
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "-i":
			iface = args[i+1]
		case "-c":
			conf = args[i+1]
		}
	}
	ctrl, nets, next := "", map[int]*fakeNet{}, 0
	load := func() bool {
		b, _ := os.ReadFile(conf)
		nets, next = map[int]*fakeNet{}, 0
		var n *fakeNet
		for _, l := range strings.Split(string(b), "\n") {
			k, v, _ := strings.Cut(strings.TrimSpace(l), "=")
			switch {
			case k == "ctrl_interface":
				ctrl = v
			case k == "network":
				n = &fakeNet{}
				nets[next] = n
				next++
			case n != nil && k == "ssid":
				var ok bool
				if n.ssid, ok = wpaConfValue(l); !ok {
					return false
				}
			case n != nil && k == "psk":
				var ok bool
				if n.psk, ok = wpaConfValue(l); !ok || len(n.psk) < 8 {
					return false
				}
			case n != nil && k == "key_mgmt":
				n.keyMgmt = v
			case n != nil && k == "priority":
				n.prio, _ = strconv.Atoi(v)
			}
		}
		return true
	}
	scanRows := func() [][]string {
		b, _ := os.ReadFile(scanFile)
		var rows [][]string
		for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			if f := strings.Split(l, "\t"); len(f) == 6 {
				rows = append(rows, f)
			}
		}
		return rows
	}
	// disconnected: as wpa_supplicant's after DISCONNECT, until RECONNECT or
	// SELECT_NETWORK; RECONFIGURE keeps it
	state, cur, curFreq, disconnected := "INACTIVE", -1, "", false
	try := func() {
		if disconnected {
			state, cur = "DISCONNECTED", -1
			return
		}
		best, freq := -1, ""
		for id, n := range nets {
			for _, r := range scanRows() {
				if !n.off && r[4] == n.ssid && (r[5] == "" && n.keyMgmt == "NONE" || r[5] != "" && r[5] == n.psk) &&
					(best < 0 || n.prio > nets[best].prio) {
					best, freq = id, r[1]
				}
			}
		}
		state, cur, curFreq = "INACTIVE", best, freq
		for _, n := range nets {
			if !n.off {
				state = "SCANNING"
			}
		}
		if best >= 0 {
			state = "COMPLETED"
		}
	}
	if !load() {
		fmt.Printf("Failed to read or parse configuration '%s'.\n", conf)
		return 255
	}
	try()
	os.MkdirAll(ctrl, 0770)
	srv, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: filepath.Join(ctrl, iface), Net: "unixgram"})
	if err != nil {
		return 1
	}
	buf := make([]byte, 4096)
	for {
		n, from, err := srv.ReadFromUnix(buf)
		if err != nil {
			return 0
		}
		f := strings.SplitN(string(buf[:n]), " ", 4)
		id := -1
		if len(f) > 1 {
			if id, err = strconv.Atoi(f[1]); err != nil {
				id = -1
			}
		}
		reply := "OK\n"
		// a radio blocked under it: wpa_supplicant 2.10 disables the
		// interface and refuses SCAN with a plain FAIL
		if b, _ := os.ReadFile(os.Getenv(fakeRfkillEnv)); strings.TrimSpace(string(b)) == "1" {
			switch f[0] {
			case "STATUS":
				srv.WriteToUnix([]byte("wpa_state=INTERFACE_DISABLED\n"), from)
				continue
			case "SCAN":
				srv.WriteToUnix([]byte("FAIL\n"), from)
				continue
			}
		}
		switch f[0] {
		case "STATUS":
			if cur >= 0 && nets[cur] != nil {
				still := false
				for _, r := range scanRows() {
					still = still || r[4] == nets[cur].ssid
				}
				if !still {
					try()
				}
			}
			reply = "wpa_state=" + state + "\n"
			if state == "COMPLETED" {
				reply += "ssid=" + printfEncode(nets[cur].ssid) + "\n"
				if curFreq != "0" {
					reply += "freq=" + curFreq + "\n"
				}
			}
		case "SIGNAL_POLL":
			reply = "FAIL\n"
			if state == "COMPLETED" {
				reply = "RSSI=-45\nLINKSPEED=72\n"
			}
		case "SCAN_RESULTS":
			reply = "bssid / frequency / signal level / flags / ssid\n"
			for _, r := range scanRows() {
				reply += strings.Join(r[:4], "\t") + "\t" + printfEncode(r[4]) + "\n"
			}
		case "LIST_NETWORKS":
			reply = "network id / ssid / bssid / flags\n"
			var ids []int
			for i := range nets {
				ids = append(ids, i)
			}
			sort.Ints(ids)
			for _, i := range ids {
				reply += fmt.Sprintf("%d\t%s\tany\t\n", i, printfEncode(nets[i].ssid))
			}
		case "ADD_NETWORK":
			nets[next] = &fakeNet{}
			reply = fmt.Sprintf("%d\n", next)
			next++
		case "SET_NETWORK":
			nn := nets[id]
			if nn == nil || len(f) < 4 {
				reply = "FAIL\n"
				break
			}
			switch f[2] {
			case "ssid":
				b, _ := hex.DecodeString(f[3])
				nn.ssid = string(b)
			case "psk":
				nn.psk = strings.Trim(f[3], `"`)
			case "key_mgmt":
				nn.keyMgmt = f[3]
			case "priority":
				nn.prio, _ = strconv.Atoi(f[3])
			}
		case "SELECT_NETWORK":
			disconnected = false
			for i, nn := range nets {
				nn.off = i != id
			}
			if state != "COMPLETED" || cur != id {
				try()
			}
		case "DISCONNECT":
			state, cur, disconnected = "DISCONNECTED", -1, true
		case "RECONNECT":
			if disconnected {
				disconnected = false
				try()
			}
		case "ENABLE_NETWORK":
			for _, nn := range nets {
				nn.off = false
			}
		case "REMOVE_NETWORK":
			delete(nets, id)
			try()
		case "RECONFIGURE":
			if !load() {
				fmt.Printf("Failed to parse the configuration file '%s' - exiting\n", conf)
				reply = "FAIL\n"
				break
			}
			try()
		case "SAVE_CONFIG":
			out := fmt.Sprintf("ctrl_interface=%s\nupdate_config=1\nap_scan=1\n", ctrl)
			for i := 0; i < next; i++ {
				if nn := nets[i]; nn != nil {
					out += fmt.Sprintf("\nnetwork={\n\tssid=%s\n", wpaConfString(nn.ssid))
					if nn.psk != "" {
						out += fmt.Sprintf("\tpsk=\"%s\"\n", nn.psk)
					}
					out += fmt.Sprintf("\tkey_mgmt=%s\n\tpriority=%d\n}\n", nn.keyMgmt, nn.prio)
				}
			}
			os.WriteFile(conf, []byte(out), 0644) // the real one ignores the file's mode too
		case "SCAN":
		default:
			reply = "UNKNOWN COMMAND\n"
		}
		srv.WriteToUnix([]byte(reply), from)
	}
}
