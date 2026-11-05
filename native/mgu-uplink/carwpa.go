package main

// The car-supplicant backend of the Wi-Fi provider (wifi.go). On a unit
// without wlan1 (iDrive 7 with the Broadcom BCM4359 chip, bcmdhd), the one
// radio's station interface wlan0 is idle: the car's own wpa_supplicant
// (D-Bus fi.w1.wpa_supplicant1, no config file) keeps it only as the parent
// of the P2P group owners that run the car's hotspot and wireless CarPlay,
// and the chip has no room for another interface. The provider joins
// through that supplicant on wlan0, and the group owners keep running.
//
// Our networks live only in the car's supplicant's memory (AddNetwork),
// tagged id_str="mgu-uplink", and are removed on release; a run that was
// killed has its tagged networks removed by the next start. The saved
// networks are ours, in wpa.conf as the mgu-wpa backend keeps them. A
// network of the car's on wlan0 (connman joining one, or anything else)
// means the car uses wlan0 (carUse); it and the car's other interfaces are
// never touched.

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	wpaDBus      = "fi.w1.wpa_supplicant1"
	wpaDBusPath  = objPath("/fi/w1/wpa_supplicant1")
	wpaDBusIface = wpaDBus + ".Interface"
	wpaDBusNet   = wpaDBus + ".Network"
	wpaDBusBSS   = wpaDBus + ".BSS"
	wpaDBusP2P   = wpaDBusIface + ".P2PDevice"
	wpaDBusGroup = wpaDBus + ".Group"
	carTag       = "mgu-uplink" // id_str of our networks
	carIfname    = "wlan0"

	backendMGU = "mgu-wpa"
	backendCar = "car-supplicant"
)

var dbusTimeout = 3 * time.Second // replaced by tests

// savedNet is a saved network in wpa.conf.
type savedNet struct {
	ssid     string
	psk      string // a passphrase; "" with raw or open
	raw      []byte // a 32-byte PSK
	open     bool
	priority int
}

type carSupplicant struct {
	iface string
	conf  string // the saved networks
	ctrl  string // wpa.conf's ctrl_interface, for the mgu-wpa backend

	mu       sync.Mutex
	bus      *dbusConn
	path     objPath // the interface object; "" until ensure
	at       time.Time
	ours     map[objPath]string // our networks in the car's supplicant: SSID
	pending  *savedNet          // join's network until joined or reload
	setAside bool
	quiet    bool   // our networks are off (hold)
	scanFreq string // the scan_freq our saved networks get (hold), "" none
	freqOn   map[objPath]string
	noFreq   bool // the supplicant refused a scan_freq: hold turns ours off instead
}

func newCarSupplicant(iface, conf, ctrl string) *carSupplicant {
	return &carSupplicant{iface: iface, conf: conf, ctrl: ctrl, ours: map[objPath]string{}, freqOn: map[objPath]string{}}
}

func (s *carSupplicant) name() string { return backendCar }

// call is one method call on the car's supplicant, over a connection kept
// between calls and opened again after an error. With s.mu held.
func (s *carSupplicant) call(path objPath, iface, member, sig string, args ...any) ([]any, error) {
	if s.bus == nil {
		b, err := dialBus(dbusTimeout)
		if err != nil {
			return nil, err
		}
		s.bus = b
	}
	r, err := s.bus.call(wpaDBus, path, iface, member, sig, args...)
	if err != nil && dbusErrorName(err) == "" {
		s.bus.close()
		s.bus = nil
	}
	return r, err
}

func (s *carSupplicant) getAll(path objPath, iface string) (map[string]any, error) {
	r, err := s.call(path, "org.freedesktop.DBus.Properties", "GetAll", "s", iface)
	if err != nil {
		return nil, err
	}
	if len(r) == 0 {
		return nil, errors.New("D-Bus: GetAll: no reply value")
	}
	m, ok := r[0].(map[string]any)
	if !ok {
		return nil, errors.New("D-Bus: GetAll: not a dictionary")
	}
	return m, nil
}

