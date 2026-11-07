package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

// procAddr is ip:port as /proc/net/tcp and tcp6 write it: each 32-bit word
// little-endian.
func procAddr(ip string, port int) string {
	b := net.ParseIP(ip)
	if v4 := b.To4(); v4 != nil && !strings.Contains(ip, ":") {
		b = v4
	}
	b = append([]byte(nil), b...)
	for i := 0; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	return fmt.Sprintf("%s:%04X", strings.ToUpper(hex.EncodeToString(b)), port)
}

// tcpRow is one connection of /proc/net/tcp or tcp6.
type tcpRow struct {
	local, remote string // ip
	state         string // 01 ESTABLISHED, 0A LISTEN
	uid           int
}

// fakeProc writes proc's net/dev with the p2p interfaces' received bytes
// (and lo's, wlan0's) and net/tcp and tcp6 with rows.
func fakeProc(t *testing.T, proc string, rx map[string]uint64, rows ...tcpRow) {
	t.Helper()
	dev := "Inter-|   Receive                                                |  Transmit\n" +
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
		"    lo: 9999999  100    0    0    0     0          0         0  9999999  100    0    0    0     0       0          0\n" +
		"  wlan0: 123456  100    0    0    0     0          0         0  654321  100    0    0    0     0       0          0\n"
	var names []string
	for n := range rx {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		// a long count runs into the colon, as the kernel writes it
		dev += fmt.Sprintf("%s:%d   10    0    0    0     0          0         0  5000   10    0    0    0     0       0          0\n", n, rx[n])
	}
	writeFile(t, filepath.Join(proc, "net", "dev"), dev)
	head := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	v4, v6 := head, head
	for i, r := range rows {
		line := fmt.Sprintf("%4d: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 %d 1 0000000000000000 20 4 30 10 -1\n",
			i, procAddr(r.local, 6031), procAddr(r.remote, 49152), r.state, r.uid, 1000+i)
		if strings.Contains(r.local, ":") {
			v6 += line
		} else {
			v4 += line
		}
	}
	writeFile(t, filepath.Join(proc, "net", "tcp"), v4)
	writeFile(t, filepath.Join(proc, "net", "tcp6"), v6)
}

func TestProcParse(t *testing.T) {
	for in, want := range map[string]string{
		"0100007F":                         "127.0.0.1",
		"0201A8C0":                         "192.168.1.2",
		"0000000000000000FFFF00000100007F": "127.0.0.1",
		"00000000000000000000000001000000": "::1",
		"zz":                               "<nil>",
	} {
		if got := procIP(in); fmt.Sprint(got) != want {
			t.Errorf("procIP(%s) = %v, want %s", in, got, want)
		}
	}
	for _, ip := range []string{"fe80::24a:bff:fe11:3d7c", "2001:db8::1", "10.0.0.7"} {
		a, _, _ := strings.Cut(procAddr(ip, 1), ":")
		if got := procIP(a); !got.Equal(net.ParseIP(ip)) {
			t.Errorf("procIP(%s) = %v, want %s", a, got, ip)
		}
	}
	proc := t.TempDir()
	fakeProc(t, proc, map[string]uint64{"p2p-wlan0-0": 12345678901, "p2p-wlan0-1": 7}, tcpRow{"fe80::1", "fe80::2", "01", 13002})
	if rx := p2pReceived(filepath.Join(proc, "net", "dev")); !reflect.DeepEqual(rx, map[string]uint64{"p2p-wlan0-0": 12345678901, "p2p-wlan0-1": 7}) {
		t.Fatalf("p2p received: %v", rx)
	}
	fakeProc(t, proc, nil,
		tcpRow{"192.168.100.1", "192.168.100.2", "01", 13006}, // a phone
		tcpRow{"127.0.0.1", "127.0.0.1", "01", 13001},         // loopback
		tcpRow{"::", "::ffff:127.0.0.1", "01", 13003},         // loopback, v4-mapped
		tcpRow{"fe80::1", "::", "0A", 13002},                  // listening
		tcpRow{"fe80::1", "fe80::2", "06", 13005},             // TIME_WAIT
		tcpRow{"fe80::1", "fe80::3", "01", 13002})             // a phone, v6
	if got := tcpPeers(filepath.Join(proc, "net", "tcp"), filepath.Join(proc, "net", "tcp6")); !reflect.DeepEqual(got, map[int]bool{13006: true, 13002: true}) {
		t.Fatalf("tcp peers: %v", got)
	}
	for f, b := range map[int]int{2412: 2, 2484: 2, 5180: 5, 5825: 5, 60480: 0, 0: 0} {
		if band(f) != b {
			t.Errorf("band(%d) = %d", f, band(f))
		}
	}
	if otherBand(5)[0] != 2412 || otherBand(2)[0] != 5180 || otherBand(0) != nil || freqList([]int{2412, 2417}) != "2412 2417" {
		t.Fatal("other band")
	}
}

