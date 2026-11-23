package main

// The search for the saved networks on the car's wlan0 (carwpa.go). The
// car's wpa_supplicant makes no station scans of its own while a P2P
// operation is in progress ("Delay station mode scan while P2P operation
// is in progress"), and the car keeps its P2P device busy for wireless
// CarPlay and Android Auto, so its own scans may never find a saved
// network in range. While Wi-Fi is not joined, the provider asks for the
// scans itself (the D-Bus Scan, which the supplicant runs at once) and
// selects the first saved network a scan finds (SelectNetwork), so that the
// supplicant joins it from that scan. A scan request's results (the Store's
// Wi-Fi page, switching Wi-Fi on) are looked at the same way. During
// wireless CarPlay or Android Auto the scans keep to the band the phone is
// not on: the chip runs each band on its own core.

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"time"
)

// Replaced by tests.
var (
	autoScanPoll   = 500 * time.Millisecond // a scan under way is looked at this often
	autoScanSettle = 6 * time.Second        // a scan never seen under way is over after this
	autoScanMax    = 30 * time.Second       // any scan is over after this
	autoScanSlept  = 30 * time.Second       // the wall clock moving this much more between looks: the unit slept
)

// autoScanWait is the wait before the search's scan number step (0: the
// first).
func autoScanWait(step int) time.Duration {
	if step <= 0 {
		return 0
	}
	if step > 4 {
		return 2 * time.Minute
	}
	return 10 * time.Second << (step - 1)
}

// autoScanPlan is what the search scans during a wireless session of kind
// sess ("" none) with the phone on band (2, 5; 0 not known), given the
// frequencies the saved networks were last joined on: probe, those of them
// it may scan ("" when none); full, the channels of the scan after it (nil:
// every channel). ok false: no scan may be made.
func autoScanPlan(sess string, band int, last []int) (probe, full []int, ok bool) {
	if sess != "" {
		if full = otherBand(band); full == nil {
			return nil, nil, false
		}
	}
	for _, f := range last {
		if f > 0 && (full == nil || slices.Contains(full, f)) && !slices.Contains(probe, f) {
			probe = append(probe, f)
		}
	}
	slices.Sort(probe)
	return probe, full, true
}

// autoScan is the search's state, with reqMu held.
type autoScan struct {
	step  int       // full scans since the search started
	next  time.Time // the next scan; zero: at once
	at    time.Time // the scan under way was asked for then; zero: none
	probe bool      // it covers the last channels only
	busy  bool      // the supplicant reported it under way
	key   string    // the session and band it runs for
	wall  time.Time // the wall clock at the last look
	poll  bool      // a look is due within autoScanPoll
	freqs map[string]int
	file  string // freqs, kept across a restart of the service
}

func newAutoScan(file string) autoScan {
	a := autoScan{freqs: map[string]int{}, file: file}
	if b, err := os.ReadFile(file); err == nil {
		json.Unmarshal(b, &a.freqs)
	}
	return a
}

// restart has the next look scan at once; a scan under way goes on.
func (a *autoScan) restart(key string) {
	a.step, a.next, a.key = 0, time.Time{}, key
}

// tick restarts the search when the wall clock moved on more than the
// provider's ticks did (the unit slept). Each provider tick, with reqMu
// held.
func (a *autoScan) tick() {
	wall := time.Now().Round(0)
	if !a.wall.IsZero() && wall.Sub(a.wall) > wifiEvery+autoScanSlept {
		a.restart(a.key)
	}
	a.wall = wall
}

// asked: a scan request is under way; its results are looked at as a
// search scan's.
func (a *autoScan) asked() {
	a.at, a.probe, a.busy = time.Now(), false, false
}

// joinedOn keeps the frequency ssid is joined on.
func (a *autoScan) joinedOn(ssid string, freq int) {
	if freq <= 0 || a.freqs[ssid] == freq {
		return
	}
	a.freqs[ssid] = freq
	if b, err := json.Marshal(a.freqs); err == nil {
		os.WriteFile(a.file, b, 0600)
	}
}

// search runs the search while Wi-Fi is not joined: idle, the supplicant is
// not joining or joined; h, what its own scans are held to. Reports
// whether the search may scan. With reqMu held.
func (p *wifiProvider) search(st *wifiStatus, idle bool, h scanHold) bool {
	a := &p.auto
	now := time.Now()
	key := fmt.Sprintf("%s/%d", h.session, h.band)
	if st.Link == "connected" || len(st.Saved) == 0 || key != a.key {
		a.restart(key)
	}
	if !idle || len(st.Saved) == 0 {
		a.at, a.probe = time.Time{}, false
		return false
	}
	last := make([]int, 0, len(st.Saved))
	for _, ssid := range st.Saved {
		last = append(last, a.freqs[ssid])
	}
	probe, full, ok := autoScanPlan(h.session, h.band, last)
	if !a.at.IsZero() {
		ssid, scanning := p.car.seen(now.Sub(a.at) + time.Second)
		if ssid != "" {
			a.at = time.Time{}
			p.autoJoin(ssid)
			return ok
		}
		a.busy = a.busy || scanning
		if d := now.Sub(a.at); d < autoScanMax && (scanning || !a.busy && d < autoScanSettle) {
			p.autoPoll()
			return ok
		}
		a.at = time.Time{}
		if !a.probe {
			a.step++
			a.next = now.Add(autoScanWait(a.step))
		}
	}
	// a session not known yet may be on any band
	if !ok || !a.probe && now.Before(a.next) || !p.proj.known {
		return ok
	}
	freqs := full
	// the last channels first, then (after them) the others
	a.probe = !a.probe && len(probe) > 0
	if a.probe {
		freqs = probe
	}
	if a.step == 0 && (a.probe || len(probe) == 0) {
		where := "every channel"
		if full != nil {
			where = bandName(band(full[0]))
		}
		logf("wifi: looking for the saved networks on %s (%s)", p.iface, where)
	}
	if err := p.car.scanFor(freqs, true); err != nil {
		logf("wifi: %v", err)
		a.probe = false
		a.step++
		a.next = now.Add(autoScanWait(a.step))
		return true
	}
	a.at, a.busy = now, false
	p.autoPoll()
	return true
}

// autoPoll has the provider look again within autoScanPoll. With reqMu
// held.
func (p *wifiProvider) autoPoll() {
	if p.auto.poll {
		return
	}
	p.auto.poll = true
	time.AfterFunc(autoScanPoll, func() {
		p.reqMu.Lock()
		p.auto.poll = false
		p.reqMu.Unlock()
		p.poke()
	})
}

// autoJoin selects the saved network a scan found, as a connect request
// does, without saving anything. A join that does not work is tried again
// at the search's next scan. With reqMu held.
func (p *wifiProvider) autoJoin(ssid string) {
	p.auto.step++
	p.auto.next = time.Now().Add(autoScanWait(p.auto.step))
	if err := p.car.pick(ssid); err != nil {
		logf("wifi: join %q: %v", ssid, err)
		return
	}
	p.mu.Lock()
	p.joining, p.joinNew, p.joinedAt, p.joinLimit, p.joinAuto = ssid, false, time.Now(), false, true
	p.mu.Unlock()
	logf("wifi: found %q: joining", ssid)
}
