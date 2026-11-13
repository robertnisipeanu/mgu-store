package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vishvananda/netlink"
)

// fastWiFi shortens the provider's timings for a test.
func fastWiFi(t *testing.T) {
	every, join, drop, recheck, own, retry, stable := wifiEvery, joinTimeout, wifiDropAfter, wifiRecheck, wifiOwnRecheck, wifiRetry, wifiStable
	retake, held := wifiRetake, wifiHeld
	wifiEvery, joinTimeout, wifiDropAfter = 50*time.Millisecond, 1500*time.Millisecond, 300*time.Millisecond
	wifiRecheck, wifiOwnRecheck, wifiRetry, wifiStable = 100*time.Millisecond, 200*time.Millisecond, 100*time.Millisecond, time.Hour
	wifiRetake, wifiHeld = 600*time.Millisecond, time.Hour
	t.Cleanup(func() {
		wifiEvery, joinTimeout, wifiDropAfter, wifiRecheck, wifiOwnRecheck, wifiRetry, wifiStable = every, join, drop, recheck, own, retry, stable
		wifiRetake, wifiHeld = retake, held
	})
}

// testProvider is a provider on a fake radio (sysfs with one rfkill, soft
// blocked, in station mode, nobody else using it) and the fake
// wpa_supplicant (wpa_test.go) with scan file scan.
func testProvider(t *testing.T, scan string) (*wifiProvider, config, string) {
	dir := t.TempDir()
	c := defaults()
	c.RunDir, c.StateDir, c.WiFiIf = filepath.Join(dir, "run"), filepath.Join(dir, "state"), "wlant0"
	os.MkdirAll(c.RunDir, 0755)
	p := newWiFiProvider(c, os.Args[0])
	p.sys, p.proc, p.connmanConf = filepath.Join(dir, "sys"), filepath.Join(dir, "proc"), filepath.Join(dir, "main.conf")
	os.MkdirAll(p.proc, 0755)
	soft := filepath.Join(p.sys, "wlant0", "phy80211", "rfkill7", "soft")
	writeFile(t, soft, "1\n")
	writeFile(t, filepath.Join(filepath.Dir(soft), "hard"), "0\n")
	p.linkUp = func(string) (linkState, error) { return linkState{}, nil }
	p.iftype = func(string) (uint32, error) { return nl80211Station, nil }
	p.dbusHas = func(string) (bool, error) { return false, nil }
	t.Setenv(fakeWPAEnv, scan)
	return p, c, soft
}

func waitWiFi(t *testing.T, p *wifiProvider, what string, ok func(wifiStatus) bool) wifiStatus {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if st := p.status(); ok(st) {
			return st
		}
	}
	b, _ := json.Marshal(p.status())
	t.Fatalf("%s: %s", what, b)
	return wifiStatus{}
}

