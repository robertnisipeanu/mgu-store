package main

// RNDIS, as Android phones present USB tethering by default (AOSP's
// config_tether_usb_functions = 0) and as the mainline f_rndis gadget
// does. Control messages go over EP0 as CDC encapsulated commands and
// responses; data messages carry one Ethernet frame each, several per bulk
// IN transfer. This follows Linux's rndis_host: INIT with our receive
// size, the device's MAC from OID_802_3_PERMANENT_ADDRESS, the packet
// filter, answers to the device's KEEPALIVE, its INDICATE_STATUS logged,
// and HALT when the host lets go. The framing is tested in
// rndis_test.go.

import (
	"encoding/binary"
	"fmt"
	"net"
	"time"
)

const (
	rndisMsgPacket    = 1
	rndisMsgInit      = 2
	rndisMsgHalt      = 3
	rndisMsgQuery     = 4
	rndisMsgSet       = 5
	rndisMsgIndicate  = 7
	rndisMsgKeepalive = 8
	rndisCompletion   = 0x80000000

	rndisPacketHeader = 44 // RNDIS_PACKET_MSG up to its data

	oidPermanentAddress = 0x01010101 // OID_802_3_PERMANENT_ADDRESS
	oidPacketFilter     = 0x0001010e // OID_GEN_CURRENT_PACKET_FILTER

	// NDIS_PACKET_TYPE_DIRECTED | ALL_MULTICAST | BROADCAST | PROMISCUOUS,
	// rndis_host's RNDIS_DEFAULT_FILTER.
	rndisFilter = 0x2d

	rndisMediaConnect    = 0x4001000b
	rndisMediaDisconnect = 0x4001000c

	// rndisRxSize is the largest bulk IN transfer we accept, sent in INIT.
	rndisRxSize = 16384
)

func le32(b []byte) uint32 { return binary.LittleEndian.Uint32(b) }

func putLE32(v ...uint32) []byte {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], x)
	}
	return b
}

// rndisMessage builds a control message: type, length, request id, body.
func rndisMessage(typ, reqID uint32, body []byte) []byte {
	return append(putLE32(typ, uint32(12+len(body)), reqID), body...)
}

// rndisPacket wraps one Ethernet frame in an RNDIS_PACKET_MSG. When the
// message is a whole number of bulk packets (outPacket) one zero byte
// follows it, as Linux's usbnet does: the transfer then ends with a short
// packet, and the device trims the message to its data length.
func rndisPacket(frame []byte, outPacket int) []byte {
	n := rndisPacketHeader + len(frame)
	size := n
	if outPacket > 0 && n%outPacket == 0 {
		size++
	}
	b := make([]byte, size)
	binary.LittleEndian.PutUint32(b[0:], rndisMsgPacket)
	binary.LittleEndian.PutUint32(b[4:], uint32(n))
	binary.LittleEndian.PutUint32(b[8:], rndisPacketHeader-8) // DataOffset, from byte 8
	binary.LittleEndian.PutUint32(b[12:], uint32(len(frame)))
	copy(b[rndisPacketHeader:], frame)
	return b
}

// rndisUnpack calls emit for each RNDIS_PACKET_MSG's frame in one bulk IN
// transfer. A malformed message ends the transfer.
func rndisUnpack(b []byte, emit func([]byte)) {
	for o := 0; o+rndisPacketHeader <= len(b); {
		typ, ml := le32(b[o:]), int(le32(b[o+4:]))
		if typ != rndisMsgPacket || ml < rndisPacketHeader || ml > len(b)-o {
			return
		}
		off, dl := int(le32(b[o+8:])), int(le32(b[o+12:]))
		start := o + 8 + off
		if off >= rndisPacketHeader-8 && dl >= 0 && start <= o+ml && dl <= o+ml-start {
			emit(b[start : start+dl])
		}
		o += ml
	}
}

// rndisFramer is one RNDIS function after INIT.
type rndisFramer struct {
	dev        *usbDevice
	p          usbPipe
	comm       int
	notify     byte
	reqID      uint32
	maxXfer    int    // the device's MaxTransferSize: the largest message it takes
	mac        []byte // OID_802_3_PERMANENT_ADDRESS
	lastStatus uint32
}

func (f *rndisFramer) pipe() usbPipe { return f.p }
func (f *rndisFramer) rxSize() int   { return rndisRxSize }

func (f *rndisFramer) send(frame []byte) error {
	pkt := rndisPacket(frame, f.p.outPacket)
	if f.maxXfer > 0 && len(pkt) > f.maxXfer {
		return nil // larger than the device takes: dropped, as on a wire
	}
	return f.p.write(pkt, false)
}

func (f *rndisFramer) recv(buf []byte, emit func([]byte)) error {
	n, err := f.p.read(buf, 500)
	if err != nil {
		return err
	}
	rndisUnpack(buf[:n], emit)
	return nil
}

