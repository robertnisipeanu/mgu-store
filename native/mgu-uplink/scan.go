package main

// The automatic uplink. scanUplink looks at what is plugged in, and whether
// Wi-Fi is joined, on USB/net uevents, Wi-Fi/config changes and periodic
// safety sweeps, and opens the first usable device of the kinds it covers,
// in this order:
//
//	wifi    the unit's own radio, joined to a saved network (wifi.go)
//	usb     an adapter the kernel drives (netdev.go)
//	usbecm  a CDC-ECM stick, a Huawei stick in CD-ROM mode switched first
//	rndis   an Android phone in RNDIS tethering (most)
//	ncm     an Android phone in NCM tethering (Pixel 6 and later)
//	iphone  an iPhone's Personal Hotspot
//
// The preferred group's kinds (config Preferred, the prefer request:
// preferGroups) go first and the others follow, each in that order. For
// the kernel-driven and CDC kinds it takes only devices no driver or
// process holds; an iPhone it takes from the media daemon itself
// (iphone.go), so it reaches and takes an iPhone only when no device it
// ranks higher is present. Once on a later kind it ends that link when an
// earlier kind's device appears, so a stick plugged in next to a phone
// takes over, and a change of the preferred group takes effect within 5 s. An unplugged device ends its link and the next scan
// finds whatever is there, so devices can be unplugged, replugged and
// swapped while the service runs.
//
// With phones over USB switched off (config USBPhone, the usb-phone
// request) the phone kinds are not looked at: no phone is switched to
// another USB configuration, paired with or tethered, and a phone link
// running when the switch goes off ends as an unplug would end it.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

const (
	kindUSB      = "usb"
	retryFailed  = 15 * time.Second // a device that failed to open is tried again after this
	switchRepeat = 30 * time.Second
)

// Replaced by tests.
var (
	scanEvery      = 2 * time.Second  // poll cadence when uevent netlink is unavailable
	preferEvery    = 5 * time.Second  // preferred-device cadence when uevent netlink is unavailable
	scanFallback   = 20 * time.Second // safety sweep while uevent netlink is active
	preferFallback = 30 * time.Second // preferred-device safety sweep while uevent netlink is active
	listenUevent   = openUevent
)

var autoKinds = []string{kindWiFi, kindUSB, kindECM, kindRNDIS, kindNCM, kindIPhone}

// errPhoneOff ends a phone's link, or the take of one, when phones over USB
// are switched off.
var errPhoneOff = errors.New("phones over USB are switched off")

// preferGroups are the choices of preferred and the kinds each puts first.
var preferGroups = map[string][]string{
	"wifi":  {kindWiFi},
	"usb":   {kindUSB, kindECM},
	"phone": {kindRNDIS, kindNCM, kindIPhone},
}

func checkPreferred(v string) error {
	if _, ok := preferGroups[v]; v != "" && !ok {
		return fmt.Errorf("preferred: %q is none of wifi, usb, phone", v)
	}
	return nil
}

func kindRank(kind string) int {
	for i, k := range autoKinds {
		if k == kind {
			return i
		}
	}
	return len(autoKinds)
}

type scanUplink struct {
	record  string        // link.json, for a kernel adapter it renames
	pairDir string        // the iPhone pairing's host identity
	wifi    *wifiProvider // nil: no Wi-Fi

	mu       sync.Mutex
	prefer   string               // the group tried first (preferGroups)
	phones   bool                 // phones over USB are taken
	phoneOff chan struct{}        // closed while phones over USB are switched off
	changed  chan struct{}        // closed and replaced on prefer, usb_phone or Wi-Fi association changes
	failed   map[string]time.Time // device key -> last failed open
	switched map[string]time.Time
	logged   map[string]string // device key -> last message logged
}

func newScanUplink(c config) *scanUplink {
	u := &scanUplink{record: c.linkFile(), pairDir: c.pairDir(), prefer: c.Preferred,
		phones: true, phoneOff: make(chan struct{}), changed: make(chan struct{}),
		failed: map[string]time.Time{}, switched: map[string]time.Time{},
		logged: map[string]string{}}
	u.setUSBPhone(c.USBPhone)
	return u
}

func (u *scanUplink) String() string { return "auto" }

func (u *scanUplink) pokeLocked() {
	if u.changed != nil {
		close(u.changed)
		u.changed = make(chan struct{})
	}
}

func (u *scanUplink) poke() {
	u.mu.Lock()
	u.pokeLocked()
	u.mu.Unlock()
}