func TestWiFiProvider(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	home := "0a:3c:ff:5b:bc:a7\t2437\t-40\t[WPA2-PSK-CCMP][ESS]\tHome\trightpass1"
	cafe := "40:d6:3c:68:0c:b7\t2462\t-60\t[ESS]\tCafe\t"
	other := "bb:bb:bb:bb:bb:bb\t2412\t-70\t[WPA2-PSK-CCMP][ESS]\tOther\tx12345678"
	writeScan(t, scan, home, cafe, other)
	p, c, soft := testProvider(t, scan)
	statusInit(c.statusFile())
	defer statusInit("")
	setStatus(nil, stateSearching, "")
	// every log line, and the supplicant's output, for the psk check at the end
	logFile := filepath.Join(t.TempDir(), "log")
	out, _ := os.Create(logFile)
	stdout := os.Stdout
	os.Stdout = out
	defer func() { os.Stdout = stdout }()

	p.start()
	stopped := false
	defer func() {
		if !stopped {
			p.stop()
		}
	}()
	waitWiFi(t, p, "off at start", func(st wifiStatus) bool { return st.Link == "off" && !st.Enabled })
	if b, _ := os.ReadFile(c.statusFile()); !strings.Contains(string(b), `"link": "off"`) {
		t.Fatalf("status.json without Wi-Fi off: %s", b)
	}
	if err := p.scan(); err == nil || err.Error() != "Wi-Fi is off" {
		t.Fatalf("scan while off: %v", err)
	}
	if v, _ := readSysctl(soft); v != "1" {
		t.Fatal("radio unblocked while off")
	}
	if err := p.connect("Home", `pa"ss#word1`); err == nil || !strings.Contains(err.Error(), "can't be saved") {
		t.Fatalf("a password wpa.conf can't keep: %v", err)
	}

	p.setEnabled(true)
	waitWiFi(t, p, "idle with 3 networks", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 3 })
	if v, _ := readSysctl(soft); v != "0" || !p.guarding() {
		t.Fatalf("radio %q guarding %v", v, p.guarding())
	}
	if err := p.scan(); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "scanning", func(st wifiStatus) bool { return st.Scanning })
	for psk, want := range map[string]string{"": "needs a password", "short": "8 to 63"} {
		if err := p.connect("Other", psk); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("connect psk %q: %v", psk, err)
		}
	}

	// A wrong password: connecting, not shown as saved, then failed and dropped.
	if err := p.connect("Home", "wrongpass9"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joining Home", func(st wifiStatus) bool {
		return st.Link == "connecting" && st.SSID == "Home" && len(st.Saved) == 0 && !st.Networks[0].Saved
	})
	waitWiFi(t, p, "join failed", func(st wifiStatus) bool {
		return st.Error != nil && strings.Contains(*st.Error, "could not join Home") && len(st.Saved) == 0
	})
	if b, _ := os.ReadFile(c.wpaConf()); strings.Contains(string(b), "Home") {
		t.Fatalf("a failed join was saved:\n%s", b)
	}

	// The right one: joined, saved, the folder root's only.
	if err := p.connect("Home", "rightpass1"); err != nil {
		t.Fatal(err)
	}
	st := waitWiFi(t, p, "joined Home", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == "Home" && reflect.DeepEqual(st.Saved, []string{"Home"})
	})
	if st.Error != nil || st.Signal == nil || *st.Signal != -45 || !st.Networks[0].Current || !st.Networks[0].Saved {
		b, _ := json.Marshal(st)
		t.Fatalf("joined: %s", b)
	}
	if b, _ := os.ReadFile(c.wpaConf()); !strings.Contains(string(b), `ssid="Home"`) {
		t.Fatalf("Home not saved:\n%s", b)
	}
	if fi, err := os.Stat(filepath.Dir(c.wpaConf())); err != nil || fi.Mode().Perm() != 0700 {
		t.Fatalf("wpa.conf's folder: %v %v", fi, err)
	}
	if ssid, ok := p.associated(); !ok || ssid != "Home" {
		t.Fatalf("associated %q %v", ssid, ok)
	}

	// The password entered again for the network it is on: tried before
	// it is saved. A wrong one is not saved, and the saved one is back.
	if err := p.connect("Home", "wrongpass9"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "Home with a wrong password", func(st wifiStatus) bool {
		return st.Error != nil && strings.Contains(*st.Error, "could not join Home")
	})
	waitWiFi(t, p, "back on Home", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Home" })
	if b, _ := os.ReadFile(c.wpaConf()); strings.Contains(string(b), "wrongpass9") || !strings.Contains(string(b), "rightpass1") {
		t.Fatalf("wpa.conf after a wrong password for the current network:\n%s", b)
	}

	// A link on Home ends when the supplicant joins another network.
	l := p.openLink("Home")
	if l.Ifname() != "wlant0" || l.device() != (statusDevice{Kind: kindWiFi, Name: "Home"}) {
		t.Fatalf("link %s %+v", l.Ifname(), l.device())
	}
	if err := p.connect("Cafe", ""); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined Cafe", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Cafe" })
	waitDone(t, l, "joined Cafe instead")

	// ... and when its network is gone.
	l = p.openLink("Cafe")
	writeScan(t, scan, other)
	waitDone(t, l, "Cafe is gone")
	writeScan(t, scan, home, cafe, other)
	if err := p.forget("Cafe"); err != nil {
		t.Fatal(err)
	}
	if err := p.forget("Nope"); err == nil {
		t.Fatal("forgot a network that is not saved")
	}
	waitWiFi(t, p, "back on Home", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == "Home" && reflect.DeepEqual(st.Saved, []string{"Home"})
	})

	// The uplink's lease on the interface makes it online.
	p.setOnline("172.20.10.2", "")
	waitWiFi(t, p, "online", func(st wifiStatus) bool { return st.Link == "online" && st.IP == "172.20.10.2" })
	if b, _ := os.ReadFile(c.statusFile()); !strings.Contains(string(b), `"link": "online"`) ||
		!strings.Contains(string(b), `"ssid": "Home"`) {
		t.Fatalf("status.json: %s", b)
	}

	p.setEnabled(false)
	waitWiFi(t, p, "off again", func(st wifiStatus) bool { return st.Link == "off" })
	// off: not used, the radio left on for the stock system
	if v, _ := readSysctl(soft); v != "0" || p.mgu.isRunning() || p.guarding() || exists(p.record) {
		t.Fatalf("after off: radio soft block %q, supplicant running %v, guarding %v", v, p.mgu.isRunning(), p.guarding())
	}
	p.stop()
	stopped = true
	out.Close()
	if b, _ := os.ReadFile(logFile); strings.Contains(string(b), "rightpass1") || strings.Contains(string(b), "wrongpass9") {
		t.Fatalf("a psk reached the log:\n%s", b)
	}
}

