package main

// An iPhone's Personal Hotspot over USB. An iPhone needs no host-side
// pairing for tethering: it drops packets until its owner taps "Trust This
// Computer?" on the phone itself, so the host only has to reach the hotspot
// interface and run DHCP. The obstacle on the head unit is the stock media
// daemon, which grabs a connected iPhone and holds it on configuration 2
// (iAP/iPod media). The uplink takes the device away from it:
//
//	/sys/.../authorized 0    deauthorize: the kernel tears the device down and
//	                         drops every claim, so the media daemon loses it
//	(500 ms)
//	/sys/.../authorized 1    reauthorize: the device re-enumerates at its
//	                         default configuration with a new device number
//	open /dev/bus/usb/...    on the re-enumerated node
//	SET_CONFIGURATION 4      the configuration holding the hotspot interface
//	CLAIM_INTERFACE          the hotspot interface (ff/fd/01, Linux's ipheth)
//
// The media daemon races to put the device back on configuration 2, so the
// claim is retried: inner retries for 2 s after each reauthorize, up to six
// reauthorize rounds. Taking the device makes it a network device, not a
// media device, so USB media playback from that iPhone stops while
// tethering and resumes when it ends (close reauthorizes the device so the
// media daemon re-enumerates and reclaims it). Only the one Apple device is
// touched; the media daemon keeps serving every other device.
//
// With the hotspot interface claimed the frames flow as ipheth does:
//
//	GET_MACADDR    0xc0/0x00: the host-side MAC
//	ENABLE_NCM     0x41/0x04: accepted means NCM framing for what the phone
//	               sends; refused means legacy framing
//	alt setting 1  the bulk endpoints
//	TX             one raw Ethernet frame per transfer, no padding; a frame
//	               that is a whole number of packets is ended by a
//	               zero-length packet
//	RX legacy      2 bytes of padding, then one frame (1516-byte buffer)
//	RX NCM         an NTH16 with its NDP16 at offset 12, 96 bytes long
//	CARRIER_CHECK  0xc0/0x45: 0x04 means Personal Hotspot is sharing
//
// Until the owner taps Trust (and turns Personal Hotspot on) the phone
// sends nothing, so no DHCP lease arrives: the uplink then reports
// `trust-needed` ("Tap Trust on the iPhone").

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"time"
)

const (
	iphethGetMAC      = 0x00
	iphethEnableNCM   = 0x04
	iphethCarrier     = 0x45
	iphethCarrierOn   = 0x04
	iphethLegacyRx    = 2 + 1514
	iphethNCMRx       = 65536
	iphethNCMHeader   = nth16Len + 96 // NTH16 and the fixed-size NDP16
	iphethNDPMaxDPE   = 22
	iphethCarrierPoll = time.Second

	// iphoneGrabTries reauthorize rounds, iphoneGrabWindow of inner claim
	// retries after each, with the paced sleeps the media daemon is raced
	// with.
	iphoneGrabTries    = 6
	iphoneGrabWindow   = 2 * time.Second
	iphoneDeauthHold   = 500 * time.Millisecond
	iphoneConfigSettle = 80 * time.Millisecond
	iphoneClaimRetry   = 50 * time.Millisecond
	iphoneEnumPoll     = 20 * time.Millisecond

	// iphoneTrustGrace: with the hotspot interface up but nothing received,
	// the phone is waiting for Trust (or the hotspot is off).
	iphoneTrustGrace = 6 * time.Second
)

