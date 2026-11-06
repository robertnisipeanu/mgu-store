package main

// The Wi-Fi provider: the unit on a phone's hotspot or another access
// point, through its own radio. The provider only associates: our
// wpa_supplicant (wpa.go) joins the saved networks on the Wi-Fi interface,
// and while it is joined the uplink scan (scan.go) opens the interface like
// any other device. DHCP, routing, uid rules, firewall and the lease are the
// shared ones (session.go).
//
// On iDrive 8 the radio is the NXP 88W9098's second adapter, wlan1 (phy1):
// the first adapter's wlan0 never sends an association request. The stock
// driver (moal, host_mlme=1) reports the association as a connect event,
// which upstream wpa_supplicant ignores in SME mode; our build takes it
// (wpa/wpa-mgu-sme-connect.patch). A radio that comes rfkill soft-blocked
// is unblocked when the provider takes the interface, and left unblocked:
// the stock system shares the radio. connman on the unit manages only the
// CarPlay interfaces (connmand -i wfd0,p2p-wfd0-0,p2p-wfd0-1), so the
// interface keeps its name. An iPhone's hotspot is seen with Maximise
// Compatibility on (2.4 GHz).
//
// Without wlan1, an idle Broadcom wlan0 joins through the car's own
// wpa_supplicant instead (carwpa.go); everything else is the same.
//
// Wi-Fi is off until switched on (wifi = on, or a wifi-enable request);
// off means only that the uplink does not use Wi-Fi: the radio and the
// interface are left as they are. An interface the stock system uses
// (stockUse) is not taken (link "unavailable").

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/vishvananda/netlink"
)

const (
	wifiIfname = "wlan1"
	kindWiFi   = "wifi"
)

// Replaced by tests.
var (
	wifiEvery      = 2 * time.Second  // the provider looks at the supplicant this often
	joinTimeout    = 40 * time.Second // a connect request that has not joined by then failed
	scanShown      = 8 * time.Second  // a scan request shows "scanning" this long
	wifiDropAfter  = 6 * time.Second  // a link ends once the network is gone this long
	wifiRecheck    = 10 * time.Second // an interface the stock system uses is looked at again after this
	wifiOwnRecheck = 20 * time.Second // while the provider has the interface, the stock system's use is looked at this often
	wifiRetry      = 30 * time.Second // after a failure to take the interface or run the supplicant; doubles each time
	wifiStable     = 2 * time.Minute  // a supplicant running this long ends a run of failures
	wifiRetake     = 60 * time.Second // after giving the interface back, not taken again before this; doubles each time
	wifiRetakeMax  = 8 * time.Minute
	wifiHeld       = 10 * time.Minute // holding the interface this long ends a run of give-backs
)

// wifiMaxFails failures in a row stop the provider (link "failed") until
// Wi-Fi is switched on again or the service restarts.
const wifiMaxFails = 5

type wifiNetwork struct {
	SSID    string `json:"ssid"`
	Signal  int    `json:"signal"` // dBm
	Secure  bool   `json:"secure"`
	Saved   bool   `json:"saved"`
	Current bool   `json:"current"`
	bands   int    // bandBit of its access points in the scan
}

// wifiStatus is status.json's "wifi" (devstatus.go). link: off,
// unavailable (no radio, or the stock system uses it), failed, idle,
// scanning, connecting, connected (joined; the uplink uses another device
// or waits for DHCP), online (the uplink has a lease through it).
type wifiStatus struct {
	Enabled  bool          `json:"enabled"`
	Link     string        `json:"link"`
	SSID     string        `json:"ssid,omitempty"`
	IP       string        `json:"ip,omitempty"`
	Signal   *int          `json:"signal,omitempty"`
	Networks []wifiNetwork `json:"networks"`
	Saved    []string      `json:"saved"`
	Scanning bool          `json:"scanning"`
	Error    *string       `json:"error"`
	Backend  string        `json:"backend,omitempty"`  // mgu-wpa, car-supplicant: what joins
	Paused   string        `json:"paused,omitempty"`   // carplay, android-auto: no automatic scans during that wireless session
	Freq     int           `json:"freq,omitempty"`     // MHz of the access point joined, while it can be read
	Allow5   bool          `json:"allow5ghz"`          // joins use 5 GHz too (wifiband.go)
	FiveOnly bool          `json:"fiveOnly,omitempty"` // joined on 5 GHz to a network not seen on 2.4 GHz, 5 GHz not allowed
}

// wifiRecord is what the provider changed on the interface, kept in the
// run dir so that a start after a killed run puts it back (restoreWiFi).
type wifiRecord struct {
	Link      linkState `json:"link"`
	GivenBack bool      `json:"givenBack"` // the car has the interface; its IPv6 setting is back
}