func waitDone(t *testing.T, l *wifiLink, why string) {
	t.Helper()
	select {
	case <-l.Done():
		if l.Err() == nil || !strings.Contains(l.Err().Error(), why) {
			t.Fatalf("link ended: %v, want %q", l.Err(), why)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("link did not end (%s)", why)
	}
	l.Close()
}

// Names wpa_supplicant escapes (a curly apostrophe, quotes, a backslash)
// are recognised once joined; a password with '"' and '#' that wpa.conf
// keeps joins again after the supplicant restarts.
// The car blocks the radio under a running supplicant (connman switching its
// Wi-Fi off blocks every WLAN rfkill): SCAN fails, and the provider takes
// the interface again on its own, unblocking the radio, without Wi-Fi being
// switched off and on.
func TestWiFiRadioBlockedUnder(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan, "0a:3c:ff:5b:bc:a7\t2437\t-40\t[WPA2-PSK-CCMP][ESS]\tHome\trightpass1")
	p, _, soft := testProvider(t, scan)
	t.Setenv(fakeRfkillEnv, soft)
	p.start()
	defer p.stop()
	p.setEnabled(true)
	waitWiFi(t, p, "idle", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 1 })
	if err := p.scan(); err != nil {
		t.Fatal(err)
	}
	writeFile(t, soft, "1\n") // the car
	// from the supplicant's FAIL, or the provider's tick came first
	if err := p.scan(); err == nil || !strings.Contains(err.Error(), "radio is blocked") {
		t.Fatalf("scan on a blocked radio: %v", err)
	}
	waitWiFi(t, p, "given up", func(st wifiStatus) bool { return st.Link == "failed" })
	waitWiFi(t, p, "taken again", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 1 })
	if v, _ := readSysctl(soft); v != "0" {
		t.Fatalf("radio %q", v)
	}
	if err := p.scan(); err != nil {
		t.Fatal(err)
	}
}

func TestWiFiEscapes(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	name, psk := `Mario’s "Hot\spot"`, `pa"ss"#word1`
	quoted := `Joe's "Cafe" #2` // written between quotes, not as hex
	writeScan(t, scan, "0a:3c:ff:5b:bc:a7\t2437\t-40\t[WPA2-PSK-CCMP][ESS]\t"+name+"\t"+psk,
		"0a:3c:ff:5b:bc:a8\t2437\t-50\t[WPA2-PSK-CCMP][ESS]\t"+quoted+"\tcafe#pass1")
	p, c, _ := testProvider(t, scan)
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "the networks seen", func(st wifiStatus) bool { return len(st.Networks) == 2 && st.Networks[0].SSID == name })
	if err := p.connect(name, psk); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == name && reflect.DeepEqual(st.Saved, []string{name}) &&
			st.Networks[0].Current && st.Error == nil
	})
	if err := p.connect(quoted, "cafe#pass1"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined the quoted one", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == quoted && len(st.Saved) == 2
	})
	if b, _ := os.ReadFile(c.wpaConf()); !strings.Contains(string(b), "\tssid=\""+quoted+"\"\n") {
		t.Fatalf("wpa.conf:\n%s", b)
	}
	if err := p.connect(`Joe"s #2`, "whatever1"); err == nil || !strings.Contains(err.Error(), "can't be saved") {
		t.Fatalf("a name wpa.conf can't keep: %v", err)
	}
	if b, _ := os.ReadFile(c.wpaConf()); !strings.Contains(string(b), "\tpsk=\""+psk+"\"\n") {
		t.Fatalf("wpa.conf:\n%s", b)
	}
	p.reqMu.Lock()
	p.mgu.stop()
	p.reqMu.Unlock()
	waitWiFi(t, p, "joined after a restart", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == quoted && len(st.Saved) == 2
	})
}

// A wpa.conf the supplicant can't read is set aside, and Wi-Fi starts
// without saved networks instead of failing at every start.
func TestWiFiBadConf(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan)
	p, c, _ := testProvider(t, scan)
	os.MkdirAll(filepath.Dir(c.wpaConf()), 0700)
	bad := fmt.Sprintf("ctrl_interface=%s\nupdate_config=1\n\nnetwork={\n\tssid=\"Joe\"s #2\"\n\tpsk=\"whatever1\"\n}\n", c.wpaCtrl())
	writeFile(t, c.wpaConf(), bad)
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "set aside", func(st wifiStatus) bool {
		return st.Link == "failed" && st.Error != nil && strings.Contains(*st.Error, "set aside (wpa.conf.bad)")
	})
	// after the retry the note stays until the next join or switch
	waitWiFi(t, p, "idle without saved networks, saying so", func(st wifiStatus) bool {
		return st.Link == "idle" && len(st.Saved) == 0 && st.Error != nil && strings.Contains(*st.Error, "set aside")
	})
	if b, err := os.ReadFile(c.wpaConf() + ".bad"); err != nil || string(b) != bad {
		t.Fatalf("wpa.conf.bad: %q %v", b, err)
	}
	p.setEnabled(true)
	waitWiFi(t, p, "note gone once switched", func(st wifiStatus) bool { return st.Link == "idle" && st.Error == nil })

	// unreadable at RECONFIGURE (a join dropped): set aside too
	os.Remove(c.wpaConf() + ".bad")
	writeScan(t, scan, "0a:3c:ff:5b:bc:a7\t2437\t-40\t[WPA2-PSK-CCMP][ESS]\tHome\trightpass1")
	if err := p.connect("Home", "wrongpass9"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, c.wpaConf(), bad)
	p.connect("Home", "rightpass1") // fails: the supplicant stops, and its restart can't read the file
	waitWiFi(t, p, "set aside at the restart", func(st wifiStatus) bool {
		return st.Error != nil && strings.Contains(*st.Error, "set aside")
	})
	if _, err := os.Stat(c.wpaConf() + ".bad"); err != nil {
		t.Fatalf("not set aside: %v", err)
	}
}