func prop[T any](m map[string]any, key string) (T, bool) {
	var zero T
	v, ok := m[key].(dbusVariant)
	if !ok {
		return zero, false
	}
	t, ok := v.val.(T)
	return t, ok
}

func paths(m map[string]any, key string) []objPath {
	l, _ := prop[[]any](m, key)
	var out []objPath
	for _, v := range l {
		if p, ok := v.(objPath); ok {
			out = append(out, p)
		}
	}
	return out
}

// ifacePath asks the car's supplicant for the interface's object.
func (s *carSupplicant) ifacePath() (objPath, error) {
	r, err := s.call(wpaDBusPath, wpaDBus, "GetInterface", "s", s.iface)
	if err != nil {
		return "", err
	}
	if len(r) == 0 {
		return "", errors.New("GetInterface: no reply value")
	}
	p, ok := r[0].(objPath)
	if !ok {
		return "", errors.New("GetInterface: not an object path")
	}
	return p, nil
}

// carNetwork: the interface holds a network of the car's (neither ours
// nor tagged). With s.mu held.
func (s *carSupplicant) carNetwork() (bool, error) {
	m, err := s.getAll(s.path, wpaDBusIface)
	if err != nil {
		return false, fmt.Errorf("the car's wpa_supplicant: %v", err)
	}
	for _, n := range paths(m, "Networks") {
		if _, ours := s.ours[n]; !ours && !s.tagged(n) {
			return true, nil
		}
	}
	return false, nil
}

// tagged: the network's properties carry our id_str.
func (s *carSupplicant) tagged(n objPath) bool {
	m, err := s.getAll(n, wpaDBusNet)
	if err != nil {
		return false
	}
	pm, _ := prop[map[string]any](m, "Properties")
	v, _ := pm["id_str"].(dbusVariant)
	str, _ := v.val.(string)
	return strings.Trim(str, `"`) == carTag
}

// carUse says why the car uses the interface ("" when it does not): its
// supplicant does not have it, it holds a network of the car's, or it is
// joined to one. sure: a finding; else a check failed.
func (s *carSupplicant) carUse() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.ifacePath()
	switch dbusErrorName(err) {
	case "":
		if err != nil {
			return fmt.Sprintf("can't ask the car's wpa_supplicant about %s: %v", s.iface, err), false
		}
	case wpaDBus + ".InterfaceUnknown":
		return fmt.Sprintf("the car's wpa_supplicant does not have %s", s.iface), true
	default:
		return fmt.Sprintf("can't ask the car's wpa_supplicant about %s: %v", s.iface, err), false
	}
	m, err := s.getAll(p, wpaDBusIface)
	if err != nil {
		return fmt.Sprintf("can't ask the car's wpa_supplicant about %s: %v", s.iface, err), false
	}
	if st, _ := prop[string](m, "State"); st == "interface_disabled" {
		// connman blocks the radio when the car's Wi-Fi is switched off
		return fmt.Sprintf("%s is down or its radio is blocked", s.iface), true
	}
	for _, n := range paths(m, "Networks") {
		if _, ours := s.ours[n]; !ours && !s.tagged(n) {
			return fmt.Sprintf("the car has a network of its own on %s", s.iface), true
		}
	}
	return "", true
}

// ensure finds the interface, removes our networks a killed run left in
// the car's supplicant and adds the saved ones.
func (s *carSupplicant) ensure(string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path != "" {
		return nil
	}
	p, err := s.ifacePath()
	if err != nil {
		return fmt.Errorf("the car's wpa_supplicant: %v", err)
	}
	m, err := s.getAll(p, wpaDBusIface)
	if err != nil {
		return fmt.Errorf("the car's wpa_supplicant: %v", err)
	}
	s.path, s.at, s.ours, s.freqOn, s.pending, s.noFreq = p, time.Now(), map[objPath]string{}, map[objPath]string{}, nil, false
	for _, n := range paths(m, "Networks") {
		if s.tagged(n) {
			s.call(p, wpaDBusIface, "RemoveNetwork", "o", n)
		}
	}
	if err := s.addSaved(); err != nil {
		s.dropOurs()
		s.path = ""
		return err
	}
	logf("wifi: using the car's wpa_supplicant on %s", s.iface)
	return nil
}