// A session needs both: the projection daemon connected to the phone, and
// a P2P group receiving. Wired CarPlay, a loopback connection or a group
// that stopped receiving is none.
func TestProjection(t *testing.T) {
	gap := projectionGap
	projectionGap = time.Hour // the ticks between the looks below
	t.Cleanup(func() { projectionGap = gap })
	proc := t.TempDir()
	p := newProjection()
	now := time.Now()
	phone := tcpRow{"fe80::1", "fe80::2", "01", uidCarPlay}
	rx := map[string]uint64{"p2p-wlan0-0": 1000, "p2p-wlan0-1": 50}
	look := func(want projSession, what string) {
		t.Helper()
		if got := p.look(proc, now); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %+v, want %+v", what, got, want)
		}
	}
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "first look: no traffic yet")
	rx["p2p-wlan0-0"] += 4000
	fakeProc(t, proc, rx, phone)
	look(projSession{kind: projCarPlay, ifaces: []string{"p2p-wlan0-0"}}, "CarPlay on the 5 GHz group")
	now = now.Add(projectionQuiet / 2)
	look(projSession{kind: projCarPlay, ifaces: []string{"p2p-wlan0-0"}}, "a pause in the traffic")
	rx["p2p-wlan0-1"]++
	fakeProc(t, proc, rx, phone)
	look(projSession{kind: projCarPlay, ifaces: []string{"p2p-wlan0-0", "p2p-wlan0-1"}}, "both groups")
	now = now.Add(projectionQuiet)
	look(projSession{}, "the groups quiet")
	rx["p2p-wlan0-1"]++
	fakeProc(t, proc, rx, tcpRow{"127.0.0.1", "127.0.0.1", "01", uidCarPlay}, tcpRow{"fe80::1", "fe80::2", "01", 1000})
	look(projSession{}, "no projection connection")
	rx["p2p-wlan0-1"]++
	fakeProc(t, proc, rx, tcpRow{"192.168.200.1", "192.168.200.7", "01", uidAndroidAuto})
	look(projSession{kind: projAndroidAuto, ifaces: []string{"p2p-wlan0-1"}}, "Android Auto")
	// wired CarPlay: the connection, no group receiving
	now = now.Add(projectionQuiet)
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "wired CarPlay")
	// a group gone and back counts from its new counter
	delete(rx, "p2p-wlan0-0")
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "a group gone")
	rx["p2p-wlan0-0"] = 10
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "a group back")
	os.RemoveAll(filepath.Join(proc, "net"))
	look(projSession{}, "no /proc/net")

	// after a gap (Wi-Fi off), what the counters grew by meanwhile is no
	// sign of a phone: the first look only takes them
	projectionGap = gap
	p = newProjection()
	rx = map[string]uint64{"p2p-wlan0-0": 1000}
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "a first look")
	now = now.Add(time.Minute)
	rx["p2p-wlan0-0"] += 5000
	fakeProc(t, proc, rx, phone)
	look(projSession{}, "the first look after a gap")
	now = now.Add(2 * time.Second)
	look(projSession{}, "no traffic since")
	rx["p2p-wlan0-0"] += 100
	fakeProc(t, proc, rx, phone)
	now = now.Add(2 * time.Second)
	look(projSession{kind: projCarPlay, ifaces: []string{"p2p-wlan0-0"}}, "traffic now")
}