func (u *scanUplink) changedCh() <-chan struct{} {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.changed == nil {
		u.changed = make(chan struct{})
	}
	return u.changed
}

func (u *scanUplink) setPreferred(group string) {
	u.mu.Lock()
	u.prefer = group
	u.pokeLocked()
	u.mu.Unlock()
}

// setUSBPhone switches phones over USB on or off. Off ends a phone's link
// at once (watchPreferred), and the scans pass phones by.
func (u *scanUplink) setUSBPhone(on bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case on && !u.phones:
		u.phoneOff = make(chan struct{})
		u.pokeLocked()
	case !on && u.phones:
		close(u.phoneOff)
	}
	u.phones = on
}

// phoneGate reports whether phones over USB are taken, and a channel closed
// once they are switched off.
func (u *scanUplink) phoneGate() (bool, <-chan struct{}) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.phones, u.phoneOff
}

func isPhoneKind(kind string) bool { return slices.Contains(preferGroups["phone"], kind) }

// rank orders kinds: the preferred group's first, then the others, each in
// autoKinds' order.
func (u *scanUplink) rank(kind string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	if slices.Contains(preferGroups[u.prefer], kind) {
		return kindRank(kind)
	}
	return len(autoKinds) + kindRank(kind)
}

// candidate is one device the uplink could open.
type candidate struct {
	kind     string
	key      string // identity of this attachment
	dev      statusDevice
	netdev   string // kindUSB: the kernel interface
	info     usbDeviceInfo
	fn       netFunction
	toSwitch bool   // a stick in CD-ROM mode, to be switched
	busy     string // why the device is left alone
}

// candidates lists what is plugged in or joined, best first, and prunes
// tracking state for devices that are no longer present.
func (u *scanUplink) candidates() []candidate {
	var out []candidate
	presentKeys := map[string]bool{}
	presentSys := map[string]bool{}
	if u.wifi != nil {
		if ssid, ok := u.wifi.associated(); ok {
			key := "wifi:" + ssid
			presentKeys[key] = true
			out = append(out, candidate{kind: kindWiFi, key: key, netdev: u.wifi.ifname(),
				dev: statusDevice{Kind: kindWiFi, Name: ssid}})
		}
	}
	for _, n := range usbNetdevs(sysClassNet) {
		// The interface index is new for each attachment, the name may not be.
		idx, _ := readSysctl(sysClassNet + "/" + n + "/ifindex")
		key := "netdev:" + n + "#" + idx
		presentKeys[key] = true
		out = append(out, candidate{kind: kindUSB, key: key, netdev: n, dev: netdevDevice(sysClassNet, n)})
	}
	devs := scanUSBDevices()
	iphoneForgetGone(devs)
	phones, _ := u.phoneGate()
	for _, info := range devs {
		presentSys[info.sysName] = true
		apple := strings.HasPrefix(info.vidpid, "05ac:")
		for _, kind := range []string{kindECM, kindRNDIS, kindNCM, kindIPhone} {
			// An Apple device's own CDC functions (a Mac's, an iPhone's reverse
			// tethering) are not internet for the unit: Apple devices are taken
			// only as iPhones.
			if apple && kind != kindIPhone || !phones && isPhoneKind(kind) {
				continue
			}
			// The iPhone's attempt is keyed on its bus position, so a
			// failed open backs off however the device re-enumerates.
			key := kind + ":" + info.key()
			if kind == kindIPhone {
				key = kind + ":" + info.sysName
			}
			c := candidate{kind: kind, key: key, info: info,
				dev: statusDevice{Kind: kind, Name: info.name()}}
			if kind == kindECM && switchDevices[info.vidpid] {
				presentKeys[key] = true
				c.toSwitch = true
				out = append(out, c)
				continue
			}
			fn, ok := info.function(kind)
			if !ok {
				continue
			}
			presentKeys[key] = true
			c.fn = fn
			// The uplink takes an iPhone from the media daemon itself
			// (iphone.go), so a held iPhone is not left alone, unless its
			// owner declined Trust; one whose last link failed waits for
			// its backoff.
			if kind == kindIPhone {
				declined, wait := iphoneHeldBack(info)
				if declined {
					c.busy = iphoneDeclinedNote
				} else if wait {
					continue
				}
			} else {
				var held []string
				for _, n := range []int{fn.commIface, fn.dataIface} {
					if d := info.ifaceDriver(n); d != "" {
						held = append(held, fmt.Sprintf("%d=%s", n, d))
					}
				}
				if len(held) > 0 {
					continue // a kernel driver runs it: a kernel adapter if it is one
				}
			}
			out = append(out, c)
			break
		}
	}
	u.prune(presentKeys, presentSys)
	sort.SliceStable(out, func(i, j int) bool { return u.rank(out[i].kind) < u.rank(out[j].kind) })
	return out
}