// Switching Wi-Fi while the car takes the interface back and forth: no race
// on the give-back wait, and a switch ends it.
func TestWiFiSwitchDuringGiveBacks(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan)
	p, _, _ := testProvider(t, scan)
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "taken", func(st wifiStatus) bool { return st.Link == "idle" })
	other := filepath.Join(p.proc, "88", "cmdline")
	done := make(chan struct{})
	go func() {
		defer close(done)
		for end := time.Now().Add(1500 * time.Millisecond); time.Now().Before(end); time.Sleep(15 * time.Millisecond) {
			p.setEnabled(true)
		}
	}()
	for end := time.Now().Add(1500 * time.Millisecond); time.Now().Before(end); time.Sleep(120 * time.Millisecond) {
		if exists(other) {
			os.RemoveAll(filepath.Dir(other))
		} else {
			writeFile(t, other, "/usr/sbin/hostapd\x00-iwlant0\x00")
		}
	}
	<-done
	os.RemoveAll(filepath.Dir(other))
	waitWiFi(t, p, "taken once free", func(st wifiStatus) bool { return st.Link == "idle" })
	// a give-back now, then a switch: it ends the wait, so the interface is
	// taken again within a few ticks, not after wifiRetake
	writeFile(t, other, "/usr/sbin/hostapd\x00-iwlant0\x00")
	waitWiFi(t, p, "given back", func(st wifiStatus) bool { return st.Link == "unavailable" })
	os.RemoveAll(filepath.Dir(other))
	p.setEnabled(true)
	start := time.Now()
	waitWiFi(t, p, "taken again after the switch", func(st wifiStatus) bool { return st.Link == "idle" })
	if since := time.Since(start); since >= wifiRetake {
		t.Fatalf("waited %v after a switch", since)
	}
}

// A check that fails while the provider has the interface is no reason to
// give it back; a finding is.
func TestWiFiKeptOnCheckError(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan)
	p, _, _ := testProvider(t, scan)
	var mu sync.Mutex
	var iftypeErr, dbusErr error
	p.iftype = func(string) (uint32, error) { mu.Lock(); defer mu.Unlock(); return nl80211Station, iftypeErr }
	p.dbusHas = func(string) (bool, error) { mu.Lock(); defer mu.Unlock(); return false, dbusErr }
	writeFile(t, filepath.Join(p.proc, "77", "cmdline"), "/usr/sbin/wpa_supplicant_nxp\x00-u\x00-s\x00")
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "taken", func(st wifiStatus) bool { return st.Link == "idle" })
	mu.Lock()
	dbusErr = errors.New("dbus-send: no answer")
	mu.Unlock()
	time.Sleep(4 * wifiOwnRecheck)
	mu.Lock()
	dbusErr, iftypeErr = nil, errors.New("nl80211: busy")
	mu.Unlock()
	time.Sleep(4 * wifiOwnRecheck)
	if st := p.status(); st.Link != "idle" || !p.guarding() || !p.mgu.isRunning() {
		t.Fatalf("given back on a failed check: %+v", st)
	}
}

// The stock system taking the interface while the provider has it: the
// provider gives it back (supplicant stopped, the record's IPv6 put back,
// the link left as it is, rfkill untouched) and is unavailable until it is
// free again.
func TestWiFiTakenBack(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan)
	p, c, soft := testProvider(t, scan)
	// wlant0 was down before the first take; each later take finds it up
	var mu sync.Mutex
	takes := 0
	p.linkUp = func(string) (linkState, error) {
		mu.Lock()
		defer mu.Unlock()
		takes++
		return linkState{Index: 7, Name: "wlant0", OrigName: "wlant0", WasUp: takes > 1}, nil
	}
	record := func() wifiRecord {
		var r wifiRecord
		b, _ := os.ReadFile(p.record)
		json.Unmarshal(b, &r)
		return r
	}
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "taken", func(st wifiStatus) bool { return st.Link == "idle" })
	if !p.guarding() || !p.mgu.isRunning() {
		t.Fatal("not taken")
	}
	other := filepath.Join(p.proc, "88", "cmdline")
	writeFile(t, other, "/usr/sbin/hostapd\x00-iwlant0\x00")
	st := waitWiFi(t, p, "given back", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && strings.Contains(*st.Error, "hostapd runs on wlant0")
	})
	gaveBack := time.Now()
	if p.guarding() || p.mgu.isRunning() || len(supplicants(p.proc, "", c.wpaConf())) != 0 {
		t.Fatalf("still held: %+v", st)
	}
	if r := record(); !r.GivenBack || r.Link.WasUp {
		t.Fatalf("record after the give-back: %+v", r)
	}
	if v, _ := readSysctl(soft); v != "0" {
		t.Fatal("rfkill touched")
	}
	// free again at once, but taken again only after wifiRetake
	os.RemoveAll(filepath.Dir(other))
	waitWiFi(t, p, "taken again once free", func(st wifiStatus) bool { return st.Link == "idle" })
	// gaveBack is when the test saw it, up to a tick late; without the wait it is taken again within wifiRecheck
	if since := time.Since(gaveBack); since < wifiRetake-2*wifiEvery {
		t.Fatalf("taken again after %v", since)
	}
	// the state from before the first take stays
	if r := record(); r.GivenBack || r.Link.WasUp {
		t.Fatalf("record after taking it again: %+v", r)
	}
	p.setEnabled(false)
	waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" })
	if exists(p.record) {
		t.Fatal("record kept after switching off")
	}
}