// wifiBackend joins networks on the interface: our wpa_supplicant
// (supplicant, wpa.go) or the car's (carSupplicant, carwpa.go).
type wifiBackend interface {
	name() string
	ensure(proc string) error
	stop()
	isRunning() bool
	ready() bool // requests can be served
	upFor() time.Duration
	takeSetAside() bool
	status() map[string]string // wpa_state; ssid when joining or joined
	signal() (int, bool)
	scan() error
	saved() map[string]int
	networks() ([]wifiNetwork, []string, map[string]int) // and each name's bands (bit24, bit5) in the scan
	join(ssid, psk string, open, limit24 bool) error
	widen() error                             // the join under way on every band
	limited() map[string]bool                 // the saved networks on 2.4 GHz only
	limit(ssid string, on bool) (bool, error) // a saved network on 2.4 GHz only or on every band; true: on 2.4 GHz only
	joined() error
	reload() error
	forget(ssid string) error
	hold(h scanHold) bool // limits the supplicant's own scans; true: none
	freq() int            // MHz of the access point joined, 0 not known
}

// scanHold is what the provider tells the supplicant's own (automatic)
// scans: idle, it only searches (no join or association under way, no scan
// request showing), so its scans may stop; other, the uplink is online on a
// device that outranks Wi-Fi; session, a wireless CarPlay or Android Auto
// session (projection.go) is up, with the phone on band (2: 2.4 GHz, 5:
// 5 GHz, 0: not known).
type scanHold struct {
	idle    bool
	other   bool
	session string
	band    int
}

type wifiProvider struct {
	ownIf  string // our radio's interface (wlan1)
	carIf  string // the car's station interface (wlan0)
	bcmdhd string // the Broadcom driver's module folder: carIf is its station
	sys    string // /sys/class/net
	proc   string // /proc
	record string
	mgu    *supplicant
	car    *carSupplicant
	wpa    wifiBackend // the one in use, with reqMu held
	// linkUp turns IPv6 off on the interface and brings it up, and returns
	// how it was.
	linkUp func(iface string) (linkState, error)
	// notify, when set, is called once the provider takes or gives back the
	// interface (the service's firewall guards it meanwhile).
	notify func()
	// outranks says whether an uplink of kind ranks above Wi-Fi, so Wi-Fi
	// could not take over from it (scanUplink.rank); nil: any kind does.
	outranks func(kind string) bool
	// iftype reads the interface's nl80211 type; dbusHas asks a D-Bus
	// wpa_supplicant whether it has the interface.
	iftype      func(iface string) (uint32, error)
	dbusHas     func(iface string) (bool, error)
	connmanConf string
	proj        *projection
	groupFreq   func(ifname string) (int, error)
	freqs       map[string]int // the session's P2P interfaces' frequencies, read once a session (reqMu)
	sessKind    string         // the session the last tick found (reqMu)
	joinedOn    string         // the network and frequency last logged (reqMu)
	// the band joins use (wifiband.go), with reqMu held
	bands      map[string]int  // each name's bands in the latest scan
	dropped    map[string]bool // on every band after a join on 2.4 GHz did not work
	stuckSince time.Time
	bandScanAt time.Time

	wake  chan struct{}
	stopc chan struct{}
	done  chan struct{}
	reqMu sync.Mutex // one request or tick talks to the supplicant at a time

	// with reqMu held
	used      string // why the stock system uses the interface, "" free
	usedSure  bool   // used is a finding, not a check that failed
	usedAt    time.Time
	kept      string // a failed check logged while keeping the interface
	failMsg   string // the last failure to take the interface or run the supplicant
	retakeAt  time.Time
	givebacks int // give-backs in a row
	ownedAt   time.Time

	mu        sync.Mutex
	iface     string // the interface in use
	enabled   bool
	owned     bool // the radio and the interface are ours
	ownedIdx  int  // the interface's index when taken
	st        wifiStatus
	joining   string
	joinNew   bool // joining a network that was not saved
	joinLimit bool // the join keeps to 2.4 GHz
	allow5    bool // joins use 5 GHz too
	bandReset bool // setAllow5 ran: the tick ends what failed joins set
	joinedAt  time.Time
	scanUntil time.Time
	fails     int       // failures in a row to take the interface or run the supplicant
	retryAt   time.Time // not tried again before
	err       string    // a failed join, shown until the next request
	note      string    // the saved networks set aside, shown until the next join or switch
	switched  bool      // setEnabled ran: the tick ends a run of give-backs (retakeAt, givebacks: reqMu's)
	ip        string    // the uplink's lease on the interface
	other     string    // the kind of another device the uplink is online on, "" none
	link      *wifiLink
}