// addSaved adds every saved network, enabled, with the scan_freq hold
// gave, and has the supplicant look for them. With s.mu held.
func (s *carSupplicant) addSaved() error {
	nets, err := s.readSaved()
	if err != nil {
		return err
	}
	for _, n := range nets {
		if _, err := s.add(n, !s.quiet, s.scanFreq); err != nil {
			return err
		}
	}
	// Reassociate would put ours ahead of a network the car just added
	if car, err := s.carNetwork(); len(nets) > 0 && !s.quiet && !car && err == nil {
		s.call(s.path, wpaDBusIface, "Reassociate", "")
	}
	return nil
}

// add puts n into the car's supplicant, in its memory only; scanFreq: the
// channels its automatic scans keep to ("" all).
func (s *carSupplicant) add(n savedNet, enabled bool, scanFreq string) (objPath, error) {
	props := dbusProps{
		{"ssid", dbusVariant{"ay", []byte(n.ssid)}},
		{"scan_ssid", dbusVariant{"u", uint32(1)}}, // hidden and sleeping hotspots answer a directed probe
		{"priority", dbusVariant{"i", int32(n.priority)}},
		{"id_str", dbusVariant{"s", carTag}},
	}
	switch {
	case n.open:
		props = append(props, dbusProp{"key_mgmt", dbusVariant{"s", "NONE"}})
	case n.raw != nil:
		props = append(props, dbusProp{"key_mgmt", dbusVariant{"s", "WPA-PSK"}}, dbusProp{"psk", dbusVariant{"ay", n.raw}})
	default:
		props = append(props, dbusProp{"key_mgmt", dbusVariant{"s", "WPA-PSK"}}, dbusProp{"psk", dbusVariant{"s", n.psk}})
	}
	if enabled {
		props = append(props, dbusProp{"disabled", dbusVariant{"u", uint32(0)}})
	}
	if scanFreq != "" {
		props = append(props, dbusProp{"scan_freq", dbusVariant{"s", scanFreq}})
	}
	r, err := s.call(s.path, wpaDBusIface, "AddNetwork", "a{sv}", props)
	if err != nil {
		return "", fmt.Errorf("the car's wpa_supplicant: AddNetwork: %v", err)
	}
	var p objPath
	if len(r) > 0 {
		p, _ = r[0].(objPath)
	}
	if p == "" {
		return "", errors.New("the car's wpa_supplicant: AddNetwork: no network")
	}
	s.ours[p], s.freqOn[p] = n.ssid, scanFreq
	return p, nil
}

// dropOurs removes our networks from the car's supplicant. With s.mu held.
func (s *carSupplicant) dropOurs() {
	for n := range s.ours {
		s.call(s.path, wpaDBusIface, "RemoveNetwork", "o", n)
		delete(s.ours, n)
		delete(s.freqOn, n)
	}
}

// stop removes our networks and leaves a network of ours disconnected; a
// network of the car's stays as the car has it.
func (s *carSupplicant) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return
	}
	cur := objPath("")
	if m, err := s.getAll(s.path, wpaDBusIface); err == nil {
		cur, _ = prop[objPath](m, "CurrentNetwork")
	}
	_, onOurs := s.ours[cur]
	s.dropOurs()
	// a network the car added stays free to join
	if car, err := s.carNetwork(); onOurs && !car && err == nil {
		s.call(s.path, wpaDBusIface, "Disconnect", "")
	}
	s.path, s.pending, s.quiet, s.scanFreq = "", nil, false, ""
	if s.bus != nil {
		s.bus.close()
		s.bus = nil
	}
	logf("wifi: removed our networks from the car's wpa_supplicant on %s", s.iface)
}