// Giving the interface to the car puts back IPv6, leaves the link as the
// car has it and keeps the record; a switch-off puts the link back down too
// and removes it.
func TestRestoreWiFiToCar(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (a dummy interface)")
	}
	name := "mguwtest0"
	if err := netlink.LinkAdd(&netlink.Dummy{LinkAttrs: netlink.LinkAttrs{Name: name}}); err != nil {
		t.Skipf("no dummy interface: %v", err)
	}
	defer netlink.LinkDel(&netlink.Dummy{LinkAttrs: netlink.LinkAttrs{Name: name}})
	link, _ := netlink.LinkByName(name)
	record := filepath.Join(t.TempDir(), "wifi.json")
	for _, toCar := range []bool{true, false} {
		netlink.LinkSetDown(link) // down, as stock leaves an unused radio
		writeSysctl(ipv6Sysctl(name), "0")
		ls, err := wifiLinkUp(name)
		if err != nil {
			t.Fatal(err)
		}
		writeJSON(record, wifiRecord{Link: ls}, 0644)
		restoreWiFi(record, toCar)
		l, _ := netlink.LinkByIndex(link.Attrs().Index)
		v, _ := readSysctl(ipv6Sysctl(name))
		if up := l.Attrs().Flags&net.FlagUp != 0; up != toCar || v != ls.IPv6 || exists(record) != toCar {
			t.Fatalf("toCar %v: up %v ipv6 %q (was %q)", toCar, up, v, ls.IPv6)
		}
	}
}

// The stock system using the interface: the provider leaves it alone until
// it is free.
func TestWiFiUnavailable(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan)
	p, _, soft := testProvider(t, scan)
	var mu sync.Mutex
	iftype, dbusHas, dbusErr := uint32(3), false, error(nil)
	p.iftype = func(string) (uint32, error) { mu.Lock(); defer mu.Unlock(); return iftype, nil }
	p.dbusHas = func(string) (bool, error) { mu.Lock(); defer mu.Unlock(); return dbusHas, dbusErr }
	set := func(t uint32, has bool, err error) { mu.Lock(); iftype, dbusHas, dbusErr = t, has, err; mu.Unlock() }
	other := filepath.Join(p.proc, "77", "cmdline")
	p.setEnabled(true)
	p.start()
	defer p.stop()
	for _, step := range []struct {
		setup func()
		why   string
	}{
		{func() {}, "wlant0 is in access point mode"},
		{func() { set(9, false, nil) }, "P2P group owner mode"},
		{func() {
			set(nl80211Station, false, nil)
			writeFile(t, other, "/usr/sbin/wpa_supplicant_nxp\x00-iwlant0\x00")
		}, "another wpa_supplicant"},
		{func() { writeFile(t, other, "/usr/sbin/hostapd\x00-iwlant0\x00") }, "hostapd runs on wlant0"},
		{func() { writeFile(t, other, "/usr/sbin/connmand\x00-n\x00") }, "connman manages wlant0"},
		{func() {
			writeFile(t, other, "/usr/sbin/wpa_supplicant_nxp\x00-u\x00-s\x00")
			set(nl80211Station, true, nil)
		}, "the D-Bus wpa_supplicant has wlant0"},
		{func() { set(nl80211Station, false, errors.New("no reply")) }, "can't ask the D-Bus wpa_supplicant"},
	} {
		// the provider sees each step's change whole: a scan has it look again at once
		func() {
			p.reqMu.Lock()
			defer p.reqMu.Unlock()
			step.setup()
		}()
		waitWiFi(t, p, step.why, func(st wifiStatus) bool {
			return st.Link == "unavailable" && st.Error != nil && strings.Contains(*st.Error, step.why)
		})
		if v, _ := readSysctl(soft); v != "1" || p.guarding() || p.mgu.isRunning() {
			t.Fatalf("%s: took the interface", step.why)
		}
		if err := p.scan(); err == nil || !strings.Contains(err.Error(), step.why) {
			t.Fatalf("scan while unavailable: %v", err)
		}
	}
	set(nl80211Station, false, nil) // the D-Bus supplicant has other interfaces only
	waitWiFi(t, p, "idle once free", func(st wifiStatus) bool { return st.Link == "idle" })
	if !p.guarding() {
		t.Fatal("not taken once free")
	}
}