func newWiFiProvider(c config, bin string) *wifiProvider {
	mgu := &supplicant{bin: bin, iface: c.WiFiIf, conf: c.wpaConf(), ctrl: c.wpaCtrl(), local: c.wpaLocal()}
	car := newCarSupplicant(carIfname, c.wpaConf(), c.wpaCtrl())
	return &wifiProvider{
		ownIf: c.WiFiIf, carIf: carIfname, bcmdhd: "/sys/module/bcmdhd",
		proj: newProjection(), groupFreq: car.groupFreq, freqs: map[string]int{}, bands: map[string]int{}, dropped: map[string]bool{},
		iface: c.WiFiIf, sys: sysClassNet, proc: "/proc", record: c.wifiFile(), linkUp: wifiLinkUp,
		iftype: nl80211Iftype, dbusHas: dbusSupplicantHas, connmanConf: "/etc/connman/main.conf",
		mgu: mgu, car: car, wpa: mgu,
		wake: make(chan struct{}, 1), stopc: make(chan struct{}), done: make(chan struct{}),
		enabled: c.WiFi, allow5: c.WiFi5,
		st: wifiStatus{Enabled: c.WiFi, Allow5: c.WiFi5, Link: "off", Networks: []wifiNetwork{}, Saved: []string{}},
	}
}

// ifname is the interface in use.
func (p *wifiProvider) ifname() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.iface
}

// pick chooses the interface and backend while the provider does not hold
// one: our radio when the unit has it, else the car's idle Broadcom
// station through the car's supplicant. false: no radio. With reqMu held.
func (p *wifiProvider) pick() bool {
	iface, b := p.ownIf, wifiBackend(p.mgu)
	if !exists(filepath.Join(p.sys, p.ownIf)) {
		if !exists(filepath.Join(p.sys, p.carIf)) || !exists(p.bcmdhd) {
			return false
		}
		iface, b = p.carIf, p.car
	}
	p.mu.Lock()
	changed := p.iface != iface
	p.iface = iface
	p.mu.Unlock()
	if changed {
		p.used, p.usedAt, p.kept = "", time.Time{}, ""
		logf("wifi: %s through %s", iface, b.name())
	}
	p.wpa = b
	return true
}

func (p *wifiProvider) start() {
	st := p.status()
	setStatusWiFi(&st)
	go p.loop()
}

// stop ends the provider and puts the interface back.
func (p *wifiProvider) stop() {
	close(p.stopc)
	<-p.done
	p.reqMu.Lock()
	p.release(errors.New("Wi-Fi stopped"), false)
	p.reqMu.Unlock()
}

func (p *wifiProvider) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *wifiProvider) loop() {
	defer close(p.done)
	t := time.NewTicker(wifiEvery)
	defer t.Stop()
	for {
		p.tick()
		select {
		case <-p.stopc:
			return
		case <-p.wake:
		case <-t.C:
		}
	}
}

func (p *wifiProvider) tick() {
	p.reqMu.Lock()
	defer p.reqMu.Unlock()
	// a bad reply never ends the uplink
	defer func() {
		if r := recover(); r != nil {
			logf("wifi: %v", r)
		}
	}()
	p.mu.Lock()
	st := wifiStatus{Enabled: p.enabled, Allow5: p.allow5, Networks: []wifiNetwork{}, Saved: []string{}}
	p.mu.Unlock()
	switch {
	case !st.Enabled:
		p.release(errors.New("Wi-Fi switched off"), false)
		st.Link = "off"
	case !p.guarding() && !p.pick():
		p.unavailable(&st, fmt.Sprintf("no Wi-Fi radio (%s)", p.ownIf))
	case !exists(filepath.Join(p.sys, p.iface)):
		p.release(fmt.Errorf("%s is gone", p.iface), false)
		p.unavailable(&st, fmt.Sprintf("no Wi-Fi radio (%s)", p.iface))
	default:
		st.Backend = p.wpa.name()
		p.up(&st)
	}
	p.publish(st)
}

func (p *wifiProvider) unavailable(st *wifiStatus, why string) {
	st.Link, st.Error = "unavailable", &why
}