// carSession is the car's provider with its two P2P groups (wireless
// CarPlay on 5785 and 2462 MHz) and a saved network out of range; phone
// sets the session: CarPlay connected or not, and the groups receiving
// from the phone (every 50 ms, until the next call).
func carSession(t *testing.T) (*wifiProvider, *fakeCar, func(on bool, groups ...string)) {
	p, _, f := carProvider(t)
	quiet := projectionQuiet
	projectionQuiet = 300 * time.Millisecond
	t.Cleanup(func() { projectionQuiet = quiet })
	f.do(func() {
		f.groups = map[string]fakeGroup{
			"p2p-wlanc0-0": {"/fi/w1/wpa_supplicant1/Interfaces/20", 5785},
			"p2p-wlanc0-1": {"/fi/w1/wpa_supplicant1/Interfaces/21", 2462},
		}
	})
	p.car.writeSaved([]savedNet{{ssid: "Home", psk: "homepass1", priority: 5}})
	rx := map[string]uint64{"p2p-wlanc0-0": 100, "p2p-wlanc0-1": 100}
	fakeProc(t, p.proc, rx)
	set := make(chan []string, 1)
	done := make(chan struct{})
	stopped := make(chan struct{})
	t.Cleanup(func() { close(done); <-stopped })
	go func() {
		defer close(stopped)
		var cur []string // "on", then the groups; nil: off
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case cur = <-set:
			case <-tick.C:
			}
			var rows []tcpRow
			if len(cur) > 0 {
				rows = append(rows, tcpRow{"fe80::1", "fe80::2", "01", uidCarPlay})
				for _, g := range cur[1:] {
					rx[g] += 1500
				}
			}
			tmp := t.TempDir()
			fakeProc(t, tmp, rx, rows...)
			for _, n := range []string{"dev", "tcp", "tcp6"} {
				os.Rename(filepath.Join(tmp, "net", n), filepath.Join(p.proc, "net", n))
			}
		}
	}()
	phone := func(on bool, groups ...string) {
		if on {
			set <- append([]string{"on"}, groups...)
		} else {
			set <- nil
		}
	}
	return p, f, phone
}

// ours is our networks' property key in the car's supplicant, and whether
// each is enabled.
func (f *fakeCar) ours(key string) (vals []string, enabled []bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.netPaths() {
		if n := f.nets[p]; n["id_str"] == `"`+carTag+`"` {
			vals, enabled = append(vals, n[key]), append(enabled, n["disabled"] != "1")
		}
	}
	return
}

func oursAre(f *fakeCar, key, val string, on bool) func(wifiStatus) bool {
	return func(wifiStatus) bool {
		vals, enabled := f.ours(key)
		for i := range vals {
			if vals[i] != val || enabled[i] != on {
				return false
			}
		}
		return len(vals) > 0
	}
}

// During wireless CarPlay the car's supplicant scans on its own only on the
// band the phone is not on; with the band not known it does not scan on
// its own at all, and status.json says so; a scan request and a join the
// owner asks for still cover every channel; an association stays; when
// the session ends, the scans are as before.
func TestCarWiFiSession(t *testing.T) {
	p, f, phone := carSession(t)
	shown := scanShown
	scanShown = 300 * time.Millisecond
	t.Cleanup(func() { scanShown = shown })
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "scanning for Home", func(st wifiStatus) bool { return st.Link == "scanning" && oursAre(f, "scan_freq", "", true)(st) })

	// the phone on the 2.4 GHz group: our scans keep to 5 GHz
	phone(true, "p2p-wlanc0-1")
	waitWiFi(t, p, "5 GHz only", func(st wifiStatus) bool {
		return st.Paused == "" && st.Link == "scanning" && oursAre(f, "scan_freq", freqList(freqs5), true)(st)
	})
	// then on the 5 GHz group: 2.4 GHz only, each group's frequency read once
	phone(true, "p2p-wlanc0-0")
	waitWiFi(t, p, "2.4 GHz only", oursAre(f, "scan_freq", freqList(freqs24), true))
	gets := f.called("Get")
	time.Sleep(10 * wifiEvery)
	if f.called("Get") != gets {
		t.Fatalf("read the group's frequency again: %d Get calls", f.called("Get")-gets)
	}

	// a scan request covers every channel; a saved network found on it is joined
	scans := f.called("Scan")
	if err := p.scan(); err != nil || f.called("Scan") != scans+1 {
		t.Fatalf("scan: %v", err)
	}
	// a join keeps every channel until joined, then the limit is back on it too
	f.do(func() { f.bss = append(f.bss, fakeBSS{"Home", -50, "homepass1", 0}) })
	if err := p.connect("Home", ""); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined Home", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == "Home" && oursAre(f, "scan_freq", freqList(freqs24), true)(st)
	})

	// the phone on both groups: the band is not known; joined, nothing paused
	phone(true, "p2p-wlanc0-0", "p2p-wlanc0-1")
	time.Sleep(10 * wifiEvery)
	if st := p.status(); st.Link != "connected" || st.Paused != "" || !oursAre(f, "scan_freq", "", true)(st) {
		vals, on := f.ours("scan_freq")
		t.Fatalf("joined, band not known: %+v %q %v", st, vals, on)
	}
	// out of range: no scans of its own, paused
	f.do(func() { f.bss = f.bss[:len(f.bss)-1] })
	st := waitWiFi(t, p, "paused", func(st wifiStatus) bool { return st.Link == "idle" && oursAre(f, "scan_freq", "", false)(st) })
	if b, _ := json.Marshal(st); st.Paused != projCarPlay || !strings.Contains(string(b), `"paused":"carplay"`) {
		t.Fatalf("paused: %s", b)
	}
	// a scan request: on for the scan, then paused again
	if err := p.scan(); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "on for the scan", func(st wifiStatus) bool { return st.Paused == "" && oursAre(f, "scan_freq", "", true)(st) })
	waitWiFi(t, p, "paused after the scan", func(st wifiStatus) bool { return st.Paused == projCarPlay && oursAre(f, "scan_freq", "", false)(st) })

	// the session ends: as before at once
	phone(false)
	waitWiFi(t, p, "scanning as before", func(st wifiStatus) bool {
		return st.Paused == "" && st.Link == "scanning" && oursAre(f, "scan_freq", "", true)(st)
	})
	f.do(func() {
		if len(f.autoStart) > 0 || len(f.calls) == 0 {
			t.Errorf("calls that could start the car's supplicant: %v", f.autoStart)
		}
	})
}

