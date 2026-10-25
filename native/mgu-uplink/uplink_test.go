package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.conf")
	writeFile(t, p, "# comment\napps = store, voice # trailing\nuids = 12990,12991\nuplink = netdev:vethuplink\nusb_device = 0B95:1790\n")
	c, err := loadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Apps, []string{"store", "voice"}) || !reflect.DeepEqual(c.UIDs, []int{12990, 12991}) ||
		c.Uplink != "netdev:vethuplink" || c.USBDevice != "0b95:1790" || c.Table != 110 || c.Pref != 1100 {
		t.Fatalf("parsed %+v", c)
	}
	for _, bad := range []string{"uids = 0\n", "uids = x\n", "nope = 1\n", "table = 254\n", "uplink = ppp\n",
		"usb_device = 0b95\n", "apps = a/b\n", "uplink = netdev:\n", "rule_pref = 32765\n",
		"uids = 4294967296\n", "uids = -1\n", "run_dir = /tmp\n"} {
		writeFile(t, p, bad)
		if _, err := loadConfig(p); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
}

func TestLocalConf(t *testing.T) {
	dir := t.TempDir()
	p, local := filepath.Join(dir, "c.conf"), filepath.Join(dir, "local.conf")
	writeFile(t, p, "local_conf = "+local+"\napps = store\nuids = 12990\nuplink = usb\n")
	c, err := loadConfig(p)
	if err != nil || !reflect.DeepEqual(c.Apps, []string{"store"}) || c.Uplink != "usb" {
		t.Fatalf("without a local file: %+v %v", c, err)
	}
	writeFile(t, local, "apps = voice, store\nuplink = netdev:vethuplink\n")
	c, err = loadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Apps, []string{"voice", "store"}) || c.Uplink != "netdev:vethuplink" ||
		!reflect.DeepEqual(c.UIDs, []int{12990}) {
		t.Fatalf("with a local file: %+v", c)
	}
	for _, bad := range []string{"local_conf = /elsewhere\n", "uids = 0\n", "nope = 1\n"} {
		writeFile(t, local, bad)
		if _, err := loadConfig(p); err == nil {
			t.Errorf("local %q: accepted", bad)
		}
	}
}

// A local uids adds to the shipped ones: an override written for an older
// shipped list (12990, 12991) keeps the shipped 12993.
func TestLocalUIDsAddToShipped(t *testing.T) {
	dir := t.TempDir()
	p, local := filepath.Join(dir, "c.conf"), filepath.Join(dir, "local.conf")
	writeFile(t, p, "local_conf = "+local+"\nuids = 12990, 12993\n")
	writeFile(t, local, "uids = 12990, 12991\n")
	c, err := loadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.UIDs, []int{12990, 12993, 12991}) {
		t.Fatalf("uids %v, want [12990 12993 12991]", c.UIDs)
	}
}

func TestResolveUIDs(t *testing.T) {
	c := defaults()
	c.OAPDir = t.TempDir()
	c.Apps = []string{"store", "missing", "doom"}
	c.UIDs = []int{12990, 12207}
	writeFile(t, c.uidsFile(), "12203=trigger_service\n12205=store\n12207=doom")
	uids, byApp, missing := resolveUIDs(c)
	if !reflect.DeepEqual(uids, []int{12205, 12207, 12990}) ||
		!reflect.DeepEqual(byApp, map[string]int{"store": 12205, "doom": 12207}) ||
		!reflect.DeepEqual(missing, []string{"missing"}) {
		t.Fatalf("uids %v byApp %v missing %v", uids, byApp, missing)
	}
}

func TestHookLease(t *testing.T) {
	env := map[string]string{"ip": "192.168.8.100", "subnet": "255.255.255.0", "router": "192.168.8.1 192.168.8.2",
		"dns": "192.168.8.1 fe80::1", "lease": "43200"}
	e := eventFromEnv("bound", func(k string) string { return env[k] })
	l, err := e.lease("vethuplink")
	if err != nil {
		t.Fatal(err)
	}
	if l.IP != "192.168.8.100" || l.Prefix != 24 || l.Router != "192.168.8.1" ||
		!reflect.DeepEqual(l.DNS, []string{"192.168.8.1"}) || l.LeaseSec != 43200 || l.Interface != "vethuplink" {
		t.Fatalf("lease %+v", l)
	}
	env["router"] = ""
	if _, err := eventFromEnv("bound", func(k string) string { return env[k] }).lease("vethuplink"); err == nil {
		t.Fatal("lease without a router accepted")
	}
}

func TestNftRuleset(t *testing.T) {
	r := nftRuleset("vethuplink", []int{12205, 12990})
	for _, want := range []string{
		"add table inet mgu_uplink\ndelete table inet mgu_uplink\n",
		`oifname "vethuplink" meta nfproto ipv4 meta skuid 12205 accept`,
		`oifname "vethuplink" meta nfproto ipv4 meta skuid 12990 accept`,
		`oifname "vethuplink" counter drop`,
		`iifname "vethuplink" counter drop`,
	} {
		if !strings.Contains(r, want) {
			t.Errorf("ruleset lacks %q:\n%s", want, r)
		}
	}
}