// openIPhoneLink takes the iPhone from the media daemon, brings its hotspot
// interface up and starts the relay. checkPreferred, called between
// reauthorize rounds, ends the attempt when a preferred (wired) device
// appears.
func openIPhoneLink(ctx context.Context, info usbDeviceInfo, fn netFunction, checkPreferred func() error) (Link, error) {
	dev, cur, fn, err := grabIPhone(ctx, info, fn, checkPreferred)
	if err != nil {
		return nil, err
	}
	iface := uint16(fn.dataIface)
	buf := make([]byte, 64)
	var mac []byte
	if n, err := dev.control(0xc0, iphethGetMAC, 0, iface, buf, 5000); err == nil && n >= 6 {
		mac = append([]byte{}, buf[:6]...)
	} else {
		logf("%s: GET_MACADDR: %v (%d bytes)", cur, err, n)
		mac = fallbackMAC(cur)
	}
	_, err = dev.control(0x41, iphethEnableNCM, 0, iface, nil, 5000)
	ncm := err == nil
	// The hotspot interface carries its bulk endpoints on an alternate
	// setting (alt 1 on current iPhones); select it so they are live. A
	// device that exposes them on the default setting has dataAlt 0 and
	// needs no switch.
	if fn.dataAlt != 0 {
		if err := dev.setInterface(fn.dataIface, fn.dataAlt); err != nil {
			dev.releaseInterface(fn.dataIface)
			dev.Close()
			return nil, fmt.Errorf("%s: set interface %d alt %d: %w", cur, fn.dataIface, fn.dataAlt, err)
		}
	}
	logf("iPhone %s: hotspot interface %d, MAC %s, NCM receive %v", cur, fn.dataIface, net.HardwareAddr(mac), ncm)
	fr := &iphethFramer{dev: dev, iface: iface, ncm: ncm, authPath: authorizedPath(cur), up: time.Now(),
		p: usbPipe{dev: dev, in: fn.bulkIn, out: fn.bulkOut, outPacket: fn.outPacket}}
	setLinkNote("")
	setLinkTrust(false, "")
	return startRelay(kindIPhone, cur, dev, []int{fn.dataIface}, nil, fr, mac, 0)
}

func sysDevDir(sysName string) string          { return sysBusUSB + "/" + sysName }
func authorizedPath(info usbDeviceInfo) string { return sysDevDir(info.sysName) + "/authorized" }

// grabIPhone takes the device away from whatever holds it: deauthorize,
// reauthorize, then on the re-enumerated node select the hotspot
// configuration and claim the hotspot interface, racing the media daemon's
// attempts to put it back on configuration 2. It returns the open device,
// its re-enumerated info and function.
func grabIPhone(ctx context.Context, info usbDeviceInfo, fn netFunction, checkPreferred func() error) (*usbDevice, usbDeviceInfo, netFunction, error) {
	authPath := authorizedPath(info)
	for attempt := 0; attempt < iphoneGrabTries; attempt++ {
		if err := checkPreferred(); err != nil {
			return nil, info, fn, err
		}
		if err := ctx.Err(); err != nil {
			return nil, info, fn, err
		}
		if err := os.WriteFile(authPath, []byte("0\n"), 0644); err != nil {
			return nil, info, fn, fmt.Errorf("%s: deauthorize: %w", info, err)
		}
		cancelled := sleepCtx(ctx, iphoneDeauthHold) != nil
		// Reauthorize even when cancelled, so a stop during the hold never
		// leaves the device deauthorized (no media, CarPlay or data).
		if err := os.WriteFile(authPath, []byte("1\n"), 0644); err != nil {
			return nil, info, fn, fmt.Errorf("%s: reauthorize: %w", info, err)
		}
		if cancelled {
			return nil, info, fn, ctx.Err()
		}
		deadline := time.Now().Add(iphoneGrabWindow)
		for time.Now().Before(deadline) {
			if err := ctx.Err(); err != nil {
				return nil, info, fn, err
			}
			dev, cur, fn2, ok := claimHotspot(info.sysName, fn.config)
			if ok {
				logf("iPhone %s: took the device (configuration %d, hotspot interface %d)", cur, fn2.config, fn2.dataIface)
				return dev, cur, fn2, nil
			}
			sleepCtx(ctx, iphoneClaimRetry)
		}
	}
	return nil, info, fn, &busyError{fmt.Sprintf("%s: could not take the iPhone from the media service (it keeps reclaiming it)", info)}
}