// With Allow 5 GHz the scans during wireless CarPlay also cover the phone's
// own channel: a station there shares it (an access point on the group's
// channel is found, not only one on the other band); without, the other
// band only.
func TestCarWiFiSessionAllow5(t *testing.T) {
	p, f, phone := carSession(t)
	p.setAllow5(true)
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "scanning for Home", func(st wifiStatus) bool { return st.Link == "scanning" && oursAre(f, "scan_freq", "", true)(st) })

	phone(true, "p2p-wlanc0-0")
	waitWiFi(t, p, "2.4 GHz and 5785", oursAre(f, "scan_freq", freqList(append(slices.Clone(freqs24), 5785)), true))
	phone(true, "p2p-wlanc0-1")
	waitWiFi(t, p, "5 GHz and 2462", oursAre(f, "scan_freq", freqList(append(slices.Clone(freqs5), 2462)), true))

	p.setAllow5(false)
	waitWiFi(t, p, "5 GHz only", oursAre(f, "scan_freq", freqList(freqs5), true))
	phone(false)
	waitWiFi(t, p, "every channel", func(st wifiStatus) bool { return st.Paused == "" && oursAre(f, "scan_freq", "", true)(st) })

	// both groups on one channel: it is listed once
	f.do(func() { f.groups["p2p-wlanc0-1"] = fakeGroup{"/fi/w1/wpa_supplicant1/Interfaces/21", 5785} })
	p.setAllow5(true)
	phone(true, "p2p-wlanc0-0", "p2p-wlanc0-1")
	waitWiFi(t, p, "2.4 GHz and 5785 once", oursAre(f, "scan_freq", freqList(append(slices.Clone(freqs24), 5785)), true))
}

// A call to the car's supplicant never starts it (NO_AUTO_START); others
// go out as they are.
func TestDBusNoAutoStart(t *testing.T) {
	for dest, want := range map[string]byte{wpaDBus: dbusNoAutoStart, "org.freedesktop.DBus": 0} {
		m, err := dbusMessage(7, dest, "/x", "a.b", "C", "s", []any{"y"})
		if err != nil || m[2] != want {
			t.Errorf("%s: flags %#x %v", dest, m[2], err)
		}
		r, err := dbusRead(bytes.NewReader(m))
		if err != nil || r.flags != want || r.member != "C" {
			t.Errorf("%s: read back %+v %v", dest, r, err)
		}
	}
}

