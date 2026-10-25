package main

// The class-standard USB network functions driven from user space: CDC-ECM
// (LTE sticks), RNDIS (most Android phones) and CDC-NCM (Pixel 6 and later,
// and some routers). Each claims the function's control and data
// interfaces, brings the function up and hands its framer to the relay.

import (
	"fmt"
)

// SET_ETHERNET_PACKET_FILTER (CDC-ECM and NCM), and the filter asking the
// device to pass everything on the segment: promiscuous, all multicast,
// directed and broadcast (USB_CDC_PACKET_TYPE_* bits 0-3).
const (
	cdcSetPacketFilter = 0x43
	cdcFilterAll       = 0x000f
)

// openCDCLink takes the function over in the device's active
// configuration. unbind lifts kernel drivers off its interfaces first (the
// explicit uplinks); without it an interface a driver holds makes the
// device busy.
func openCDCLink(info usbDeviceInfo, fn netFunction, unbind bool) (Link, error) {
	dev, err := openUSBDevice(info.bus, info.dev)
	if err != nil {
		return nil, err
	}
	var unbound unboundDrivers
	if unbind {
		unbound = unbindInterfaces(info, fn.commIface, fn.dataIface)
	}
	claimed, err := claimInterfaces(dev, info, fn.commIface, fn.dataIface)
	if err != nil {
		dev.Close()
		unbound.rebind()
		return nil, err
	}
	fail := func(err error) (Link, error) {
		for _, n := range claimed {
			dev.releaseInterface(n)
		}
		dev.Close()
		unbound.rebind()
		return nil, err
	}
	pipe := usbPipe{dev: dev, in: fn.bulkIn, out: fn.bulkOut, outPacket: fn.outPacket}
	var fr framer
	var mac []byte
	mtu := 0
	switch fn.kind {
	case kindECM:
		if fn.dataAlt != 0 {
			if err := dev.setInterface(fn.dataIface, fn.dataAlt); err != nil {
				return fail(err)
			}
		}
		if _, err := dev.control(0x21, cdcSetPacketFilter, cdcFilterAll, uint16(fn.commIface), nil, 1000); err != nil {
			logf("%s: set packet filter: %v (continuing)", info, err)
		}
		mac = functionMAC(dev, info, fn)
		if seg := fn.maxSegment; seg > 14 {
			mtu = seg - 14
		}
		fr = &ecmFramer{p: pipe, size: fn.maxSegment}
	case kindNCM:
		f, err := initNCM(dev, info, fn, pipe)
		if err != nil {
			return fail(err)
		}
		mac = functionMAC(dev, info, fn)
		mtu = f.mtu(fn.maxSegment)
		fr = f
	case kindRNDIS:
		f, err := initRNDIS(dev, fn, pipe)
		if err != nil {
			return fail(fmt.Errorf("%s: %v", info, err))
		}
		mac = f.mac
		if mac == nil {
			mac = fallbackMAC(info)
		}
		mtu = f.mtu()
		fr = f
	default:
		return fail(fmt.Errorf("%s: no driver for %s", info, fn.kind))
	}
	return startRelay(fn.kind, info, dev, claimed, unbound, fr, mac, mtu)
}

// ecmFramer is CDC-ECM: one Ethernet frame per bulk transfer, ended by a
// short packet (a zero-length one when the frame is a whole number of
// packets).
type ecmFramer struct {
	p    usbPipe
	size int // wMaxSegmentSize
}

func (f *ecmFramer) pipe() usbPipe       { return f.p }
func (f *ecmFramer) send(b []byte) error { return f.p.write(b, true) }

func (f *ecmFramer) rxSize() int {
	if f.size < 2048 {
		return 2048
	}
	return f.size
}

// recv: a zero-length transfer is the terminator of a frame whose length
// is a whole number of packets and carries nothing by itself.
func (f *ecmFramer) recv(buf []byte, emit func([]byte)) error {
	n, err := f.p.read(buf, 500)
	if err != nil {
		return err
	}
	emit(buf[:n])
	return nil
}