func (u *scanUplink) prune(keys, sys map[string]bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for k := range u.failed {
		if !keys[k] {
			delete(u.failed, k)
		}
	}
	for k := range u.logged {
		if !keys[k] {
			delete(u.logged, k)
		}
	}
	for k := range u.switched {
		if !sys[k] {
			delete(u.switched, k)
		}
	}
}

// say logs msg for key once until it changes.
func (u *scanUplink) say(key, msg string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.logged[key] != msg {
		u.logged[key] = msg
		logf("%s", msg)
	}
}

func (u *scanUplink) recentlyFailed(key string) (time.Duration, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	t, ok := u.failed[key]
	if !ok {
		return 0, false
	}
	if rem := retryFailed - time.Since(t); rem > 0 {
		return rem, true
	}
	return 0, false
}

func (u *scanUplink) Open(ctx context.Context) (Link, error) {
	uev, err := listenUevent()
	var uevCh <-chan struct{}
	every := scanEvery
	if err == nil {
		defer uev.Close()
		uevCh = uev.C
		every = scanFallback
	}
	waiting := false
	for {
		changed := u.changedCh()
		cands := u.candidates()
		tried := false
		wait := every
		for _, c := range cands {
			dev := c.dev
			switch {
			case c.toSwitch:
				u.modeSwitch(c.info)
				continue
			case c.busy != "":
				u.say(c.key, fmt.Sprintf("%s: %s, leaving it alone", c.info, c.busy))
				setStatus(&dev, stateBusy, c.busy)
				tried = true
				continue
			}
			if rem, ok := u.recentlyFailed(c.key); ok {
				tried = true
				if rem < wait {
					wait = rem
				}
				continue
			}
			tried = true
			waiting = false
			setStatus(&dev, stateConnecting, "")
			l, err := u.open(ctx, c)
			if err == nil {
				u.mu.Lock()
				delete(u.failed, c.key)
				delete(u.logged, c.key)
				u.mu.Unlock()
				// also on the best kind: the preferred group can change
				return u.watchPreferred(l, c), nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var pe *preferredError
			if errors.As(err, &pe) || errors.Is(err, errPhoneOff) {
				u.say(c.key, fmt.Sprintf("%s: %v", c.info, err))
				break // the next scan opens the preferred device first, or passes the phone by
			}
			u.mu.Lock()
			u.failed[c.key] = time.Now()
			u.mu.Unlock()
			if retryFailed < wait {
				wait = retryFailed
			}
			u.say(c.key, fmt.Sprintf("open %s %s: %v", c.kind, c.dev.Name, err))
			if isBusy(err) {
				setStatus(&dev, stateBusy, err.Error())
			} else {
				setStatus(&dev, stateError, err.Error())
			}
		}
		if !tried {
			setStatus(nil, stateSearching, "")
			if !waiting {
				logf("waiting for a USB uplink device (%s)", u)
				waiting = true
			}
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil, ctx.Err()
		case <-changed:
		case <-uevCh:
		case <-t.C:
		}
		if !t.Stop() {
			select {
			case <-t.C:
			default:
			}
		}
	}
}

func (u *scanUplink) open(ctx context.Context, c candidate) (Link, error) {
	switch c.kind {
	case kindUSB:
		link, err := netlink.LinkByName(c.netdev)
		if err != nil {
			return nil, err
		}
		l, err := attach(link, Ifname, u.record)
		if err != nil {
			return nil, err
		}
		l.dev = c.dev
		return l, nil
	case kindWiFi:
		return u.wifi.openLink(c.dev.Name), nil
	case kindIPhone:
		return openIPhoneLink(ctx, c.info, c.fn, u.pairDir, func() error {
			if on, _ := u.phoneGate(); !on {
				return errPhoneOff
			}
			if p := u.preferred(c); p != nil {
				return &preferredError{*p}
			}
			return nil
		})
	}
	return openCDCLink(c.info, c.fn)
}

func (u *scanUplink) modeSwitch(info usbDeviceInfo) {
	u.mu.Lock()
	last, ok := u.switched[info.sysName]
	if ok && time.Since(last) < switchRepeat {
		u.mu.Unlock()
		return
	}
	u.switched[info.sysName] = time.Now()
	u.mu.Unlock()
	logf("%s is in CD-ROM mode, switching it to a network device", info)
	if err := modeSwitch(info); err != nil {
		logf("mode switch: %v", err)
	}
}

// preferred returns a device of an earlier kind than cur that the uplink
// should open instead: one not busy and never failed to open in
// this attachment, so a device that cannot be opened does not take a
// working link down again and again. A stick in CD-ROM mode is switched
// from here; it is preferred once it returns as a network device.
func (u *scanUplink) preferred(cur candidate) *candidate {
	for _, c := range u.candidates() {
		if u.rank(c.kind) >= u.rank(cur.kind) || c.busy != "" {
			continue
		}
		if c.toSwitch {
			u.modeSwitch(c.info)
			continue
		}
		u.mu.Lock()
		_, failed := u.failed[c.key]
		u.mu.Unlock()
		if !failed {
			return &c
		}
	}
	return nil
}

// preferredError ends a link, or an iPhone's Trust wait, for a device of
// an earlier kind.
type preferredError struct{ c candidate }

func (e *preferredError) Error() string {
	return fmt.Sprintf("%s %s is preferred", e.c.kind, e.c.dev.Name)
}

// preferLink is a link ended when a device of an earlier kind appears, or
// when phones over USB are switched off while it runs on a phone.
type preferLink struct {
	Link
	done chan struct{}
	stop chan struct{}
	once sync.Once
	err  error
}

func (u *scanUplink) watchPreferred(l Link, cur candidate) Link {
	p := &preferLink{Link: l, done: make(chan struct{}), stop: make(chan struct{})}
	var phoneOff <-chan struct{} // nil: never, for a device that is no phone
	if isPhoneKind(cur.kind) {
		_, phoneOff = u.phoneGate()
	}
	go func() {
		uev, err := listenUevent()
		var uevCh <-chan struct{}
		every := preferEvery
		if err == nil {
			defer uev.Close()
			uevCh = uev.C
			every = preferFallback
		}
		t := time.NewTicker(every)
		defer t.Stop()
		changed := u.changedCh()
		for {
			select {
			case <-p.stop:
				return
			case <-phoneOff:
				p.err = errPhoneOff
				close(p.done)
				return
			case <-l.Done():
				p.err = l.Err()
				close(p.done)
				return
			case <-changed:
			case <-uevCh:
			case <-t.C:
			}
			changed = u.changedCh()
			if c := u.preferred(cur); c != nil {
				p.err = &preferredError{*c}
				close(p.done)
				return
			}
		}
	}()
	return p
}

// ueventMonitor delivers wakeups from the kernel's NETLINK_KOBJECT_UEVENT
// broadcast for USB and network device changes.
type ueventMonitor struct {
	C    chan struct{}
	f    *os.File
	done chan struct{}
}

func openUevent() (*ueventMonitor, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, unix.NETLINK_KOBJECT_UEVENT)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: 1}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	m := &ueventMonitor{
		C:    make(chan struct{}, 1),
		f:    os.NewFile(uintptr(fd), "uevent"),
		done: make(chan struct{}),
	}
	go m.readLoop()
	return m, nil
}

func (m *ueventMonitor) readLoop() {
	defer close(m.done)
	buf := make([]byte, 8192)
	for {
		n, err := m.f.Read(buf)
		if err != nil {
			return
		}
		if isRelevantUevent(buf[:n]) {
			select {
			case m.C <- struct{}{}:
			default:
			}
		}
	}
}

func (m *ueventMonitor) Close() {
	if m.f != nil {
		m.f.Close()
	}
	if m.done != nil {
		<-m.done
	}
}

func isRelevantUevent(b []byte) bool {
	for len(b) > 0 {
		field := b
		if i := bytes.IndexByte(b, 0); i >= 0 {
			field, b = b[:i], b[i+1:]
		} else {
			b = nil
		}
		if string(field) == "SUBSYSTEM=usb" || string(field) == "SUBSYSTEM=net" {
			return true
		}
	}
	return false
}

func (p *preferLink) Done() <-chan struct{} { return p.done }
func (p *preferLink) Err() error            { return p.err }
func (p *preferLink) Close() {
	p.once.Do(func() { close(p.stop) })
	p.Link.Close()
}

func (p *preferLink) device() statusDevice {
	if d, ok := p.Link.(deviceLink); ok {
		return d.device()
	}
	return statusDevice{}
}