// A car supplicant that refuses scan_freq: no scans of its own during the
// session instead; one that refuses to clear it gets the network added
// again without it.
func TestCarWiFiSessionRefused(t *testing.T) {
	p, f, phone := carSession(t)
	f.do(func() { f.refuse = "scan_freq" })
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "scanning for Home", func(st wifiStatus) bool { return st.Link == "scanning" })
	phone(true, "p2p-wlanc0-0")
	waitWiFi(t, p, "paused instead", func(st wifiStatus) bool { return st.Paused == projCarPlay && oursAre(f, "scan_freq", "", false)(st) })
	phone(false)
	waitWiFi(t, p, "as before", func(st wifiStatus) bool { return st.Paused == "" && oursAre(f, "scan_freq", "", true)(st) })

	// takes it, then refuses to clear it
	f.do(func() { f.refuse = "" })
	p.reqMu.Lock()
	p.car.mu.Lock()
	p.car.noFreq = false
	p.car.mu.Unlock()
	p.reqMu.Unlock()
	phone(true, "p2p-wlanc0-0")
	waitWiFi(t, p, "2.4 GHz only", oursAre(f, "scan_freq", freqList(freqs24), true))
	f.do(func() { f.refuse = "scan_freq" })
	before := f.called("AddNetwork")
	phone(false)
	waitWiFi(t, p, "added again", func(st wifiStatus) bool {
		return f.called("AddNetwork") > before && oursAre(f, "scan_freq", "", true)(st)
	})
	if ours, _ := f.count(); ours != 1 {
		t.Fatalf("%d of ours", ours)
	}
}

// mgu-wpa (wlan1, a radio every interface may share): no scans of its own
// during the session while it searches, whatever the band; a join and an
// association are left alone; as before when the session ends.
func TestWiFiSessionMGU(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	other := "bb:bb:bb:bb:bb:bb\t2412\t-70\t[WPA2-PSK-CCMP][ESS]\tOther\tx12345678"
	writeScan(t, scan, "40:d6:3c:68:0c:b7\t2462\t-60\t[ESS]\tCafe\t", other)
	p, c, _ := testProvider(t, scan)
	os.MkdirAll(filepath.Dir(c.wpaConf()), 0700)
	writeFile(t, c.wpaConf(), "ctrl_interface="+c.wpaCtrl()+"\nupdate_config=1\n\nnetwork={\n\tssid=\"Home\"\n\tpsk=\"homepass1\"\n\tkey_mgmt=WPA-PSK\n\tpriority=5\n}\n")
	rx := map[string]uint64{"p2p-wfd0-0": 1}
	fakeProc(t, p.proc, rx)
	p.groupFreq = func(string) (int, error) { t.Error("read a group's frequency on mgu-wpa"); return 0, nil }
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "scanning for Home", func(st wifiStatus) bool { return st.Link == "scanning" && st.Backend == backendMGU })
	rx["p2p-wfd0-0"] += 100
	fakeProc(t, p.proc, rx, tcpRow{"192.168.50.1", "192.168.50.3", "01", uidAndroidAuto})
	waitWiFi(t, p, "paused", func(st wifiStatus) bool { return st.Link == "idle" && st.Paused == projAndroidAuto })
	// the owner joins a network: joined, the association stays
	if err := p.connect("Cafe", ""); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined Cafe", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Cafe" && st.Paused == "" })
	time.Sleep(10 * wifiEvery)
	if st := p.status(); st.Link != "connected" {
		t.Fatalf("association under the session: %+v", st)
	}
	// Cafe gone: paused again; the session ends: searching again
	writeScan(t, scan, other)
	waitWiFi(t, p, "paused again", func(st wifiStatus) bool { return st.Link == "idle" && st.Paused == projAndroidAuto })
	fakeProc(t, p.proc, rx)
	waitWiFi(t, p, "scanning again", func(st wifiStatus) bool { return st.Link == "scanning" && st.Paused == "" })

	// a Connect that fails before SELECT_NETWORK under the session, then the
	// session ends: the supplicant searches again (RECONNECT)
	rx["p2p-wfd0-0"] += 100
	fakeProc(t, p.proc, rx, tcpRow{"192.168.50.1", "192.168.50.3", "01", uidAndroidAuto})
	waitWiFi(t, p, "paused once more", func(st wifiStatus) bool { return st.Link == "idle" && st.Paused == projAndroidAuto })
	// the provider's ticks wait while the test drives the supplicant as
	// connect and the next tick would
	p.reqMu.Lock()
	err := p.wpa.join("Other", "", false, false) // secured, not saved: refused before SELECT_NETWORK
	p.wpa.reload()
	p.wpa.hold(scanHold{idle: true}) // the session ended
	state := p.wpa.status()["wpa_state"]
	p.reqMu.Unlock()
	if err == nil || !strings.Contains(err.Error(), "needs a password") || state != "SCANNING" {
		t.Fatalf("join: %v; after the session: %s", err, state)
	}
	fakeProc(t, p.proc, rx)
	waitWiFi(t, p, "searching after the session", func(st wifiStatus) bool { return st.Link == "scanning" && st.Paused == "" })
}