func (s *carSupplicant) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path != ""
}

func (s *carSupplicant) ready() bool { return s.isRunning() }

func (s *carSupplicant) upFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return 0
	}
	return time.Since(s.at)
}

func (s *carSupplicant) takeSetAside() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.setAside
	s.setAside = false
	return t
}

// status is what the supplicant's STATUS gives the provider: wpa_state, and
// the network's ssid on a network of ours.
func (s *carSupplicant) status() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return map[string]string{}
	}
	m, err := s.getAll(s.path, wpaDBusIface)
	if err != nil {
		if dbusErrorName(err) == "org.freedesktop.DBus.Error.UnknownObject" ||
			dbusErrorName(err) == "org.freedesktop.DBus.Error.UnknownMethod" {
			// the car's supplicant let the interface go (driver reloaded)
			return map[string]string{"wpa_state": "INTERFACE_DISABLED"}
		}
		return map[string]string{}
	}
	st, _ := prop[string](m, "State")
	out := map[string]string{"wpa_state": strings.ToUpper(st)}
	cur, _ := prop[objPath](m, "CurrentNetwork")
	if ssid, ok := s.ours[cur]; ok {
		out["ssid"] = ssid
	}
	return out
}

func (s *carSupplicant) signal() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return 0, false
	}
	m, err := s.getAll(s.path, wpaDBusIface)
	if err != nil {
		return 0, false
	}
	bss, _ := prop[objPath](m, "CurrentBSS")
	if bss == "" || bss == "/" {
		return 0, false
	}
	bm, err := s.getAll(bss, wpaDBusBSS)
	if err != nil {
		return 0, false
	}
	sig, ok := prop[int16](bm, "Signal")
	return int(sig), ok
}

// freq is the frequency (MHz) of the access point the interface is on, 0
// none or not known: CurrentBSS, then that BSS's Frequency, each one
// property read with the call's timeout.
func (s *carSupplicant) freq() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return 0
	}
	v, err := s.getProp(s.path, wpaDBusIface, "CurrentBSS")
	bss, _ := v.(objPath)
	if err != nil || bss == "" || bss == "/" {
		return 0
	}
	v, err = s.getProp(bss, wpaDBusBSS, "Frequency")
	f, _ := v.(uint16)
	if err != nil {
		return 0
	}
	return int(f)
}

func (s *carSupplicant) scan() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return errors.New("the car's wpa_supplicant: not in use")
	}
	_, err := s.call(s.path, wpaDBusIface, "Scan", "a{sv}", dbusProps{{"Type", dbusVariant{"s", "active"}}})
	// rejected: it is scanning anyway
	if err != nil && dbusErrorName(err) != wpaDBusIface+".ScanError" {
		return fmt.Errorf("scan: %v", err)
	}
	return nil
}

// saved maps the saved names to their place in wpa.conf.
func (s *carSupplicant) saved() map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	nets, _ := s.readSaved()
	m := map[string]int{}
	for i, n := range nets {
		m[n.ssid] = i
	}
	return m
}

// networks is the supplicant's newest scan, marked with the saved
// networks, and the saved names.
func (s *carSupplicant) networks() ([]wifiNetwork, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	saved, _ := s.readSaved()
	names := make([]string, 0, len(saved))
	have := map[string]bool{}
	for _, n := range saved {
		names = append(names, n.ssid)
		have[n.ssid] = true
	}
	sort.Strings(names)
	var rows []wifiNetwork
	if s.path != "" {
		if m, err := s.getAll(s.path, wpaDBusIface); err == nil {
			for _, b := range paths(m, "BSSs") {
				bm, err := s.getAll(b, wpaDBusBSS)
				if err != nil {
					continue
				}
				ssid, _ := prop[[]byte](bm, "SSID")
				sig, _ := prop[int16](bm, "Signal")
				privacy, _ := prop[bool](bm, "Privacy")
				rows = append(rows, wifiNetwork{SSID: string(ssid), Signal: int(sig), Secure: privacy})
			}
		}
	}
	nets := bestNetworks(rows)
	for i := range nets {
		nets[i].Saved = have[nets[i].SSID]
	}
	return nets, names
}