func (p *wifiProvider) up(st *wifiStatus) {
	p.mu.Lock()
	owned, fails, retryAt, switched := p.owned, p.fails, p.retryAt, p.switched
	p.switched = false
	p.mu.Unlock()
	if switched {
		p.retakeAt, p.givebacks = time.Time{}, 0
	}
	// failed, or waiting to try again: nothing is looked at until the next try
	if fails >= wifiMaxFails || fails > 0 && time.Now().Before(retryAt) {
		msg := p.failMsg
		st.Link, st.Error = "failed", &msg
		return
	}
	if !owned && time.Now().Before(p.retakeAt) {
		p.unavailable(st, p.used)
		return
	}
	switch why, sure := p.stockUse(owned); {
	case why == "":
		p.kept = ""
	case owned && !sure:
		// a check that failed is no reason to give the interface back
		if p.kept != why {
			logf("wifi: keeping %s: %s", p.iface, why)
			p.kept = why
		}
	case owned:
		p.giveBack(why)
		p.unavailable(st, why)
		return
	default:
		p.unavailable(st, why)
		return
	}
	err := p.own()
	if err == nil {
		err = p.wpa.ensure(p.proc)
	}
	if p.wpa.takeSetAside() {
		p.mu.Lock()
		p.note = "the saved networks could not be read and were set aside (wpa.conf.bad)"
		p.mu.Unlock()
	}
	if err != nil {
		p.failed(st, err)
		return
	}
	if fails > 0 && p.wpa.upFor() >= wifiStable {
		p.mu.Lock()
		p.fails = 0
		p.mu.Unlock()
	}
	ws := p.wpa.status()
	if why := p.lost(ws); why != "" {
		// the car's Wi-Fi switched off is the car's use of wlan0
		if use, sure := p.carUseNow(); use != "" && sure {
			p.giveBack(use)
			p.unavailable(st, use)
			return
		}
		// the car blocked the radio (connman blocks every WLAN rfkill when
		// its Wi-Fi is switched off) or reloaded the driver (suspend): the
		// supplicant can't scan until the interface is taken again
		logf("wifi: taking %s again: %s", p.iface, why)
		stable := p.wpa.upFor() >= wifiStable
		p.release(errors.New(why), false)
		if !stable {
			p.failed(st, errors.New(why))
		}
		return
	}
	st.Networks, st.Saved, p.bands = p.wpa.networks()
	switch ws["wpa_state"] {
	case "COMPLETED":
		st.Link = "connected"
	case "AUTHENTICATING", "ASSOCIATING", "ASSOCIATED", "4WAY_HANDSHAKE", "GROUP_HANDSHAKE":
		st.Link = "connecting"
	case "SCANNING":
		st.Link = "scanning"
	default:
		st.Link = "idle"
	}
	if st.Link == "connected" || st.Link == "connecting" {
		st.SSID = unescape(ws["ssid"])
	}
	now := time.Now()
	p.mu.Lock()
	st.Scanning = now.Before(p.scanUntil)
	joining, joinNew, joinedAt, joinLimit := p.joining, p.joinNew, p.joinedAt, p.joinLimit
	p.mu.Unlock()
	if joining != "" {
		switch {
		case st.Link == "connected" && st.SSID == joining:
			if err := p.wpa.joined(); err != nil {
				logf("wifi: save %q: %v", joining, err)
			}
			logf("wifi: joined %q", joining)
			joining = ""
		case joinLimit && now.Sub(joinedAt) > joinTimeout/2:
			// not joined on 2.4 GHz: the same network on every band, for a whole joinTimeout
			logf("wifi: %q not joined on 2.4 GHz: trying every band", joining)
			if err := p.wpa.widen(); err != nil {
				logf("wifi: %v", err)
			}
			p.dropped[joining] = true
			p.mu.Lock()
			p.joinLimit, p.joinedAt = false, now
			p.mu.Unlock()
			st.Link, st.SSID = "connecting", joining
		case now.Sub(joinedAt) > joinTimeout:
			p.wpa.reload()
			p.mu.Lock()
			p.err = fmt.Sprintf("could not join %s (wrong password, or out of range)", joining)
			p.mu.Unlock()
			logf("wifi: could not join %q", joining)
			joining = ""
		default:
			if st.Link != "connected" {
				st.Link, st.SSID = "connecting", joining
			}
			if joinNew {
				st.Saved = without(st.Saved, joining)
			}
		}
		p.mu.Lock()
		if joining == "" {
			p.joining = ""
		}
		p.mu.Unlock()
	}
	// The supplicant's station scans take the shared radio off the channel
	// of wireless CarPlay and Android Auto. While the uplink is online on a
	// device Wi-Fi can't take over from, and during a wireless session, the
	// supplicant's own scans stop or keep to the band the phone is not on
	// (scanHold); they go on as usual as soon as neither is so, for a scan
	// request, and never under a join the owner asked for.
	sess := p.session()
	if joining == "" {
		p.mu.Lock()
		other := p.other
		p.mu.Unlock()
		idle := ws["wpa_state"] == "SCANNING" || ws["wpa_state"] == "INACTIVE" || ws["wpa_state"] == "DISCONNECTED"
		h := scanHold{idle: idle && !st.Scanning, other: other != "" && (p.outranks == nil || p.outranks(other)), session: sess.kind}
		if h.session != "" && p.wpa == wifiBackend(p.car) {
			h.band = p.phoneBand(sess)
		}
		held := p.wpa.hold(h)
		if held && h.session != "" {
			st.Paused = h.session
		}
		p.reviewBands(st, ws, sess, held)
	}
	for i := range st.Networks {
		st.Networks[i].Saved = slices.Contains(st.Saved, st.Networks[i].SSID)
		st.Networks[i].Current = st.Link == "connected" && st.Networks[i].SSID == st.SSID
	}
	if st.Link == "connected" {
		if sig, ok := p.wpa.signal(); ok {
			st.Signal = &sig
		}
		st.Freq = p.wpa.freq()
		st.FiveOnly = p.fiveOnly(st)
	}
	p.logBand(st)
}

// logBand logs the frequency and band of the access point joined, when
// the network or its frequency changes. With reqMu held.
func (p *wifiProvider) logBand(st *wifiStatus) {
	on := ""
	if st.Link == "connected" && st.Freq > 0 {
		on = fmt.Sprintf("%q on %s at %d MHz", st.SSID, p.iface, st.Freq)
		if b := band(st.Freq); b != 0 {
			on += " (" + bandName(b) + ")"
		}
	}
	if on != p.joinedOn && on != "" {
		logf("wifi: joined %s", on)
	}
	p.joinedOn = on
}