// mtu fits a frame with its RNDIS header and pad byte into the device's
// MaxTransferSize.
func (f *rndisFramer) mtu() int {
	if f.maxXfer <= 0 {
		return 0
	}
	m := f.maxXfer - rndisPacketHeader - 14 - 1
	if m > 1500 {
		m = 1500
	}
	return m
}

// initRNDIS runs INIT, reads the MAC and sets the packet filter.
func initRNDIS(dev *usbDevice, fn netFunction, p usbPipe) (*rndisFramer, error) {
	f := &rndisFramer{dev: dev, p: p, comm: fn.commIface, notify: fn.notify}
	r, err := f.command(rndisMsgInit, putLE32(1, 0, rndisRxSize))
	if err != nil {
		return nil, err
	}
	if len(r) >= 40 {
		f.maxXfer = int(le32(r[36:]))
	}
	q, err := f.command(rndisMsgQuery, append(putLE32(oidPermanentAddress, 48, 20, 0), make([]byte, 48)...))
	if err != nil {
		return nil, err
	}
	if len(q) >= 24 {
		n, off := int(le32(q[16:])), 8+int(le32(q[20:]))
		if n >= 6 && off >= 24 && off+6 <= len(q) {
			f.mac = append([]byte{}, q[off:off+6]...)
		}
	}
	if _, err := f.command(rndisMsgSet, append(putLE32(oidPacketFilter, 4, 20, 0), putLE32(rndisFilter)...)); err != nil {
		return nil, err
	}
	logf("RNDIS: max transfer %d, MAC %s", f.maxXfer, net.HardwareAddr(f.mac))
	return f, nil
}

// command sends one control message and waits for its completion,
// handling the device's own messages that arrive in between.
func (f *rndisFramer) command(typ uint32, body []byte) ([]byte, error) {
	f.reqID++
	msg := rndisMessage(typ, f.reqID, body)
	if _, err := f.dev.control(0x21, 0x00, 0, uint16(f.comm), msg, 5000); err != nil { // SEND_ENCAPSULATED_COMMAND
		return nil, fmt.Errorf("RNDIS 0x%x: %v", typ, err)
	}
	// Devices signal RESPONSE_AVAILABLE on the interrupt endpoint; some
	// answer only once it has been read.
	if f.notify != 0 {
		f.dev.bulk(f.notify, make([]byte, 16), 1000)
	}
	for i := 0; i < 50; i++ {
		r := f.response()
		if r != nil && le32(r[8:]) == f.reqID && le32(r[0:]) == typ|rndisCompletion {
			if st := le32(r[12:]); st != 0 {
				return nil, fmt.Errorf("RNDIS 0x%x: status 0x%x", typ, st)
			}
			return r, nil
		}
		if r == nil {
			time.Sleep(40 * time.Millisecond)
		}
	}
	return nil, fmt.Errorf("RNDIS 0x%x: no response", typ)
}

// response reads one encapsulated response (GET_ENCAPSULATED_RESPONSE). A
// KEEPALIVE or INDICATE_STATUS from the device is handled here and
// returned as well; nil when nothing was waiting.
func (f *rndisFramer) response() []byte {
	buf := make([]byte, 1025)
	n, err := f.dev.control(0xa1, 0x01, 0, uint16(f.comm), buf, 5000)
	if err != nil || n < 16 {
		return nil
	}
	r := buf[:n]
	switch le32(r[0:]) {
	case rndisMsgKeepalive:
		reply := append(putLE32(rndisMsgKeepalive|rndisCompletion, 16, le32(r[8:])), putLE32(0)...)
		f.dev.control(0x21, 0x00, 0, uint16(f.comm), reply, 5000)
	case rndisMsgIndicate:
		if st := le32(r[8:]); st != f.lastStatus {
			f.lastStatus = st
			switch st {
			case rndisMediaConnect:
				logf("RNDIS: media connected")
			case rndisMediaDisconnect:
				logf("RNDIS: media disconnected")
			default:
				logf("RNDIS: status 0x%08x", st)
			}
		}
	}
	return r
}

// background answers the device's messages while the link runs: after
// each notification on the interrupt endpoint, or every 5 s when the
// function has none.
func (f *rndisFramer) background(stop <-chan struct{}, fail func(error)) {
	note := make([]byte, 16)
	for {
		select {
		case <-stop:
			return
		default:
		}
		if f.notify != 0 {
			_, err := f.dev.bulk(f.notify, note, 1000)
			if err != nil {
				if isUSBGone(err) {
					return // the data pump reports it
				}
				continue
			}
		} else {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Second):
			}
		}
		for i := 0; i < 8 && f.response() != nil; i++ {
		}
	}
}

// halt tells the device the host is done (RNDIS_MSG_HALT has no reply).
func (f *rndisFramer) halt() {
	f.reqID++
	f.dev.control(0x21, 0x00, 0, uint16(f.comm), rndisMessage(rndisMsgHalt, f.reqID, nil), 1000)
}