// join adds the network with the password given (or as saved, or open)
// and selects it, which keeps the other networks off until joined or
// reloaded. A network of ours for the same name goes first, so that only
// an association with this password reaches COMPLETED. Nothing is saved
// yet: joined saves, reload drops it.
func (s *carSupplicant) join(ssid, psk string, open bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return errors.New("the car's wpa_supplicant: not in use")
	}
	// SelectNetwork would switch off a network the car just added
	if car, err := s.carNetwork(); err != nil || car {
		if err != nil {
			return err
		}
		return fmt.Errorf("the car has a network of its own on %s", s.iface)
	}
	saved, err := s.readSaved()
	if err != nil {
		return err
	}
	n := savedNet{ssid: ssid, psk: psk}
	have := false
	for _, x := range saved {
		if x.ssid == ssid {
			have = true
			if psk == "" {
				n = x
			}
		}
	}
	if !have && psk == "" {
		if !open {
			return fmt.Errorf("%s needs a password", ssid)
		}
		n.open = true
	}
	// the newest choice first among the saved ones
	n.priority = int(time.Now().Unix() / 60)
	for p, name := range s.ours {
		if name == ssid {
			s.call(s.path, wpaDBusIface, "RemoveNetwork", "o", p)
			delete(s.ours, p)
			delete(s.freqOn, p)
		}
	}
	// a join the owner asked for looks on every channel
	p, err := s.add(n, false, "")
	if err != nil {
		return err
	}
	if _, err := s.call(s.path, wpaDBusIface, "SelectNetwork", "o", p); err != nil {
		return fmt.Errorf("the car's wpa_supplicant: SelectNetwork: %v", err)
	}
	s.pending = &n
	return nil
}

// joined keeps what join set up: every network of ours on again, the
// joined one saved.
func (s *carSupplicant) joined() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for p := range s.ours {
		if err := s.setEnabled(p); err != nil {
			return err
		}
	}
	s.quiet = false
	if s.pending == nil {
		return nil
	}
	n := *s.pending
	s.pending = nil
	nets, err := s.readSaved()
	if err != nil {
		return err
	}
	out := []savedNet{n}
	for _, x := range nets {
		if x.ssid != n.ssid {
			out = append(out, x)
		}
	}
	return s.writeSaved(out)
}

func (s *carSupplicant) setEnabled(p objPath) error { return s.setNetEnabled(p, true) }

func (s *carSupplicant) setNetEnabled(p objPath, on bool) error {
	_, err := s.call(p, "org.freedesktop.DBus.Properties", "Set", "ssv", wpaDBusNet, "Enabled", dbusVariant{"b", on})
	if err != nil {
		return fmt.Errorf("the car's wpa_supplicant: set a network's Enabled: %v", err)
	}
	return nil
}