func TestWantRules(t *testing.T) {
	c := defaults()
	want := wantRules(c, []int{12205, 12990}, nil)
	if len(want) != 4 {
		t.Fatalf("%d rules, want 4 (2 per uid)", len(want))
	}
	for k, r := range want {
		switch k.pref {
		case c.Pref + prefMain:
			if r.Table != mainTable || r.SuppressPrefixlen != 0 {
				t.Errorf("main rule %+v", r)
			}
		case c.Pref + prefUplink:
			if r.Table != c.Table {
				t.Errorf("uplink rule %+v", r)
			}
		default:
			t.Errorf("unexpected rule %+v", k)
		}
	}
}

// fakeNetdev adds /sys/class/net/<name> with its USB interface and device.
func fakeNetdev(t *testing.T, sys, name, typ, driver, vid, pid string) {
	t.Helper()
	dev := filepath.Join(sys, "devices", name, "1-1")
	intf := filepath.Join(dev, "1-1:1.0")
	writeFile(t, filepath.Join(dev, "idVendor"), vid+"\n")
	writeFile(t, filepath.Join(dev, "idProduct"), pid+"\n")
	for _, d := range []string{filepath.Join(sys, "bus", "usb"), filepath.Join(sys, "drivers", driver)} {
		os.MkdirAll(d, 0755)
	}
	os.MkdirAll(intf, 0755)
	os.Symlink(filepath.Join(sys, "bus", "usb"), filepath.Join(intf, "subsystem"))
	os.Symlink(filepath.Join(sys, "drivers", driver), filepath.Join(intf, "driver"))
	net := filepath.Join(sys, "class", "net", name)
	writeFile(t, filepath.Join(net, "type"), typ+"\n")
	os.Symlink(intf, filepath.Join(net, "device"))
}

func TestUSBNetdevs(t *testing.T) {
	sys := t.TempDir()
	class := filepath.Join(sys, "class", "net")
	fakeNetdev(t, sys, "eth2", "1", "ax88179_178a", "0b95", "1790")
	fakeNetdev(t, sys, "eth1", "1", "asix", "0b95", "772b")
	fakeNetdev(t, sys, "wlan0", "1", "rndis_host", "1234", "0001")
	os.MkdirAll(filepath.Join(class, "wlan0", "wireless"), 0755)
	fakeNetdev(t, sys, "wwan0", "519", "qmi_wwan", "1199", "9071")
	fakeNetdev(t, sys, "eth3", "1", "unknown_drv", "abcd", "0001")
	writeFile(t, filepath.Join(class, "eth0", "type"), "1\n") // not USB

	if got := usbNetdevs(class, ""); !reflect.DeepEqual(got, []string{"eth1", "eth2"}) {
		t.Errorf("any adapter: %v", got)
	}
	if got := usbNetdevs(class, "0b95:1790"); !reflect.DeepEqual(got, []string{"eth2"}) {
		t.Errorf("by VID:PID: %v", got)
	}
	if got := usbNetdevs(class, "abcd:0001"); !reflect.DeepEqual(got, []string{"eth3"}) {
		t.Errorf("named device on another driver: %v", got)
	}
	fakeNetdev(t, sys, Ifname, "1", "asix", "0b95", "7720")
	if got := usbNetdevs(class, ""); len(got) == 0 || got[0] != Ifname {
		t.Errorf("leftover %s not first: %v", Ifname, got)
	}
}

func TestAppStateIgnoresPlantedLinks(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("chown needs root")
	}
	c := defaults()
	c.OAPDir, c.RunDir = t.TempDir(), t.TempDir()
	data := filepath.Join(c.OAPDir, "oap_12205", "data")
	victim := filepath.Join(t.TempDir(), "victim")
	writeFile(t, victim, "keep\n")
	os.MkdirAll(data, 0770)
	os.Symlink(victim, filepath.Join(data, appStateName+".tmp"))
	os.Symlink(victim, filepath.Join(data, appStateName))
	// An app that is not allowed: its data dir is a link to elsewhere.
	elsewhere := t.TempDir()
	writeFile(t, filepath.Join(elsewhere, appStateName), "keep\n")
	os.MkdirAll(filepath.Join(c.OAPDir, "oap_12207"), 0770)
	os.Symlink(elsewhere, filepath.Join(c.OAPDir, "oap_12207", "data"))

	l := &Lease{Interface: Ifname, IP: "192.168.8.100", Prefix: 24, Router: "192.168.8.1"}
	if err := syncAppState(c, map[string]int{"store": 12205}, l); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{victim, filepath.Join(elsewhere, appStateName)} {
		if b, _ := os.ReadFile(p); string(b) != "keep\n" {
			t.Errorf("%s changed: %q", p, b)
		}
	}
	st, err := os.Lstat(filepath.Join(data, appStateName))
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0640 {
		t.Fatalf("uplink.json: %v %v", st, err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, appStateName)); !strings.Contains(string(b), `"ip": "192.168.8.100"`) {
		t.Errorf("uplink.json holds %q", b)
	}
	if err := syncAppState(c, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(data, appStateName)); !os.IsNotExist(err) {
		t.Errorf("uplink.json left after going offline: %v", err)
	}
}
