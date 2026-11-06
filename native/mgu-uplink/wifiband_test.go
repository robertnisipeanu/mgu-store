package main

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBandHelpers(t *testing.T) {
	for f, b := range map[int]int{2412: bit24, 2472: bit24, 5180: bit5, 5825: bit5, 0: 0, 60480: 0} {
		if bandBit(f) != b {
			t.Errorf("bandBit(%d) = %d", f, bandBit(f))
		}
	}
	rows := parseScanRows("bssid / frequency / signal level / flags / ssid\n" +
		"aa:aa:aa:aa:aa:01\t2462\t-60\t[WPA2-PSK-CCMP][ESS]\tDual\n" +
		"aa:aa:aa:aa:aa:02\t5745\t-50\t[WPA2-PSK-CCMP][ESS]\tDual\n" +
		"aa:aa:aa:aa:aa:03\t5745\t-55\t[WPA2-PSK-CCMP][ESS]\tFive\n")
	if b := bandsOf(rows); !reflect.DeepEqual(b, map[string]int{"Dual": bit24 | bit5, "Five": bit5}) {
		t.Fatalf("bands %v", b)
	}
	if n := bestNetworks(rows); n[0].SSID != "Dual" || n[0].Signal != -50 || n[0].bands != bit24|bit5 {
		t.Fatalf("best %+v", n)
	}
	for list, want := range map[string]bool{freqList(freqs24): true, "2412": true, "": false, "2412 5180": false, "0": false} {
		if only24(list) != want {
			t.Errorf("only24(%q)", list)
		}
	}
	// wpa.conf keeps the band
	s := newCarSupplicant("wlan0", filepath.Join(t.TempDir(), "wifi", "wpa.conf"), "/run/x")
	in := []savedNet{{ssid: "Dual", psk: "duallpass", priority: 3, band24: true}, {ssid: "Five", psk: "fivepass1", priority: 2}}
	if err := s.writeSaved(in); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(s.conf)
	if !strings.Contains(string(b), "\tfreq_list="+freqList(freqs24)+"\n\tscan_freq="+freqList(freqs24)+"\n") {
		t.Fatalf("wpa.conf:\n%s", b)
	}
	if got, err := s.readSaved(); err != nil || !reflect.DeepEqual(got, in) {
		t.Fatalf("read back %+v %v", got, err)
	}
	if l := s.limited(); !reflect.DeepEqual(l, map[string]bool{"Dual": true, "Five": false}) {
		t.Fatalf("limited %v", l)
	}
}

// The settings file and the request keep Allow 5 GHz.
func TestAllow5Setting(t *testing.T) {
	dir := t.TempDir()
	conf, settings := filepath.Join(dir, "u.conf"), filepath.Join(dir, "settings.conf")
	writeFile(t, conf, "uplink = auto\nwifi_5ghz = off\nsettings_conf = "+settings+"\n")
	c, err := loadConfig(conf)
	if err != nil || c.WiFi5 {
		t.Fatalf("shipped: %v %v", c.WiFi5, err)
	}
	if err := setSetting(settings, "wifi_5ghz", "on"); err != nil {
		t.Fatal(err)
	}
	if c, err = loadConfig(conf); err != nil || !c.WiFi5 || len(c.Skipped) != 0 {
		t.Fatalf("set: %v %v %v", c.WiFi5, c.Skipped, err)
	}
	writeFile(t, settings, "wifi_5ghz = maybe\n")
	if c, err = loadConfig(conf); err != nil || c.WiFi5 || len(c.Skipped) != 1 {
		t.Fatalf("bad value: %v %v %v", c.WiFi5, c.Skipped, err)
	}
}

// netProp is our network's property for ssid in the car's supplicant.
func (f *fakeCar) netProp(ssid, key string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range f.nets {
		if n["ssid"] == hex.EncodeToString([]byte(ssid)) {
			return n[key], true
		}
	}
	return "", false
}