// No radio: unavailable, nothing started.
func TestWiFiNoRadio(t *testing.T) {
	fastWiFi(t)
	p, _, soft := testProvider(t, filepath.Join(t.TempDir(), "scan"))
	os.RemoveAll(filepath.Join(p.sys, "wlant0"))
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "no radio", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && *st.Error == "no Wi-Fi radio (wlant0)"
	})
	if exists(soft) || p.guarding() || p.mgu.isRunning() {
		t.Fatal("took something without a radio")
	}
}

// A supplicant that crashes, or an interface that won't come up, is tried
// again later each time, and after wifiMaxFails in a row not again until
// Wi-Fi is switched on again; the interface is given back meanwhile.
func TestWiFiBackoff(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeFile(t, scan, "crash\n")
	p, _, _ := testProvider(t, scan)
	var mu sync.Mutex
	ups := 0
	taken := func() int { mu.Lock(); defer mu.Unlock(); return ups }
	p.linkUp = func(string) (linkState, error) { mu.Lock(); defer mu.Unlock(); ups++; return linkState{}, nil }
	p.setEnabled(true)
	p.start()
	defer p.stop()
	var waits []string
	st := waitWiFi(t, p, "failed for good", func(st wifiStatus) bool {
		if st.Error != nil && strings.Contains(*st.Error, "trying again in") {
			if w := (*st.Error)[strings.LastIndex(*st.Error, "in ")+3:]; len(waits) == 0 || waits[len(waits)-1] != w {
				waits = append(waits, w)
			}
		}
		return st.Link == "failed" && st.Error != nil && !strings.Contains(*st.Error, "trying again")
	})
	if !strings.Contains(*st.Error, "wpa_supplicant ended") || p.guarding() || p.mgu.isRunning() {
		t.Fatalf("failed: %s, guarding %v", *st.Error, p.guarding())
	}
	// the waits double; the interface was taken once for the run
	if want := []string{"100 ms)", "200 ms)", "400 ms)", "800 ms)"}; !reflect.DeepEqual(waits, want) || taken() != 1 {
		t.Fatalf("waits %v (want %v), interface taken %d times", waits, want, taken())
	}
	time.Sleep(500 * time.Millisecond)
	if p.status().Link != "failed" || taken() != 1 {
		t.Fatal("tried again after the last failure")
	}

	// Switched on again: tried again, and joins once the supplicant runs.
	writeScan(t, scan)
	p.setEnabled(true)
	waitWiFi(t, p, "idle after switching on again", func(st wifiStatus) bool { return st.Link == "idle" })

	// An interface that won't come up: given back after each try.
	p.setEnabled(false)
	waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" })
	p.reqMu.Lock()
	p.linkUp = func(string) (linkState, error) {
		mu.Lock()
		defer mu.Unlock()
		ups++
		return linkState{}, errors.New("set wlant0 up: operation not possible due to RF-kill")
	}
	p.reqMu.Unlock()
	mu.Lock()
	ups = 0
	mu.Unlock()
	p.setEnabled(true)
	waitWiFi(t, p, "failed for good", func(st wifiStatus) bool {
		return st.Link == "failed" && st.Error != nil && strings.Contains(*st.Error, "RF-kill") && !strings.Contains(*st.Error, "trying again")
	})
	time.Sleep(500 * time.Millisecond)
	if n := taken(); n != wifiMaxFails {
		t.Fatalf("interface tried %d times", n)
	}
	if p.guarding() || exists(p.record) {
		t.Fatal("interface kept after failing")
	}
}

// The preferred group goes first, the others follow; each keeps the usual
// order. Wi-Fi is a candidate only while joined.
func TestPreferredOrder(t *testing.T) {
	c := defaults()
	u := newScanUplink(c)
	order := func() []string {
		ks := append([]string(nil), autoKinds...)
		sort.SliceStable(ks, func(i, j int) bool { return u.rank(ks[i]) < u.rank(ks[j]) })
		return ks
	}
	for _, tc := range []struct {
		prefer string
		want   []string
	}{
		{"", []string{"wifi", "usb", "usbecm", "rndis", "ncm", "iphone"}},
		{"wifi", []string{"wifi", "usb", "usbecm", "rndis", "ncm", "iphone"}},
		{"usb", []string{"usb", "usbecm", "wifi", "rndis", "ncm", "iphone"}},
		{"phone", []string{"rndis", "ncm", "iphone", "wifi", "usb", "usbecm"}},
	} {
		u.setPreferred(tc.prefer)
		if got := order(); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("preferred %q: %v", tc.prefer, got)
		}
	}
	c.Preferred = "phone"
	u = newScanUplink(c)
	if got := order(); got[0] != "rndis" {
		t.Fatalf("phone preferred: %v", got)
	}

	p := newWiFiProvider(c, "")
	u.wifi = p
	p.st = wifiStatus{Enabled: true, Link: "connected", SSID: "Home"}
	found := false
	for _, cand := range u.candidates() {
		found = found || cand.kind == kindWiFi && cand.netdev == wifiIfname && cand.dev.Name == "Home"
	}
	if !found {
		t.Fatalf("no Wi-Fi candidate: %+v", u.candidates())
	}
	p.st.Link = "idle"
	for _, cand := range u.candidates() {
		if cand.kind == kindWiFi {
			t.Fatal("a Wi-Fi candidate while not joined")
		}
	}
}