// session is the wireless CarPlay or Android Auto session now, logged as
// it starts and ends. With reqMu held.
func (p *wifiProvider) session() projSession {
	s := p.proj.look(p.proc, time.Now())
	if s.kind != p.sessKind {
		if s.kind != "" {
			logf("wifi: wireless %s on %v", projectionName(s.kind), s.ifaces)
		} else {
			logf("wifi: wireless %s ended", projectionName(p.sessKind))
		}
		p.sessKind = s.kind
	}
	if s.kind == "" {
		clear(p.freqs)
	}
	return s
}

// phoneBand is the band of the P2P groups the phone is on (2 or 5), 0 when
// they are on both or a frequency can't be read. Each group's frequency is
// read once a session. With reqMu held.
func (p *wifiProvider) phoneBand(s projSession) int {
	b := 0
	for _, ifname := range s.ifaces {
		f, ok := p.freqs[ifname]
		if !ok {
			var err error
			if f, err = p.groupFreq(ifname); err != nil {
				logf("wifi: the frequency of %s: %v", ifname, err)
			} else {
				logf("wifi: %s on %d MHz", ifname, f)
			}
			p.freqs[ifname] = f
		}
		switch g := band(f); {
		case g == 0, b != 0 && g != b:
			return 0
		default:
			b = g
		}
	}
	return b
}

// lost says why the interface the provider took is no longer as it took it
// ("" when it is): the supplicant finds it disabled (rfkill blocked, or set
// down), or it is another interface of the same name (the driver reloaded).
func (p *wifiProvider) lost(ws map[string]string) string {
	if ws["wpa_state"] == "INTERFACE_DISABLED" {
		return fmt.Sprintf("%s is down or its radio is blocked", p.iface)
	}
	p.mu.Lock()
	idx := p.ownedIdx
	p.mu.Unlock()
	if v, err := readSysctl(filepath.Join(p.sys, p.iface, "ifindex")); err == nil && idx > 0 && v != strconv.Itoa(idx) {
		return fmt.Sprintf("%s was created again", p.iface)
	}
	return ""
}

// failed counts a failure to take the interface or run the supplicant and
// sets the time of the next try, doubling the wait each time; the last one
// gives the interface back for good (until setEnabled).
func (p *wifiProvider) failed(st *wifiStatus, err error) {
	p.mu.Lock()
	p.fails++
	fails := p.fails
	wait := wifiRetry << (fails - 1)
	p.retryAt = time.Now().Add(wait)
	p.mu.Unlock()
	msg := err.Error()
	if fails >= wifiMaxFails {
		p.release(err, false)
		logf("wifi: %d failures in a row; not trying again until Wi-Fi is switched on again", fails)
	} else {
		msg += fmt.Sprintf(" (trying again in %s)", humanDuration(wait))
	}
	p.failMsg = msg
	st.Link, st.Error = "failed", &msg
}

// humanDuration: "30 s", "2 min".
func humanDuration(d time.Duration) string {
	switch {
	case d >= time.Minute:
		return fmt.Sprintf("%d min", int(d.Round(time.Minute)/time.Minute))
	case d >= time.Second:
		return fmt.Sprintf("%d s", int(d.Round(time.Second)/time.Second))
	}
	return fmt.Sprintf("%d ms", d.Milliseconds())
}

// stockUse says why the stock system uses the interface ("" when it does
// not): an access point, P2P or any mode but station, hostapd on it,
// another wpa_supplicant on it or a D-Bus one that has it, connman
// managing it. sure: a finding; else a check failed. While it uses it, it
// is looked at again every wifiRecheck; while the provider has the
// interface, every wifiOwnRecheck.
func (p *wifiProvider) stockUse(owned bool) (string, bool) {
	every := wifiRecheck
	if owned && p.used == "" {
		every = wifiOwnRecheck
	}
	if (p.used != "" || owned) && !p.usedAt.IsZero() && time.Since(p.usedAt) < every {
		return p.used, p.usedSure
	}
	p.used, p.usedSure = p.findStockUse()
	p.usedAt = time.Now()
	return p.used, p.usedSure
}

func (p *wifiProvider) findStockUse() (string, bool) {
	if t, err := p.iftype(p.iface); err != nil {
		return fmt.Sprintf("can't read %s's mode: %v", p.iface, err), false
	} else if t != nl80211Station {
		return fmt.Sprintf("%s is in %s mode", p.iface, iftypeName(t)), true
	}
	u := stockUsers(p.proc, p.iface, p.mgu.conf, p.connmanConf)
	if u.why != "" {
		return u.why, true
	}
	if p.wpa == wifiBackend(p.car) {
		// the car's supplicant has the interface and connman manages it:
		// they are what the provider joins through
		return p.car.carUse()
	}
	if u.connman != "" {
		return u.connman, true
	}
	if u.dbus {
		has, err := p.dbusHas(p.iface)
		switch {
		case err != nil:
			return fmt.Sprintf("can't ask the D-Bus wpa_supplicant about %s: %v", p.iface, err), false
		case has:
			return fmt.Sprintf("the D-Bus wpa_supplicant has %s", p.iface), true
		}
	}
	return "", true
}