// bandCar is the car's provider with a dual-band network (its 2.4 GHz
// access point weaker) and an iPhone's hotspot on 5 GHz only.
func bandCar(t *testing.T, dual24psk string) (*wifiProvider, config, *fakeCar) {
	p, c, f := carProvider(t)
	f.do(func() {
		f.bss = []fakeBSS{{"Dual", -60, dual24psk, 2462}, {"Dual", -45, "duallpass", 5745}, {"Robert’s iPhone", -40, "rightpass1", 5745}}
	})
	return p, c, f
}

// Allow 5 GHz off: a network seen on 2.4 GHz is joined there only and
// saved so; one on 5 GHz only is joined there and said so; Allow 5 GHz on
// takes the band off a saved network not joined, and off again puts it
// back.
func TestCarWiFiBand(t *testing.T) {
	p, c, f := bandCar(t, "duallpass")
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "idle", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 2 && !st.Allow5 })

	if err := p.connect("Dual", "duallpass"); err != nil {
		t.Fatal(err)
	}
	st := waitWiFi(t, p, "joined Dual on 2.4 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Dual" })
	if st.Freq != 2462 || st.FiveOnly {
		t.Fatalf("joined: %+v", st)
	}
	if v, _ := f.netProp("Dual", "freq_list"); v != freqList(freqs24) {
		t.Fatalf("Dual's freq_list %q", v)
	}
	if b, _ := os.ReadFile(c.wpaConf()); !strings.Contains(string(b), "freq_list=2412 ") {
		t.Fatalf("wpa.conf:\n%s", b)
	}

	if err := p.connect("Robert’s iPhone", "rightpass1"); err != nil {
		t.Fatal(err)
	}
	st = waitWiFi(t, p, "joined the iPhone on 5 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Robert’s iPhone" })
	if st.Freq != 5745 || !st.FiveOnly {
		t.Fatalf("5 GHz only: %+v", st)
	}
	if v, _ := f.netProp("Robert’s iPhone", "freq_list"); v != "" {
		t.Fatalf("the iPhone's freq_list %q", v)
	}

	// Allow 5 GHz: Dual (saved, not joined) on every band; not 5 GHz only any more
	p.setAllow5(true)
	waitWiFi(t, p, "Dual on every band", func(st wifiStatus) bool {
		v, _ := f.netProp("Dual", "freq_list")
		return st.Allow5 && !st.FiveOnly && v == "" && !p.car.limited()["Dual"]
	})
	p.setAllow5(false)
	waitWiFi(t, p, "Dual on 2.4 GHz again", func(st wifiStatus) bool {
		v, _ := f.netProp("Dual", "freq_list")
		return !st.Allow5 && st.FiveOnly && v == freqList(freqs24) && p.car.limited()["Dual"]
	})
}

// A join on 2.4 GHz that does not join (here a wrong password there) goes
// on on every band and is saved so; a car supplicant that refuses a
// freq_list costs one AddNetwork, then is not asked again.
func TestCarWiFiBandFallback(t *testing.T) {
	p, c, _ := bandCar(t, "otherpass")
	p.setEnabled(true)
	p.start()
	waitWiFi(t, p, "idle", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 2 })
	if err := p.connect("Dual", "duallpass"); err != nil {
		t.Fatal(err)
	}
	st := waitWiFi(t, p, "joined Dual on 5 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Dual" })
	if st.Freq != 5745 || st.FiveOnly || st.Error != nil {
		t.Fatalf("widened: %+v", st)
	}
	p.stop()
	if b, _ := os.ReadFile(c.wpaConf()); strings.Contains(string(b), "freq_list") {
		t.Fatalf("saved on 2.4 GHz only:\n%s", b)
	}

	p2, _, f2 := bandCar(t, "duallpass")
	f2.do(func() { f2.refuse = "freq_list" })
	p2.setEnabled(true)
	p2.start()
	defer p2.stop()
	waitWiFi(t, p2, "idle", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 2 })
	adds := f2.called("AddNetwork")
	if err := p2.connect("Dual", "duallpass"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p2, "joined Dual", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Dual" })
	if n := f2.called("AddNetwork") - adds; n != 2 {
		t.Fatalf("%d AddNetwork for one join", n)
	}
	adds = f2.called("AddNetwork")
	if err := p2.car.reload(); err != nil || f2.called("AddNetwork")-adds != 1 {
		t.Fatalf("asked for a freq_list again: %v", err)
	}
}