// hold limits the supplicant's own scans for our networks (wifi.go,
// scanHold): their scan_freq (with every enabled network carrying one, the
// supplicant's automatic scans keep to those channels; a scan request and
// a join the owner asked for still cover them all), and off turns them off
// (with none enabled the supplicant logs "No enabled networks - do not
// scan" and goes inactive) or back on. Only ours, in the supplicant's
// memory: the car's networks and its P2P groups are other objects. A
// network of ours keeps an association while its scan_freq changes (WPA-PSK
// keeps no PMKSA for the change to flush). A supplicant that refuses a
// scan_freq has ours off instead while h.idle; one that refuses to clear it
// has that network added again, unless it is joined (then on a later
// call). Reports whether ours are off.
func (s *carSupplicant) hold(h scanHold) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return false
	}
	want := ""
	if h.session != "" && !s.noFreq {
		want = freqList(otherBand(h.band))
	}
	if want != s.scanFreq {
		s.scanFreq = want
		if want != "" {
			logf("wifi: automatic scans on %s keep to %s during wireless %s", s.iface, bandName(7-h.band), projectionName(h.session))
		} else {
			logf("wifi: automatic scans on %s on every channel", s.iface)
		}
	}
	for p := range s.ours {
		if s.freqOn[p] == s.scanFreq {
			continue
		}
		err := s.setNetProps(p, dbusProps{{"scan_freq", dbusVariant{"s", s.scanFreq}}})
		switch {
		case err == nil:
			s.freqOn[p] = s.scanFreq
			continue
		case s.scanFreq != "":
			logf("wifi: %v; no automatic scans instead during wireless %s", err, projectionName(h.session))
			s.noFreq, s.scanFreq = true, ""
		case s.onNetwork(p):
			continue // joined, or can't tell: on a later call
		default:
			logf("wifi: %v; adding the network again", err)
			s.readd(p)
		}
		break
	}
	off := h.idle && (h.other || h.session != "" && s.scanFreq == "")
	s.setOff(off)
	return s.quiet
}

// onNetwork: the interface is on network p, or the supplicant can't say.
// With s.mu held.
func (s *carSupplicant) onNetwork(p objPath) bool {
	m, err := s.getAll(s.path, wpaDBusIface)
	if err != nil {
		return true
	}
	cur, _ := prop[objPath](m, "CurrentNetwork")
	return cur == p
}

// readd removes one of our networks and adds it again from wpa.conf, as
// addSaved would. With s.mu held.
func (s *carSupplicant) readd(p objPath) {
	ssid := s.ours[p]
	s.call(s.path, wpaDBusIface, "RemoveNetwork", "o", p)
	delete(s.ours, p)
	delete(s.freqOn, p)
	nets, _ := s.readSaved()
	for _, n := range nets {
		if n.ssid == ssid {
			if _, err := s.add(n, !s.quiet, s.scanFreq); err != nil {
				logf("wifi: %v", err)
			}
		}
	}
}

func (s *carSupplicant) setNetProps(p objPath, props dbusProps) error {
	_, err := s.call(p, "org.freedesktop.DBus.Properties", "Set", "ssv", wpaDBusNet, "Properties", dbusVariant{"a{sv}", props})
	if err != nil {
		return fmt.Errorf("the car's wpa_supplicant: set a network's %s: %v", props[0].key, err)
	}
	return nil
}

// setOff turns our networks off or back on. A failed Set is tried again on
// the next call. With s.mu held.
func (s *carSupplicant) setOff(on bool) {
	if s.quiet == on || on && len(s.ours) == 0 {
		return
	}
	for p := range s.ours {
		if err := s.setNetEnabled(p, !on); err != nil {
			logf("wifi: %v", err)
			return
		}
	}
	s.quiet = on
	if on {
		logf("wifi: saved networks paused on %s: no automatic scans", s.iface)
	} else {
		logf("wifi: saved networks on again on %s", s.iface)
	}
}