// The firewall guards the uplink interface, the link's, and the Wi-Fi
// interface while the provider has it.
func TestGuarded(t *testing.T) {
	c := defaults()
	p := newWiFiProvider(c, "")
	s := &service{cfg: c, up: newScanUplink(c), wifi: p}
	if got := s.guarded(); !reflect.DeepEqual(got, []string{Ifname}) {
		t.Fatalf("wifi off: %v", got)
	}
	p.owned = true
	if got := s.guarded(); !reflect.DeepEqual(got, []string{Ifname, wifiIfname}) {
		t.Fatalf("wifi on: %v", got)
	}
	p.owned = false
	s.link = p.openLink("Home")
	defer s.link.Close()
	if got := s.guarded(); !reflect.DeepEqual(got, []string{Ifname, wifiIfname}) {
		t.Fatalf("on a Wi-Fi link: %v", got)
	}
	s = &service{cfg: c, up: &netdevUplink{name: "eth1"}}
	if got := s.guarded(); !reflect.DeepEqual(got, []string{"eth1"}) {
		t.Fatalf("netdev: %v", got)
	}
}

func TestParseUnitAccepts(t *testing.T) {
	got := parseUnitAccepts("table ip filter {\n\tchain output { # handle 3\n" +
		"\t\ttype filter hook output priority 0; policy accept;\n" +
		"\t\toifname \"wlan1\" accept comment \"mgu-uplink\" # handle 41\n" +
		"\t\toifname \"vethuplink\" accept comment \"mgu-uplink\" # handle 40\n" +
		"\t\tjump highpriooutput # handle 12\n" +
		"\t\tmeta skuid 12205 accept comment \"other\" # handle 9\n\t}\n}\n")
	if !reflect.DeepEqual(got, map[string]string{"41": "wlan1", "40": "vethuplink"}) {
		t.Fatalf("%v", got)
	}
}