// Saved networks on 2.4 GHz only: one now on 5 GHz only joins there; one
// in range on 2.4 GHz that does not join there goes on every band; while
// one is not in range at all, a scan on every channel looks for it.
func TestCarWiFiBandSaved(t *testing.T) {
	p, c, f := carProvider(t)
	shown := wifiBandScan
	wifiBandScan = 200 * time.Millisecond
	t.Cleanup(func() { wifiBandScan = shown })
	f.do(func() { f.bss = []fakeBSS{{"Five", -50, "fivepass1", 5745}} })
	p.car.writeSaved([]savedNet{{ssid: "Five", psk: "fivepass1", priority: 5, band24: true}})
	p.setEnabled(true)
	p.start()
	st := waitWiFi(t, p, "joined on 5 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Five" })
	p.stop()
	if !st.FiveOnly || p.car.limited()["Five"] {
		t.Fatalf("5 GHz only now: %+v", st)
	}

	p, _, f = carProvider(t)
	f.do(func() { f.bss = []fakeBSS{{"Dual", -60, "otherpass", 2462}, {"Dual", -45, "duallpass", 5745}} })
	p.car.writeSaved([]savedNet{{ssid: "Dual", psk: "duallpass", priority: 5, band24: true}, {ssid: "Away", psk: "awaypass1", priority: 4, band24: true}})
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "on 2.4 GHz, not joined", func(st wifiStatus) bool { return st.Link != "connected" && f.called("Scan") > 0 })
	st = waitWiFi(t, p, "Dual on every band, joined on 5 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.Freq == 5745 })
	scans := f.called("Scan")
	if st.FiveOnly || p.car.limited()["Dual"] || !p.car.limited()["Away"] {
		t.Fatalf("after the fallback: %+v %v", st, p.car.limited())
	}
	// joined: no more band scans
	time.Sleep(4 * wifiBandScan)
	if f.called("Scan") > scans+1 {
		t.Fatalf("%d band scans while joined", f.called("Scan")-scans)
	}
	_ = c
}

// mgu-wpa: the same band on wlan1, through freq_list and scan_freq lines
// SAVE_CONFIG writes; a supplicant that refuses them joins on every band.
func TestWiFiBandMGU(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		fastWiFi(t)
		scan := filepath.Join(t.TempDir(), "scan")
		writeScan(t, scan, "aa:aa:aa:aa:aa:02\t5745\t-45\t[WPA2-PSK-CCMP][ESS]\tDual\tduallpass",
			"aa:aa:aa:aa:aa:01\t2462\t-60\t[WPA2-PSK-CCMP][ESS]\tDual\tduallpass")
		p, c, _ := testProvider(t, scan)
		if refuse {
			t.Setenv(fakeNoFreqEnv, "1")
		}
		p.setEnabled(true)
		p.start()
		waitWiFi(t, p, "idle", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 1 })
		if err := p.connect("Dual", "duallpass"); err != nil {
			t.Fatal(err)
		}
		st := waitWiFi(t, p, "joined Dual", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Dual" })
		b, _ := os.ReadFile(c.wpaConf())
		switch {
		case !refuse && (st.Freq != 2462 || !strings.Contains(string(b), "\tfreq_list="+freqList(freqs24)+"\n") || !p.mgu.limited()["Dual"]):
			t.Fatalf("on 2.4 GHz: %+v\n%s", st, b)
		case refuse && (st.Freq != 5745 || strings.Contains(string(b), "freq_list")):
			t.Fatalf("refused: %+v\n%s", st, b)
		}
		p.stop()
	}
}