// carUseNow asks the car's supplicant, with the car-supplicant backend in
// use, whether the car uses the interface, and keeps the answer as
// stockUse's.
func (p *wifiProvider) carUseNow() (string, bool) {
	if p.wpa != wifiBackend(p.car) {
		return "", false
	}
	p.used, p.usedSure = p.car.carUse()
	p.usedAt = time.Now()
	return p.used, p.usedSure
}

// giveBack hands the interface to the car (release) and keeps it from
// being taken again for wifiRetake, doubling with each give-back in a row
// (up to wifiRetakeMax), so a car that keeps taking it is not fought.
func (p *wifiProvider) giveBack(why string) {
	logf("wifi: giving %s back: %s", p.iface, why)
	if time.Since(p.ownedAt) >= wifiHeld {
		p.givebacks = 0
	}
	p.givebacks++
	wait := wifiRetakeMax
	if p.givebacks <= 16 && wifiRetake<<(p.givebacks-1) < wait {
		wait = wifiRetake << (p.givebacks - 1)
	}
	p.retakeAt = time.Now().Add(wait)
	p.release(errors.New(why), true)
}

// publish keeps st, with the lease and a failed join, and writes it to
// status.json when it changed.
func (p *wifiProvider) publish(st wifiStatus) {
	p.mu.Lock()
	if st.Link == "connected" && p.ip != "" {
		st.Link, st.IP = "online", p.ip
	}
	if st.Error == nil && p.err != "" && st.Enabled {
		msg := p.err
		st.Error = &msg
	}
	if st.Error == nil && p.note != "" && st.Enabled {
		msg := p.note
		st.Error = &msg
	}
	old := p.st
	p.st = st
	p.mu.Unlock()
	if reflect.DeepEqual(old, st) {
		return
	}
	if old.Link != st.Link || old.SSID != st.SSID {
		logf("wifi: %s %s", st.Link, st.SSID)
	}
	if st.Error != nil && (old.Error == nil || *old.Error != *st.Error) {
		logf("wifi: %s", *st.Error)
	}
	setStatusWiFi(&st)
}

func (p *wifiProvider) status() wifiStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.st
}

// own unblocks the interface's radio when it is soft-blocked (and leaves
// it so), turns IPv6 off on the interface (a router advertisement must not
// give the whole unit a route) and brings it up, recording how the
// interface was.
func (p *wifiProvider) own() error {
	p.mu.Lock()
	owned := p.owned
	p.mu.Unlock()
	if owned {
		return nil
	}
	// the car's radio stays as the car has it (a blocked one is carUse's)
	rfkill, _ := filepath.Glob(filepath.Join(p.sys, p.iface, "phy80211", "rfkill*"))
	if p.wpa != wifiBackend(p.mgu) {
		rfkill = nil
	}
	for _, r := range rfkill {
		if v, _ := readSysctl(filepath.Join(r, "hard")); v == "1" {
			return errors.New("the radio is switched off (rfkill hard block)")
		}
		if v, _ := readSysctl(filepath.Join(r, "soft")); v == "1" {
			if err := writeSysctl(filepath.Join(r, "soft"), "0"); err != nil {
				return fmt.Errorf("unblock the radio: %v", err)
			}
			logf("wifi: unblocked %s's radio (%s)", p.iface, filepath.Base(r))
		}
	}
	ls, err := p.linkUp(p.iface)
	// taken again after a give-back: the state before the first take stays
	var prev wifiRecord
	if b, e := os.ReadFile(p.record); e == nil && json.Unmarshal(b, &prev) == nil && prev.Link.Index == ls.Index {
		ls = prev.Link
	}
	if e := writeJSON(p.record, wifiRecord{Link: ls}, 0644); err == nil {
		err = e
	}
	if err != nil {
		restoreWiFi(p.record, false)
		return err
	}
	p.mu.Lock()
	p.owned, p.ownedAt, p.ownedIdx = true, time.Now(), ls.Index
	p.mu.Unlock()
	logf("wifi: %s on", p.iface)
	if p.notify != nil {
		p.notify()
	}
	return nil
}

func wifiLinkUp(iface string) (linkState, error) {
	link, err := netlink.LinkByName(iface)
	if err != nil {
		return linkState{}, err
	}
	a := link.Attrs()
	st := linkState{Index: a.Index, Name: iface, OrigName: iface, WasUp: a.Flags&net.FlagUp != 0}
	st.IPv6, _ = readSysctl(ipv6Sysctl(iface))
	if err := disableIPv6(iface); err != nil {
		return st, err
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return st, fmt.Errorf("set %s up: %v", iface, err)
	}
	return st, nil
}

