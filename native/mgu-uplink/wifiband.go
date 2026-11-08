package main

// The band the uplink joins a network on (wifi.go). Wireless CarPlay and
// Android Auto run on the car's 5 GHz P2P group when they can, and a
// station on the same band shares the radio's core with them, so the
// uplink joins a network on 2.4 GHz only (freq_list and scan_freq of the
// 2.4 GHz channels, kept in wpa.conf) when it has been seen on 2.4 GHz.
// "Allow 5 GHz" (wifi_5ghz = on, the wifi-5ghz request) joins on every
// band. Nobody is cut off:
//
//   - a network seen on 5 GHz only is joined there (status.json's
//     wifi.fiveOnly while joined so);
//   - a join on 2.4 GHz only that has not joined after half of joinTimeout
//     goes on on every band (widen), and a network on 2.4 GHz only that is
//     in range there but not joined for joinTimeout is on every band until
//     the service restarts or Allow 5 GHz is switched;
//   - a supplicant that refuses a freq_list keeps every network on every
//     band (one retry, then not asked again);
//   - while a network on 2.4 GHz only is not in range, a scan on every
//     channel every wifiBandScan (not during a wireless session) finds it
//     on 5 GHz;
//   - a network saved before this has no freq_list: on every band until it
//     is seen on 2.4 GHz.
//
// A network's band changes only while the supplicant is not on it: on our
// wpa_supplicant a SET_NETWORK flushes the network's PMKSA, which would end
// a WPA3 association.

import (
	"strconv"
	"strings"
	"time"
)

var wifiBandScan = 2 * time.Minute // replaced by tests

const (
	bit24 = 1 << iota
	bit5
)

// bandBit is a frequency's bit24 or bit5, 0 for another.
func bandBit(freq int) int {
	switch band(freq) {
	case 2:
		return bit24
	case 5:
		return bit5
	}
	return 0
}

// bandsOf is each name's bands among rows.
func bandsOf(rows []wifiNetwork) map[string]int {
	out := map[string]int{}
	for _, r := range rows {
		if r.SSID != "" {
			out[r.SSID] |= r.bands
		}
	}
	return out
}

// only24 says whether a freq_list holds 2.4 GHz channels only.
func only24(list string) bool {
	f := strings.Fields(list)
	for _, x := range f {
		n, err := strconv.Atoi(x)
		if err != nil || band(n) != 2 {
			return false
		}
	}
	return len(f) > 0
}

// limit24 says whether a join of ssid keeps to 2.4 GHz.
func (p *wifiProvider) limit24(ssid string) bool {
	p.mu.Lock()
	allow5 := p.allow5
	p.mu.Unlock()
	return !allow5 && !p.dropped[ssid] && p.bands[ssid]&bit24 != 0
}

// reviewBands puts each saved network on 2.4 GHz only or on every band as
// the latest scan finds it, while no join runs. held: the supplicant's own
// scans are off (scanHold). With reqMu held.
func (p *wifiProvider) reviewBands(st *wifiStatus, ws map[string]string, sess projSession, held bool) {
	p.mu.Lock()
	allow5, reset := p.allow5, p.bandReset
	p.bandReset = false
	p.mu.Unlock()
	if reset {
		clear(p.dropped)
	}
	now := time.Now()
	on := st.Link == "connected" || st.Link == "connecting"
	cur := unescape(ws["ssid"])
	var stuck []string
	lost := false
	for ssid, was := range p.wpa.limited() {
		b := p.bands[ssid]
		want := was
		switch {
		case allow5 || p.dropped[ssid]:
			want = false
		case b&bit24 != 0:
			want = true
		case b&bit5 != 0:
			want = false // on 5 GHz only
		}
		if want && b&bit24 != 0 {
			stuck = append(stuck, ssid)
		}
		lost = lost || want && b == 0
		if want == was || on && ssid == cur {
			continue
		}
		now24, err := p.wpa.limit(ssid, want)
		if err != nil {
			logf("wifi: %q: %v", ssid, err)
			continue
		}
		if now24 == was {
			continue
		}
		if now24 {
			logf("wifi: %q on 2.4 GHz only", ssid)
		} else {
			logf("wifi: %q on every band", ssid)
		}
	}
	searching := !on && !held
	switch {
	case !searching || len(stuck) == 0:
		p.stuckSince = time.Time{}
	case p.stuckSince.IsZero():
		p.stuckSince = now
	case now.Sub(p.stuckSince) > joinTimeout:
		for _, ssid := range stuck {
			logf("wifi: %q in range on 2.4 GHz but not joined in %s: on every band", ssid, humanDuration(joinTimeout))
			p.dropped[ssid] = true
		}
		p.stuckSince = time.Time{}
	}
	if searching && lost && sess.kind == "" && now.After(p.bandScanAt) {
		p.bandScanAt = now.Add(wifiBandScan)
		if err := p.wpa.scan(); err != nil {
			logf("wifi: %v", err)
		}
	}
}

// fiveOnly: joined on 5 GHz, with Allow 5 GHz off, to a network not seen on
// 2.4 GHz.
func (p *wifiProvider) fiveOnly(st *wifiStatus) bool {
	p.mu.Lock()
	allow5 := p.allow5
	p.mu.Unlock()
	return !allow5 && band(st.Freq) == 5 && p.bands[st.SSID]&bit24 == 0
}

// setAllow5 lets joins use 5 GHz too, or not; either ends what failed joins
// on 2.4 GHz set.
func (p *wifiProvider) setAllow5(on bool) {
	p.mu.Lock()
	changed := p.allow5 != on
	p.allow5, p.bandReset = on, true
	p.mu.Unlock()
	if changed {
		logf("wifi: 5 GHz %s", map[bool]string{true: "allowed", false: "only for networks without 2.4 GHz"}[on])
	}
	p.poke()
}
