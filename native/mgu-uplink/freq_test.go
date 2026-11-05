package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// logTo sends the log (stdout) to a file for the rest of the test.
func logTo(t *testing.T) func() string {
	f, err := os.Create(filepath.Join(t.TempDir(), "log"))
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = f
	t.Cleanup(func() { os.Stdout = old })
	return func() string { b, _ := os.ReadFile(f.Name()); return string(b) }
}

func statusJSON(st wifiStatus) string {
	b, _ := json.Marshal(st)
	return string(b)
}

// The car's supplicant: the frequency joined, in status.json and the log,
// again when it changes; none while it can't be read (not reported, or a
// read that times out), with the link as it is; none while not joined.
func TestCarWiFiFreq(t *testing.T) {
	p, _, f := carProvider(t)
	log := logTo(t)
	f.do(func() { f.bss[0].freq = 5745 })
	p.car.writeSaved([]savedNet{{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 5}})
	p.start()
	defer p.stop()
	st := waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" })
	if strings.Contains(statusJSON(st), "freq") {
		t.Fatalf("off: %s", statusJSON(st))
	}
	p.setEnabled(true)
	st = waitWiFi(t, p, "joined on 5 GHz", func(st wifiStatus) bool { return st.Link == "connected" && st.Freq == 5745 })
	if !strings.Contains(statusJSON(st), `"freq":5745`) {
		t.Fatalf("status: %s", statusJSON(st))
	}
	time.Sleep(5 * wifiEvery)
	if n := strings.Count(log(), "wifi: joined \"Robert’s iPhone\" on wlanc0 at 5745 MHz (5 GHz)"); n != 1 {
		t.Fatalf("%d join lines:\n%s", n, log())
	}
	f.do(func() { f.bss[0].freq = 2462 })
	waitWiFi(t, p, "on 2.4 GHz", func(st wifiStatus) bool { return st.Freq == 2462 })
	if !strings.Contains(log(), "at 2462 MHz (2.4 GHz)") {
		t.Fatalf("no line for the new frequency:\n%s", log())
	}
	// not reported: no frequency, still connected
	f.do(func() { f.bss[0].freq = 0 })
	st = waitWiFi(t, p, "no frequency", func(st wifiStatus) bool { return st.Link == "connected" && st.Freq == 0 })
	if strings.Contains(statusJSON(st), "freq") {
		t.Fatalf("unknown frequency: %s", statusJSON(st))
	}
	// a read that times out: none, the link stays
	f.do(func() { f.bss[0].freq, f.slowGet = 5745, dbusTimeout+500*time.Millisecond })
	time.Sleep(2 * dbusTimeout)
	if st := p.status(); st.Link != "connected" || st.Freq != 0 || st.SSID != "Robert’s iPhone" {
		t.Fatalf("a read that timed out: %s", statusJSON(st))
	}
	f.do(func() { f.slowGet = 0 })
	waitWiFi(t, p, "read again", func(st wifiStatus) bool { return st.Link == "connected" && st.Freq == 5745 })
	f.do(func() {
		if len(f.autoStart) > 0 {
			t.Errorf("calls that could start the car's supplicant: %v", f.autoStart)
		}
	})
}

// wlan1 (mgu-wpa): the frequency from STATUS.
func TestWiFiFreqMGU(t *testing.T) {
	fastWiFi(t)
	scan := filepath.Join(t.TempDir(), "scan")
	writeScan(t, scan, "40:d6:3c:68:0c:b7\t2437\t-60\t[ESS]\tCafe\t", "bb:bb:bb:bb:bb:bb\t5180\t-70\t[WPA2-PSK-CCMP][ESS]\tOther\tx12345678")
	p, _, _ := testProvider(t, scan)
	log := logTo(t)
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "idle", func(st wifiStatus) bool { return st.Link == "idle" && st.Freq == 0 && len(st.Networks) == 2 })
	if err := p.connect("Cafe", ""); err != nil {
		t.Fatal(err)
	}
	st := waitWiFi(t, p, "joined", func(st wifiStatus) bool { return st.Link == "connected" && st.Freq == 2437 })
	if !strings.Contains(statusJSON(st), `"freq":2437`) {
		t.Fatalf("status: %s", statusJSON(st))
	}
	waitWiFi(t, p, "logged", func(wifiStatus) bool {
		return strings.Contains(log(), "wifi: joined \"Cafe\" on wlant0 at 2437 MHz (2.4 GHz)")
	})
}
