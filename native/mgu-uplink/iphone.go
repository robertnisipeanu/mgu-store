package main

// An iPhone's Personal Hotspot over USB. In its default mode an iPhone
// offers four configurations; the hotspot interface (ff/fd/01, Linux's
// ipheth) is in the one usbmuxd selects, the highest with a usbmux
// interface: configuration 4. The unit selects it, establishes trust over
// usbmux and lockdown (lockdown.go), then relays frames as ipheth does:
//
//	GET_MACADDR    0xc0/0x00 on the hotspot interface: the host-side MAC
//	ENABLE_NCM     0x41/0x04: accepted means NCM framing for what the
//	               phone sends; refused means legacy framing
//	alt setting 1  the bulk endpoints
//	TX             one raw Ethernet frame per transfer, no padding; a frame
//	               that is a whole number of packets is ended by a
//	               zero-length packet (ipheth sends none; a device reading
//	               into a larger buffer needs one, and it costs nothing
//	               where it is not needed)
//	RX legacy      2 bytes of padding, then one frame (1516-byte buffer)
//	RX NCM         an NTH16 with its NDP16 at offset 12, 96 bytes long
//	               (64 KiB buffer)
//	CARRIER_CHECK  0xc0/0x45, polled each second once a frame has arrived:
//	               0x04 (byte 0 of a 1-byte reply, else byte 1) is on
//
// A zero-length transfer, and a 4-byte one starting 00 01 (a control frame,
// usually the first), carry no frame. The phone's DHCP server hands out
// 172.20.10.0/28. An Apple device a kernel driver or another process holds
// is left alone (busy): this service never detaches a driver from one.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"syscall"
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
)

// openIPhoneLink selects the hotspot configuration, establishes trust and
// starts the relay. wait reports the Trust prompt while it is open.
func openIPhoneLink(ctx context.Context, info usbDeviceInfo, fn netFunction, pairDir string, wait func(string)) (Link, error) {
	if info.config != fn.config {
		if b := info.boundIfaces(); len(b) > 0 {
			return nil, &busyError{fmt.Sprintf("%s: configuration %d held (%v)", info, info.config, b)}
		}
	}
	dev, err := openUSBDevice(info.bus, info.dev)
	if err != nil {
		return nil, err
	}
	if info.config != fn.config {
		if err := dev.setConfiguration(fn.config); err != nil {
			dev.Close()
			if errors.Is(err, syscall.EBUSY) {
				return nil, &busyError{fmt.Sprintf("%s: configuration %d is in use", info, info.config)}
			}
			return nil, err
		}
		logf("%s: configuration %d -> %d (of %d)", info, info.config, fn.config, fn.numConfigurations)
		info.config = fn.config
	}
	claimed, err := claimInterfaces(dev, info, fn.muxIface, fn.dataIface)
	if err != nil {
		dev.Close()
		return nil, err
	}
	fail := func(err error) (Link, error) {
		for _, n := range claimed {
			dev.releaseInterface(n)
		}
		dev.Close()
		return nil, err
	}
	mux, err := newUSBMux(usbPipe{dev: dev, in: fn.muxIn, out: fn.muxOut, outPacket: fn.muxOutPacket})
	if err != nil {
		return fail(fmt.Errorf("%s: %v", info, err))
	}
	udid, err := pairIPhone(ctx, mux, pairDir, wait)
	mux.Close()
	if err != nil {
		return fail(err)
	}
	dev.releaseInterface(fn.muxIface)
	claimed = []int{fn.dataIface}

	iface := uint16(fn.dataIface)
	buf := make([]byte, 64)
	var mac []byte
	if n, err := dev.control(0xc0, iphethGetMAC, 0, iface, buf, 5000); err == nil && n >= 6 {
		mac = append([]byte{}, buf[:6]...)
	} else {
		logf("%s: GET_MACADDR: %v (%d bytes)", info, err, n)
		mac = fallbackMAC(info)
	}
	_, err = dev.control(0x41, iphethEnableNCM, 0, iface, nil, 5000)
	ncm := err == nil
	if err := dev.setInterface(fn.dataIface, fn.dataAlt); err != nil {
		return fail(err)
	}
	logf("iPhone %s: hotspot interface %d, MAC %s, NCM receive %v", udid, fn.dataIface, net.HardwareAddr(mac), ncm)
	fr := &iphethFramer{dev: dev, iface: iface, ncm: ncm,
		p: usbPipe{dev: dev, in: fn.bulkIn, out: fn.bulkOut, outPacket: fn.outPacket}}
	setLinkNote("")
	return startRelay(kindIPhone, info, dev, claimed, nil, fr, mac, 0)
}

// iphethFramer is the hotspot interface's framing.
type iphethFramer struct {
	dev     *usbDevice
	p       usbPipe
	iface   uint16
	ncm     bool
	gotRx   int32 // a frame has arrived: carrier checks begin
	carrier int32 // 0 unknown, 1 on, 2 off
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
	if n == 0 || n == 4 && buf[0] == 0 && buf[1] == 1 {
		return nil
	}
	atomic.StoreInt32(&f.gotRx, 1)
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

// background polls the carrier: the phone reports it on while Personal
// Hotspot is on.
func (f *iphethFramer) background(stop <-chan struct{}, fail func(error)) {
	t := time.NewTicker(iphethCarrierPoll)
	defer t.Stop()
	buf := make([]byte, 64)
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		if atomic.LoadInt32(&f.gotRx) == 0 {
			continue
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

func carrierOn(r []byte) bool {
	return len(r) == 1 && r[0] == iphethCarrierOn || len(r) >= 2 && r[1] == iphethCarrierOn
}