// claimHotspot opens the re-enumerated device, selects config and claims its
// hotspot interface. ok is false while the device is still re-enumerating or
// the media daemon holds it; the caller retries.
func claimHotspot(sysName string, config int) (*usbDevice, usbDeviceInfo, netFunction, bool) {
	cur, ok := appleDevice(sysName)
	if !ok {
		time.Sleep(iphoneEnumPoll)
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	dev, err := openUSBDevice(cur.bus, cur.dev)
	if err != nil {
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	if err := dev.setConfiguration(config); err != nil {
		dev.Close()
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	time.Sleep(iphoneConfigSettle)
	cur, ok = appleDevice(sysName)
	if !ok {
		dev.Close()
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	fn, ok := cur.function(kindIPhone)
	if !ok || cur.config != config {
		dev.Close() // the media daemon put it back on its own configuration
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	if err := dev.claimInterface(fn.dataIface); err != nil {
		dev.Close()
		return nil, usbDeviceInfo{}, netFunction{}, false
	}
	return dev, cur, fn, true
}

// appleDevice re-reads the device at sysName, whose bus/device number
// changes on each re-enumeration.
func appleDevice(sysName string) (usbDeviceInfo, bool) {
	for _, info := range scanUSBDevices() {
		if info.sysName == sysName {
			return info, true
		}
	}
	return usbDeviceInfo{}, false
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// iphethFramer is the hotspot interface's framing.
type iphethFramer struct {
	dev      *usbDevice
	p        usbPipe
	iface    uint16
	ncm      bool
	authPath string
	up       time.Time
	gotRx    int32 // a transfer has arrived: carrier checks begin
	carrier  int32 // 0 unknown, 1 on, 2 off
}

func (f *iphethFramer) pipe() usbPipe { return f.p }

func (f *iphethFramer) rxSize() int {
	if f.ncm {
		return iphethNCMRx
	}
	return iphethLegacyRx
}

func (f *iphethFramer) send(frame []byte) error { return f.p.write(frame, true) }

func (f *iphethFramer) recv(buf []byte, emit func([]byte)) error {
	n, err := f.p.read(buf, 500)
	if err != nil {
		return err
	}
	atomic.StoreInt32(&f.gotRx, 1) // background withdraws any Trust note
	if n == 0 || n == 4 && buf[0] == 0 && buf[1] == 1 {
		return nil
	}
	if f.ncm {
		iphethUnpackNCM(buf[:n], emit)
	} else {
		iphethUnpackLegacy(buf[:n], emit)
	}
	return nil
}

func iphethUnpackLegacy(b []byte, emit func([]byte)) {
	if len(b) > 2 {
		emit(b[2:])
	}
}

// iphethUnpackNCM reads the phone's NTB as ipheth does: the NDP16 right
// after the header, at most 22 entries, each datagram after the fixed
// headers and inside the transfer, the list ended by a null entry.
func iphethUnpackNCM(b []byte, emit func([]byte)) {
	le := binary.LittleEndian
	if len(b) < iphethNCMHeader || le.Uint32(b) != nth16Sign || le.Uint16(b[10:]) != nth16Len ||
		le.Uint32(b[nth16Len:]) != ndp16NoCRC {
		return
	}
	for i := 0; i < iphethNDPMaxDPE; i++ {
		e := nth16Len + 8 + 4*i
		idx, n := int(le.Uint16(b[e:])), int(le.Uint16(b[e+2:]))
		if idx == 0 && n == 0 {
			return
		}
		if idx < iphethNCMHeader || idx >= len(b) || n > len(b)-idx {
			return
		}
		emit(b[idx : idx+n])
	}
}

// background polls the carrier and, while nothing arrives, reports that the
// phone is waiting for Trust. It is the only writer of the Trust note, so the
// note cannot stick: once frames arrive it withdraws it.
func (f *iphethFramer) background(stop <-chan struct{}, fail func(error)) {
	t := time.NewTicker(iphethCarrierPoll)
	defer t.Stop()
	buf := make([]byte, 64)
	reported := false
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		if atomic.LoadInt32(&f.gotRx) == 0 {
			if !reported && time.Since(f.up) > iphoneTrustGrace {
				reported = true
				logf("iPhone: no frames yet; waiting for Trust")
				setLinkTrust(true, "Tap Trust on the iPhone")
			}
			continue
		}
		if reported { // frames now arrive: withdraw the Trust note
			reported = false
			setLinkTrust(false, "")
		}
		n, err := f.dev.control(0xc0, iphethCarrier, 0, f.iface, buf, 5000)
		if err != nil || n <= 0 {
			continue
		}
		on := carrierOn(buf[:n])
		state := int32(2)
		if on {
			state = 1
		}
		if atomic.SwapInt32(&f.carrier, state) != state {
			if on {
				logf("iPhone: Personal Hotspot carrier on")
				setLinkNote("")
			} else {
				logf("iPhone: Personal Hotspot carrier off")
				setLinkNote("Personal Hotspot is off")
			}
		}
	}
}

// halt reauthorizes the device on stop, so it re-enumerates at its default
// configuration and the media daemon reclaims it for media playback.
func (f *iphethFramer) halt() {
	if f.authPath == "" {
		return
	}
	if os.WriteFile(f.authPath, []byte("0\n"), 0644) == nil {
		time.Sleep(100 * time.Millisecond)
		os.WriteFile(f.authPath, []byte("1\n"), 0644)
	}
}

func carrierOn(r []byte) bool {
	return len(r) == 1 && r[0] == iphethCarrierOn || len(r) >= 2 && r[1] == iphethCarrierOn
}