// release stops the supplicant and puts the interface back. A link on the
// interface ends first (why), and the service lets go of it (DHCP's
// release still goes out) before the interface goes down. toCar: the stock
// system has taken the interface, so only its IPv6 setting is put back and
// it stays up or down as the car has it.
func (p *wifiProvider) release(why error, toCar bool) {
	p.mu.Lock()
	owned, l := p.owned, p.link
	p.owned, p.joining, p.link = false, "", nil
	p.mu.Unlock()
	if l != nil {
		l.end(why)
		select {
		case <-l.stop:
		case <-time.After(3 * time.Second):
		}
	}
	if !owned {
		if !toCar {
			restoreWiFi(p.record, false) // given back: only the record goes
		}
		return
	}
	p.wpa.stop()
	restoreWiFi(p.record, toCar)
	logf("wifi: %s off", p.iface)
	if p.notify != nil {
		p.notify()
	}
}

// restoreWiFi puts back what a record says the provider changed on the
// interface: its IPv6 setting, and down when it was down, and removes the
// record. toCar (a give-back): only the IPv6 setting, and the record stays,
// marked, so that taking the interface again keeps the state from before
// the first take. A marked record is only removed. The radio's rfkill
// state stays.
func restoreWiFi(record string, toCar bool) {
	b, err := os.ReadFile(record)
	if err != nil {
		return
	}
	var rec wifiRecord
	switch {
	case json.Unmarshal(b, &rec) != nil || rec.Link.Index <= 0:
	case rec.GivenBack:
	case toCar:
		if rec.Link.IPv6 != "" {
			writeSysctl(ipv6Sysctl(rec.Link.OrigName), rec.Link.IPv6)
		}
		rec.GivenBack = true
		if writeJSON(record, rec, 0644) == nil {
			return
		}
	default:
		rec.Link.restore()
	}
	os.Remove(record)
}

// associated reports the network the supplicant is joined to.
func (p *wifiProvider) associated() (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.st.Link == "connected" || p.st.Link == "online" {
		return p.st.SSID, true
	}
	return "", false
}

// guarding: the provider has the interface, so the firewall guards it.
func (p *wifiProvider) guarding() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.owned
}

// setOnline records the uplink's lease address on the interface ("" none)
// and the kind of another device it is online on ("" none).
func (p *wifiProvider) setOnline(ip, other string) {
	p.mu.Lock()
	changed := p.ip != ip || p.other != other
	p.ip, p.other = ip, other
	p.mu.Unlock()
	if changed {
		p.poke()
	}
}

// ---- requests (ctl.go) ----

// setEnabled switches Wi-Fi on or off; either ends a run of failures.
func (p *wifiProvider) setEnabled(on bool) {
	p.mu.Lock()
	changed := p.enabled != on
	p.enabled, p.err, p.fails, p.retryAt, p.note, p.switched = on, "", 0, time.Time{}, "", true
	p.mu.Unlock()
	if changed {
		logf("wifi: switched %s", onOff(on))
	}
	p.poke()
}

// ready says why requests for the supplicant can't be served now.
func (p *wifiProvider) ready() error {
	p.mu.Lock()
	enabled, st := p.enabled, p.st
	p.err = ""
	p.mu.Unlock()
	switch {
	case !enabled:
		return errors.New("Wi-Fi is off")
	case (st.Link == "unavailable" || st.Link == "failed") && st.Error != nil:
		return errors.New(*st.Error)
	// running, but its control socket not there yet: a request would fail
	case !p.wpa.ready():
		return errors.New("Wi-Fi is starting")
	}
	return nil
}

func (p *wifiProvider) scan() error {
	p.reqMu.Lock()
	defer p.reqMu.Unlock()
	if err := p.ready(); err != nil {
		return err
	}
	p.mu.Lock()
	p.scanUntil = time.Now().Add(scanShown)
	p.mu.Unlock()
	defer p.poke()
	err := p.wpa.scan()
	if err == nil {
		return nil
	}
	if why := p.lost(p.wpa.status()); why != "" {
		return fmt.Errorf("%s; taking it again", why) // the next tick does
	}
	return err
}

// connect joins ssid, saving it once joined. psk empty: a saved network
// as saved, or an open one.
func (p *wifiProvider) connect(ssid, psk string) error {
	if err := checkSSID(ssid); err != nil {
		return err
	}
	if psk != "" {
		if err := checkPSK(psk); err != nil {
			return err
		}
	}
	p.reqMu.Lock()
	defer p.reqMu.Unlock()
	if err := p.ready(); err != nil {
		return err
	}
	p.mu.Lock()
	p.note = ""
	p.mu.Unlock()
	p.cancelJoin()
	open := false
	for _, n := range p.status().Networks {
		if n.SSID == ssid {
			open = !n.Secure
		}
	}
	_, had := p.wpa.saved()[ssid]
	limit := p.limit24(ssid)
	if err := p.wpa.join(ssid, psk, open, limit); err != nil {
		p.wpa.reload()
		return err
	}
	p.mu.Lock()
	p.joining, p.joinNew, p.joinedAt, p.joinLimit = ssid, !had, time.Now(), limit
	p.mu.Unlock()
	if limit {
		logf("wifi: joining %q on 2.4 GHz", ssid)
	} else {
		logf("wifi: joining %q", ssid)
	}
	p.poke()
	return nil
}