// groupFreq is the frequency (MHz) of the car's P2P group on ifname, from
// the car's supplicant (read only): the group interface's Group, and its
// Frequency.
func (s *carSupplicant) groupFreq(ifname string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.call(wpaDBusPath, wpaDBus, "GetInterface", "s", ifname)
	if err != nil {
		return 0, err
	}
	var ip objPath
	if len(r) > 0 {
		ip, _ = r[0].(objPath)
	}
	if ip == "" {
		return 0, errors.New("GetInterface: not an object path")
	}
	g, err := s.getProp(ip, wpaDBusP2P, "Group")
	if err != nil {
		return 0, err
	}
	gp, _ := g.(objPath)
	if gp == "" || gp == "/" {
		return 0, fmt.Errorf("%s is in no P2P group", ifname)
	}
	f, err := s.getProp(gp, wpaDBusGroup, "Frequency")
	if err != nil {
		return 0, err
	}
	switch v := f.(type) {
	case uint16:
		return int(v), nil
	case uint32:
		return int(v), nil
	case int32:
		return int(v), nil
	}
	return 0, fmt.Errorf("%s's group: Frequency is %T", ifname, f)
}

// With s.mu held.
func (s *carSupplicant) getProp(path objPath, iface, name string) (any, error) {
	r, err := s.call(path, "org.freedesktop.DBus.Properties", "Get", "ss", iface, name)
	if err != nil {
		return nil, err
	}
	if len(r) == 0 {
		return nil, fmt.Errorf("D-Bus: Get %s: no reply value", name)
	}
	v, ok := r[0].(dbusVariant)
	if !ok {
		return nil, fmt.Errorf("D-Bus: Get %s: not a variant", name)
	}
	return v.val, nil
}

// reload drops what join set up: our networks are the saved ones again.
func (s *carSupplicant) reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = nil
	if s.path == "" {
		return nil
	}
	s.dropOurs()
	return s.addSaved()
}

func (s *carSupplicant) forget(ssid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	nets, err := s.readSaved()
	if err != nil {
		return err
	}
	var out []savedNet
	for _, n := range nets {
		if n.ssid != ssid {
			out = append(out, n)
		}
	}
	if len(out) == len(nets) {
		return fmt.Errorf("%s is not saved", ssid)
	}
	for p, name := range s.ours {
		if name == ssid {
			s.call(s.path, wpaDBusIface, "RemoveNetwork", "o", p)
			delete(s.ours, p)
			delete(s.freqOn, p)
		}
	}
	return s.writeSaved(out)
}

// ---- wpa.conf ----

// readSaved reads the saved networks, highest priority first. A file it
// can't read is set aside to wpa.conf.bad. With s.mu held.
func (s *carSupplicant) readSaved() ([]savedNet, error) {
	b, err := os.ReadFile(s.conf)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	nets, err := parseWPAConf(b)
	if err != nil {
		if os.Rename(s.conf, s.conf+".bad") == nil {
			logf("wifi: could not read %s (%v); moved to %s.bad", s.conf, err, s.conf)
			s.setAside = true
		}
		return nil, nil
	}
	return nets, nil
}

// writeSaved writes wpa.conf as wpa_supplicant's SAVE_CONFIG would, in a
// folder only root can read.
func (s *carSupplicant) writeSaved(nets []savedNet) error {
	dir := filepath.Dir(s.conf)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "ctrl_interface=%s\nupdate_config=1\nap_scan=1\n", s.ctrl)
	for _, n := range nets {
		b.WriteString("\nnetwork={\n")
		fmt.Fprintf(&b, "\tssid=%s\n\tscan_ssid=1\n", confString([]byte(n.ssid)))
		switch {
		case n.open:
			b.WriteString("\tkey_mgmt=NONE\n")
		case n.raw != nil:
			fmt.Fprintf(&b, "\tpsk=%s\n\tkey_mgmt=WPA-PSK WPA-PSK-SHA256 SAE\n\tieee80211w=1\n", hex.EncodeToString(n.raw))
		default:
			fmt.Fprintf(&b, "\tpsk=\"%s\"\n\tkey_mgmt=WPA-PSK WPA-PSK-SHA256 SAE\n\tieee80211w=1\n", n.psk)
		}
		fmt.Fprintf(&b, "\tpriority=%d\n}\n", n.priority)
	}
	tmp := s.conf + ".tmp"
	if err := os.WriteFile(tmp, b.Bytes(), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.conf)
}

