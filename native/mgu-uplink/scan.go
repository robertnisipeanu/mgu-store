package main

// The USB uplinks. scanUplink looks at what is plugged in every 2 s and
// opens the first usable device of the kinds it covers, in this order:
//
//	usb     an adapter the kernel drives (netdev.go)
//	usbecm  a CDC-ECM stick, a Huawei stick in CD-ROM mode switched first
//	rndis   an Android phone in RNDIS tethering (most)
//	ncm     an Android phone in NCM tethering (Pixel 6 and later)
//	iphone  an iPhone's Personal Hotspot
//
// "auto" covers all of them and takes only devices no driver or process
// holds; once on a later kind it ends that link when an earlier kind's
// device appears, so a stick plugged in next to a phone takes over. An
// unplugged device ends its link and the next scan finds whatever is
// there, so devices can be unplugged, replugged and swapped while the
// service runs. A named uplink (usb, usbecm, rndis, ncm, iphone) covers
// one kind and lifts kernel drivers off the function it takes (never off
// an Apple device).

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vishvananda/netlink"
)

const (
	kindUSB      = "usb"
	scanEvery    = 2 * time.Second
	retryFailed  = 15 * time.Second // a device that failed to open is tried again after this
	preferEvery  = 5 * time.Second
	switchRepeat = 30 * time.Second
)

var autoKinds = []string{kindUSB, kindECM, kindRNDIS, kindNCM, kindIPhone}

func kindRank(kind string) int {
	for i, k := range autoKinds {
		if k == kind {
			return i
		}
	}
	return len(autoKinds)
}

type scanUplink struct {
	spec    string   // auto, usb, usbecm, rndis, ncm, iphone
	kinds   []string // what it covers, in preference order
	device  string   // usb_device: only this VID:PID
	record  string   // link.json, for a kernel adapter it renames
	pairDir string   // iPhone pair records

	mu       sync.Mutex
	failed   map[string]time.Time // device key -> last failed open
	denied   map[string]bool      // iPhones whose owner declined Trust, until replugged
	switched map[string]time.Time
	logged   map[string]string // device key -> last message logged
}

func newScanUplink(spec string, c config) *scanUplink {
	u := &scanUplink{spec: spec, device: c.USBDevice, record: c.linkFile(), pairDir: c.pairDir(),
		failed: map[string]time.Time{}, denied: map[string]bool{}, switched: map[string]time.Time{},
		logged: map[string]string{}}
	if spec == "auto" {
		u.kinds = autoKinds
	} else {
		u.kinds = []string{spec}
	}
	return u
}

func (u *scanUplink) String() string {
	if u.device != "" {
		return u.spec + ":" + u.device
	}
	return u.spec
}

func (u *scanUplink) auto() bool { return u.spec == "auto" }

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

func (c candidate) rank() int { return kindRank(c.kind) }

// candidates lists what is plugged in that the uplink covers, best first.
func (u *scanUplink) candidates() []candidate {
	var out []candidate
	covers := map[string]bool{}
	for _, k := range u.kinds {
		covers[k] = true
	}
	if covers[kindUSB] {
		for _, n := range usbNetdevs(sysClassNet, u.device) {
			out = append(out, candidate{kind: kindUSB, key: "netdev:" + n, netdev: n, dev: netdevDevice(sysClassNet, n)})
		}
	}
	var devs []usbDeviceInfo
	if covers[kindECM] || covers[kindRNDIS] || covers[kindNCM] || covers[kindIPhone] {
		devs = scanUSBDevices()
	}
	for _, info := range devs {
		named := u.device == "" || info.vidpid == u.device
		for _, kind := range []string{kindECM, kindRNDIS, kindNCM, kindIPhone} {
			if !covers[kind] {
				continue
			}
			c := candidate{kind: kind, key: kind + ":" + info.key(), info: info,
				dev: statusDevice{Kind: kind, Name: info.name()}}
			if kind == kindECM && u.switchable(info) {
				c.toSwitch = true
				out = append(out, c)
				continue
			}
			if !named {
				continue
			}
			fn, ok := info.function(kind)
			if !ok {
				continue
			}
			// A named usbecm takes the HiLink ids unless usb_device names the stick.
			if kind == kindECM && !u.auto() && u.device == "" && !ecmStickDevices[info.vidpid] {
				continue
			}
			c.fn = fn
			switch {
			case kind == kindIPhone:
				// The configuration the phone is in, before this service changes it.
				if b := info.boundIfaces(); len(b) > 0 {
					c.busy = fmt.Sprintf("held by %s", strings.Join(b, ", "))
				}
			case u.auto():
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
	sort.SliceStable(out, func(i, j int) bool { return out[i].rank() < out[j].rank() })
	return out
}

// switchable reports whether the device is a stick in CD-ROM mode that
// modeSwitch turns into an ECM stick the uplink takes.
func (u *scanUplink) switchable(info usbDeviceInfo) bool {
	if !switchDevices[info.vidpid] {
		return false
	}
	if u.device != "" {
		return u.device[:5] == info.vidpid[:5] // same vendor
	}
	return true
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

func (u *scanUplink) recentlyFailed(key string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	t, ok := u.failed[key]
	return ok && time.Since(t) < retryFailed
}

func (u *scanUplink) Open(ctx context.Context) (Link, error) {
	waiting := false
	for {
		cands := u.candidates()
		tried := false
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
			case u.denied[c.key]:
				setStatus(&dev, stateError, "Trust was declined; unplug and plug in the iPhone to ask again")
				tried = true
				continue
			case u.recentlyFailed(c.key):
				tried = true
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
				if u.auto() && c.rank() > 0 {
					l = u.watchPreferred(l, c)
				}
				return l, nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			u.mu.Lock()
			u.failed[c.key] = time.Now()
			if err == errTrustDenied {
				u.denied[c.key] = true
			}
			u.mu.Unlock()
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
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(scanEvery):
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
	case kindIPhone:
		dev := c.dev
		return openIPhoneLink(ctx, c.info, c.fn, u.pairDir, func(msg string) {
			u.say(c.key, fmt.Sprintf("%s: %s", c.info, msg))
			setStatus(&dev, stateTrustNeeded, msg)
		})
	}
	return openCDCLink(c.info, c.fn, !u.auto())
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

// preferLink is an auto link on a later kind, ended when a device of an
// earlier kind appears.
type preferLink struct {
	Link
	done chan struct{}
	stop chan struct{}
	once sync.Once
	err  error
}

func (u *scanUplink) watchPreferred(l Link, cur candidate) Link {
	p := &preferLink{Link: l, done: make(chan struct{}), stop: make(chan struct{})}
	go func() {
		t := time.NewTicker(preferEvery)
		defer t.Stop()
		for {
			select {
			case <-p.stop:
				return
			case <-l.Done():
				p.err = l.Err()
				close(p.done)
				return
			case <-t.C:
				for _, c := range u.candidates() {
					if c.rank() >= cur.rank() || c.busy != "" || u.recentlyFailed(c.key) {
						continue
					}
					p.err = fmt.Errorf("%s %s is preferred", c.kind, c.dev.Name)
					close(p.done)
					return
				}
			}
		}
	}()
	return p
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