// Requests change settings_conf line by line: comments and other keys
// stay, and loadConfig reads the result after local_conf.
func TestSettings(t *testing.T) {
	if c, err := loadConfig("mgu-uplink.conf"); err != nil || c.WiFi || c.Preferred != "" ||
		c.Settings != "/var/opt/mgu-uplink/mgu-uplink.settings.conf" {
		t.Fatalf("shipped conf: %+v %v", c, err)
	}
	dir := t.TempDir()
	p, local, settings := filepath.Join(dir, "c.conf"), filepath.Join(dir, "local.conf"), filepath.Join(dir, "settings.conf")
	writeFile(t, p, "local_conf = "+local+"\nsettings_conf = "+settings+"\napps = store\n")
	writeFile(t, local, "preferred = phone\nwifi = off\n")
	c, err := loadConfig(p)
	if err != nil || c.WiFi || c.Preferred != "phone" {
		t.Fatalf("local only: %+v %v", c, err)
	}
	writeFile(t, settings, "# mine\nfuture = 1 # kept\npreferred = usb\npreferred = phone")
	steps := []struct{ key, val, want string }{
		{"preferred", "wifi", "# mine\nfuture = 1 # kept\npreferred = wifi\n"},
		{"wifi", "on", "# mine\nfuture = 1 # kept\npreferred = wifi\nwifi = on\n"},
	}
	for _, s := range steps {
		if err := setSetting(settings, s.key, s.val); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(settings); string(b) != s.want {
			t.Fatalf("%s = %s:\n%q", s.key, s.val, b)
		}
	}
	if c, err = loadConfig(p); err != nil || !c.WiFi || c.Preferred != "wifi" {
		t.Fatalf("read back: %+v %v", c, err)
	}
	setSetting(settings, "preferred", "")
	if b, _ := os.ReadFile(settings); strings.Contains(string(b), "preferred") {
		t.Fatalf("preferred kept:\n%s", b)
	}
	if c, err = loadConfig(p); err != nil || c.Preferred != "phone" {
		t.Fatalf("local's preferred after the setting went: %+v %v", c, err)
	}
	fresh := filepath.Join(dir, "new.conf")
	if err := setSetting(fresh, "wifi", "off"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(fresh); string(b) != "wifi = off\n" {
		t.Fatalf("new file %q", b)
	}
	if err := setSetting("", "wifi", "on"); err == nil {
		t.Fatal("no settings_conf accepted")
	}
	// What this version can't take from settings_conf (a newer version's
	// keys, after a rollback) is skipped, so it still starts.
	for _, skip := range []string{"preferred = iphone\n", "wifi = auto\n", "future = 1\n", "settings_conf = /elsewhere\n",
		"local_conf = /x\n", "uids = 0\n", "not a setting\n"} {
		writeFile(t, settings, skip)
		if c, err := loadConfig(p); err != nil || len(c.Skipped) != 1 || c.Preferred != "phone" || c.WiFi || c.LocalConf != local {
			t.Errorf("%q: %+v %v", skip, c, err)
		}
	}
	// A preferred value that is no group is ignored in any conf.
	writeFile(t, local, "preferred = iphone\n")
	if c, err := loadConfig(p); err != nil || c.Preferred != "" || len(c.Skipped) != 2 || !strings.Contains(c.Skipped[0], "none of wifi, usb, phone") {
		t.Errorf("local preferred = iphone: %+v %v", c, err)
	}
	writeFile(t, local, "wifi = yes\n")
	if _, err := loadConfig(p); err == nil {
		t.Error("a bad value in local_conf accepted")
	}
}

func TestControlRequests(t *testing.T) {
	dir := t.TempDir()
	c := defaults()
	c.RunDir, c.Settings = dir, filepath.Join(dir, "settings.conf")
	writeFile(t, c.Settings, "# the Store's\npreferred = usb\n")
	statusInit(c.statusFile())
	defer statusInit("")
	setStatus(nil, stateSearching, "")
	su := newScanUplink(c)
	p := newWiFiProvider(c, filepath.Join(dir, "none")) // never started
	s := &service{cfg: c, up: su, wifi: p}
	ln, err := listenCtl(c.ctlSocket(), s.request)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if fi, err := os.Stat(c.ctlSocket()); err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("ctl.sock: %v %v", fi, err)
	}
	ask := func(req string) ctlReply {
		t.Helper()
		conn, err := net.Dial("unix", c.ctlSocket())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		conn.Write([]byte(req + "\n"))
		var r ctlReply
		line, _ := bufio.NewReader(conn).ReadBytes('\n')
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatalf("%s: reply %q", req, line)
		}
		return r
	}
	for _, tc := range []struct{ req, err string }{
		{`{"op":"prefer","kind":"wifi"}`, ""},
		{`{"op":"prefer","kind":"iphone"}`, "none of wifi, usb, phone"},
		{`{"op":"prefer"}`, "needs a kind"},
		{`{"op":"wifi-enable"}`, "on: true or false"},
		{`{"op":"wifi-enable","on":true}`, ""},
		{`{"op":"wifi-scan"}`, "Wi-Fi is starting"},
		{`{"op":"wifi-connect","ssid":"Home","psk":"short"}`, "8 to 63"},
		{`{"op":"wifi-forget","ssid":""}`, "1 to 32"},
		{`{"op":"reboot"}`, "unknown op"},
		{`not json`, "bad request"},
		{`{"op":"` + strings.Repeat("x", ctlMaxRequest) + `"}`, "bad request"},
	} {
		r := ask(tc.req)
		if tc.err == "" && (!r.OK || r.Error != "") || tc.err != "" && (r.OK || !strings.Contains(r.Error, tc.err)) {
			t.Errorf("%.60s: %+v, want error %q", tc.req, r, tc.err)
		}
	}
	if b, _ := os.ReadFile(c.Settings); string(b) != "# the Store's\npreferred = wifi\nwifi = on\n" {
		t.Fatalf("settings_conf:\n%s", b)
	}
	if u := su.rank(kindWiFi); u != 0 || su.rank(kindUSB) != len(autoKinds)+1 || !p.enabled {
		t.Fatalf("rank %d enabled %v", u, p.enabled)
	}
	if b, _ := os.ReadFile(c.statusFile()); !strings.Contains(string(b), `"preferred": "wifi"`) {
		t.Fatalf("status.json: %s", b)
	}
	if r := ask(`{"op":"prefer","kind":""}`); !r.OK {
		t.Fatal(r.Error)
	}
	if b, _ := os.ReadFile(c.statusFile()); strings.Contains(string(b), `"preferred"`) {
		t.Fatalf("status.json still names a preferred kind: %s", b)
	}

	// With a named interface (netdev:) there is no Wi-Fi and no order.
	s = &service{cfg: c, up: &netdevUplink{name: "eth1"}}
	kind := "wifi"
	for _, r := range []ctlRequest{{Op: "wifi-scan"}, {Op: "wifi-connect", SSID: "x"}, {Op: "prefer", Kind: &kind}} {
		if err := s.request(r); err == nil {
			t.Errorf("%s accepted with uplink netdev:", r.Op)
		}
	}
}

// status.json carries the preferred kind and the Wi-Fi state only while
// there are any.
func TestStatusWiFi(t *testing.T) {
	path := filepath.Join(t.TempDir(), "status.json")
	statusInit(path)
	defer statusInit("")
	setStatusWiFi(&wifiStatus{Link: "off", Networks: []wifiNetwork{}, Saved: []string{}})
	if _, err := os.Stat(path); err == nil {
		t.Fatal("written before a state")
	}
	setStatus(&statusDevice{Kind: kindWiFi, Name: "Home"}, stateOnline, "")
	setStatusPreferred("wifi")
	b, _ := os.ReadFile(path)
	var st uplinkStatus
	if err := json.Unmarshal(b, &st); err != nil || st.Preferred != "wifi" || st.WiFi == nil || st.WiFi.Link != "off" ||
		st.Device == nil || st.Device.Kind != "wifi" || !strings.Contains(string(b), `"error": null`) {
		t.Fatalf("%s", b)
	}
}