// confString is a name as SAVE_CONFIG writes it: printable ASCII quoted,
// anything else in hex.
func confString(b []byte) string {
	for _, c := range b {
		if c < 32 || c > 126 {
			return hex.EncodeToString(b)
		}
	}
	return `"` + string(b) + `"`
}

// parseWPAConf reads the network blocks of a wpa.conf: a line ends at a '#'
// outside quotes (wpa_config_get_line); a quoted value is the text between
// the first and the last '"', any other a hex string.
func parseWPAConf(b []byte) ([]savedNet, error) {
	var nets []savedNet
	var cur map[string]string
	sc := bufio.NewScanner(bytes.NewReader(b))
	for line := 1; sc.Scan(); line++ {
		l := strings.TrimSpace(cutComment(sc.Text()))
		switch {
		case l == "":
		case l == "network={":
			if cur != nil {
				return nil, fmt.Errorf("line %d: network inside a network", line)
			}
			cur = map[string]string{}
		case l == "}":
			if cur == nil {
				return nil, fmt.Errorf("line %d: } outside a network", line)
			}
			n, err := savedFrom(cur)
			if err != nil {
				return nil, fmt.Errorf("line %d: %v", line, err)
			}
			nets = append(nets, n)
			cur = nil
		case cur != nil:
			k, v, ok := strings.Cut(l, "=")
			if !ok {
				return nil, fmt.Errorf("line %d: no =", line)
			}
			cur[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if cur != nil {
		return nil, errors.New("a network without }")
	}
	sort.SliceStable(nets, func(i, j int) bool { return nets[i].priority > nets[j].priority })
	return nets, sc.Err()
}

func cutComment(l string) string {
	quoted := false
	for i := 0; i < len(l); i++ {
		switch {
		case l[i] == '"':
			quoted = !quoted
		case l[i] == '#' && !quoted:
			return l[:i]
		}
	}
	return l
}

func confValue(v string) ([]byte, error) {
	if strings.HasPrefix(v, `"`) {
		end := strings.LastIndex(v, `"`)
		if end == 0 {
			return nil, errors.New("an unclosed quote")
		}
		return []byte(v[1:end]), nil
	}
	return hex.DecodeString(v)
}

func savedFrom(kv map[string]string) (savedNet, error) {
	ssid, err := confValue(kv["ssid"])
	if err != nil || len(ssid) == 0 || len(ssid) > 32 {
		return savedNet{}, errors.New("a network without a valid ssid")
	}
	n := savedNet{ssid: string(ssid)}
	n.priority, _ = strconv.Atoi(kv["priority"])
	switch psk := kv["psk"]; {
	case strings.HasPrefix(psk, `"`):
		v, err := confValue(psk)
		if err != nil {
			return savedNet{}, err
		}
		n.psk = string(v)
	case psk != "":
		raw, err := hex.DecodeString(psk)
		if err != nil || len(raw) != 32 {
			return savedNet{}, errors.New("a psk neither a passphrase nor 64 hex digits")
		}
		n.raw = raw
	case kv["key_mgmt"] == "NONE":
		n.open = true
	default:
		return savedNet{}, errors.New("a network without a psk")
	}
	return n, nil
}

// removeCarNetworks removes the networks a killed run tagged as ours from
// the car's supplicant on iface (cleanup at start and stop).
func removeCarNetworks(iface string) {
	s := newCarSupplicant(iface, "", "")
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		if s.bus != nil {
			s.bus.close()
		}
	}()
	p, err := s.ifacePath()
	if err != nil {
		return
	}
	m, err := s.getAll(p, wpaDBusIface)
	if err != nil {
		return
	}
	for _, n := range paths(m, "Networks") {
		if s.tagged(n) {
			s.call(p, wpaDBusIface, "RemoveNetwork", "o", n)
			logf("wifi: removed a network a previous run left in the car's wpa_supplicant")
		}
	}
}