func (p *wifiProvider) forget(ssid string) error {
	if err := checkSSID(ssid); err != nil {
		return err
	}
	p.reqMu.Lock()
	defer p.reqMu.Unlock()
	if err := p.ready(); err != nil {
		return err
	}
	p.cancelJoin()
	logf("wifi: forgetting %q", ssid)
	defer p.poke()
	return p.wpa.forget(ssid)
}

// cancelJoin drops a join in progress, so that nothing it set up is saved.
func (p *wifiProvider) cancelJoin() {
	p.mu.Lock()
	joining := p.joining
	p.joining = ""
	p.mu.Unlock()
	if joining != "" {
		p.wpa.reload()
	}
}

// checkSSID: 1 to 32 bytes that wpa.conf gives back as written. SAVE_CONFIG
// writes a name of printable ASCII as ssid="<name>" (any other as hex),
// read back like a passphrase (checkPSK).
func checkSSID(s string) error {
	if s == "" || len(s) > 32 {
		return errors.New("network name: 1 to 32 bytes")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 32 || s[i] > 126 {
			return nil
		}
	}
	if hashCut(s) {
		return errors.New(`network name: a # after an odd number of " can't be saved`)
	}
	return nil
}

// hashCut: s has a '#' after an odd number of '"', where wpa_supplicant's
// wpa_config_get_line would cut "<s>".
func hashCut(s string) bool {
	quotes := 0
	for _, c := range s {
		switch {
		case c == '"':
			quotes++
		case c == '#' && quotes%2 == 1:
			return true
		}
	}
	return false
}

// checkPSK: a WPA passphrase, 8 to 63 printable ASCII characters, that
// wpa.conf gives back as written. SAVE_CONFIG writes psk="<passphrase>" as
// it is, and wpa_supplicant reads a line up to a '#' outside a pair of
// quotes (wpa_config_get_line), so a '#' after an odd number of '"' in the
// passphrase would cut it and make the file unreadable.
func checkPSK(p string) error {
	if len(p) < 8 || len(p) > 63 {
		return errors.New("password: 8 to 63 characters")
	}
	for _, c := range p {
		if c < 32 || c > 126 {
			return errors.New("password: letters, digits and symbols only")
		}
	}
	if hashCut(p) {
		return errors.New(`password: a # after an odd number of " can't be saved`)
	}
	return nil
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

func without(list []string, s string) []string {
	out := []string{}
	for _, x := range list {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

// ---- the link (scan.go opens it) ----

// wifiLink is the uplink on the Wi-Fi interface while the supplicant is
// joined to one network. It ends when Wi-Fi is switched off, the
// supplicant joins another network, or the network is gone for
// wifiDropAfter. Close leaves the association: the network stays a
// fallback.
type wifiLink struct {
	p       *wifiProvider
	iface   string
	ssid    string
	done    chan struct{}
	stop    chan struct{}
	endOnce sync.Once
	once    sync.Once
	err     error
}

func (p *wifiProvider) openLink(ssid string) *wifiLink {
	p.mu.Lock()
	l := &wifiLink{p: p, iface: p.iface, ssid: ssid, done: make(chan struct{}), stop: make(chan struct{})}
	p.link = l
	p.mu.Unlock()
	go l.watch(wifiEvery, wifiDropAfter)
	return l
}

func (l *wifiLink) end(err error) {
	l.endOnce.Do(func() {
		l.err = err
		close(l.done)
	})
}

// watch looks at the link at the interval openLink read (wifiEvery,
// wifiDropAfter), so that it never reads them itself.
func (l *wifiLink) watch(every, dropAfter time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	var lost time.Time
	for {
		select {
		case <-l.stop:
			return
		case <-l.done:
			return
		case <-t.C:
		}
		ssid, ok := l.p.associated()
		switch {
		case ok && ssid == l.ssid:
			lost = time.Time{}
		case !l.p.status().Enabled:
			l.end(errors.New("Wi-Fi switched off"))
		case ok:
			l.end(fmt.Errorf("joined %s instead", ssid))
		case lost.IsZero():
			lost = time.Now()
		case time.Since(lost) >= dropAfter:
			l.end(fmt.Errorf("%s is gone", l.ssid))
		}
	}
}

func (l *wifiLink) Ifname() string        { return l.iface }
func (l *wifiLink) Done() <-chan struct{} { return l.done }
func (l *wifiLink) Err() error            { return l.err }
func (l *wifiLink) Close()                { l.once.Do(func() { close(l.stop) }) }
func (l *wifiLink) String() string        { return fmt.Sprintf("Wi-Fi %s on %q", l.iface, l.ssid) }
func (l *wifiLink) device() statusDevice  { return statusDevice{Kind: kindWiFi, Name: l.ssid} }
