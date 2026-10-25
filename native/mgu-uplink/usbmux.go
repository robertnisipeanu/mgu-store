package main

// usbmux, the protocol an iPhone speaks on its usbmux interface (ff/fe/02),
// host side, as usbmuxd's device.c does it: a version exchange (v2), the
// v2 setup packet, then TCP-shaped connections to ports on the phone. The
// "TCP" is framing only: USB delivers in order and without loss, so there
// is no retransmission, the phone's sequence numbers start at 0 and the
// host acknowledges each segment as it arrives. One connection at a time
// is all pairing needs. Tested in iphone_test.go against a fake phone.
//
//	header v1:  protocol, length                       (big-endian u32 each)
//	header v2:  protocol, length, 0xfeedface, tx_seq u16, rx_seq u16
//	TCP:        a 20-byte struct tcphdr, window in units of 256 bytes

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	muxProtoVersion = 0
	muxProtoControl = 1
	muxProtoSetup   = 2
	muxProtoTCP     = 6
	muxMagic        = 0xfeedface
	muxMRU          = 65536 // largest packet accepted from the phone
	muxReadSize     = 16384 // one IN transfer, as usbmuxd reads (USB_MRU)
	muxChunk        = 16384 // largest TCP payload sent in one packet
	muxWindow       = 131072

	thFIN = 0x01
	thSYN = 0x02
	thRST = 0x04
	thACK = 0x10

	lockdownPort = 62078
)

// muxPipe is the usbmux interface's bulk endpoint pair.
type muxPipe interface {
	write(b []byte, zlp bool) error
	read(buf []byte, timeoutMS uint32) (int, error)
}

func muxHeaderLen(version int) int {
	if version >= 2 {
		return 16
	}
	return 8
}

// encodeMux builds one usbmux packet.
func encodeMux(version int, proto uint32, txSeq, rxSeq uint16, payload []byte) []byte {
	h := muxHeaderLen(version)
	b := make([]byte, h+len(payload))
	binary.BigEndian.PutUint32(b[0:], proto)
	binary.BigEndian.PutUint32(b[4:], uint32(len(b)))
	if version >= 2 {
		binary.BigEndian.PutUint32(b[8:], muxMagic)
		binary.BigEndian.PutUint16(b[12:], txSeq)
		binary.BigEndian.PutUint16(b[14:], rxSeq)
	}
	copy(b[h:], payload)
	return b
}

// tcpHdr is the part of struct tcphdr usbmux uses.
type tcpHdr struct {
	sport, dport uint16
	seq, ack     uint32
	flags        byte
	window       uint16 // bytes >> 8
}

func (h tcpHdr) encode(payload []byte) []byte {
	b := make([]byte, 20+len(payload))
	binary.BigEndian.PutUint16(b[0:], h.sport)
	binary.BigEndian.PutUint16(b[2:], h.dport)
	binary.BigEndian.PutUint32(b[4:], h.seq)
	binary.BigEndian.PutUint32(b[8:], h.ack)
	b[12] = 5 << 4 // data offset: 5 words
	b[13] = h.flags
	binary.BigEndian.PutUint16(b[14:], h.window)
	copy(b[20:], payload)
	return b
}

func parseTCPHdr(b []byte) (tcpHdr, []byte, bool) {
	if len(b) < 20 {
		return tcpHdr{}, nil, false
	}
	h := tcpHdr{sport: binary.BigEndian.Uint16(b[0:]), dport: binary.BigEndian.Uint16(b[2:]),
		seq: binary.BigEndian.Uint32(b[4:]), ack: binary.BigEndian.Uint32(b[8:]),
		flags: b[13], window: binary.BigEndian.Uint16(b[14:])}
	off := int(b[12]>>4) * 4
	if off < 20 || off > len(b) {
		return tcpHdr{}, nil, false
	}
	return h, b[off:], true
}

// usbMux is the host side of one phone's usbmux interface.
type usbMux struct {
	p       muxPipe
	version int

	wmu          sync.Mutex
	txSeq, rxSeq uint16

	mu       sync.Mutex
	conns    map[uint16]*muxConn
	nextPort uint16

	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
	err      error
}

var errMuxClosed = errors.New("usbmux closed")

// newUSBMux runs the version exchange and, for a v2 phone, the setup
// packet, then reads the interface until Close.
func newUSBMux(p muxPipe) (*usbMux, error) {
	m := &usbMux{p: p, conns: map[uint16]*muxConn{}, nextPort: 1,
		stop: make(chan struct{}), done: make(chan struct{})}
	if err := m.send(muxProtoVersion, putBE32(2, 0, 0)); err != nil {
		return nil, fmt.Errorf("usbmux version: %w", err)
	}
	buf := make([]byte, muxReadSize)
	deadline := time.Now().Add(5 * time.Second)
	for m.version == 0 {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("usbmux: no version reply")
		}
		n, err := p.read(buf, 1000)
		if err != nil {
			if isUSBTimeout(err) {
				continue
			}
			return nil, fmt.Errorf("usbmux version: %w", err)
		}
		// The reply has the v1 header; anything else is left over from an
		// earlier session.
		if n >= 20 && binary.BigEndian.Uint32(buf) == muxProtoVersion && int(binary.BigEndian.Uint32(buf[4:])) == n {
			major := binary.BigEndian.Uint32(buf[8:])
			if major != 1 && major != 2 {
				return nil, fmt.Errorf("usbmux: phone speaks version %d", major)
			}
			m.version = int(major)
		}
	}
	if m.version >= 2 {
		if err := m.send(muxProtoSetup, []byte{0x07}); err != nil {
			return nil, fmt.Errorf("usbmux setup: %w", err)
		}
	}
	go m.reader()
	return m, nil
}

func putBE32(v ...uint32) []byte {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.BigEndian.PutUint32(b[4*i:], x)
	}
	return b
}

// send writes one packet. The v2 sequence numbers restart at the setup
// packet.
func (m *usbMux) send(proto uint32, payload []byte) error {
	m.wmu.Lock()
	defer m.wmu.Unlock()
	if m.version >= 2 && proto == muxProtoSetup {
		m.txSeq, m.rxSeq = 0, 0xffff
	}
	pkt := encodeMux(m.version, proto, m.txSeq, m.rxSeq, payload)
	if m.version >= 2 {
		m.txSeq++
	}
	return m.p.write(pkt, true)
}

func (m *usbMux) sendTCP(h tcpHdr, payload []byte) error {
	return m.send(muxProtoTCP, h.encode(payload))
}

// Close resets every connection and stops reading.
func (m *usbMux) Close() {
	m.mu.Lock()
	conns := make([]*muxConn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
	m.stopOnce.Do(func() { close(m.stop) })
	<-m.done
}

// Err is why the reader stopped, once Done is closed.
func (m *usbMux) Done() <-chan struct{} { return m.done }
func (m *usbMux) Err() error            { return m.err }

func (m *usbMux) reader() {
	defer close(m.done)
	buf := make([]byte, muxReadSize)
	var stream []byte
	for {
		select {
		case <-m.stop:
			m.err = errMuxClosed
			m.closeAll(m.err)
			return
		default:
		}
		n, err := m.p.read(buf, 500)
		if err != nil {
			if isUSBTimeout(err) {
				continue
			}
			m.err = err
			m.closeAll(err)
			return
		}
		stream = append(stream, buf[:n]...)
		stream = m.dispatch(stream)
	}
}

// dispatch handles every whole packet at the front of stream and returns
// the rest. A packet may span transfers, and a transfer may hold several.
func (m *usbMux) dispatch(stream []byte) []byte {
	h := muxHeaderLen(m.version)
	for len(stream) >= 8 {
		l := int(binary.BigEndian.Uint32(stream[4:]))
		if l < h || l > muxMRU {
			return nil // out of step: drop what is buffered
		}
		if len(stream) < l {
			break
		}
		pkt := stream[:l]
		if m.version >= 2 {
			m.wmu.Lock()
			m.rxSeq = binary.BigEndian.Uint16(pkt[14:])
			m.wmu.Unlock()
		}
		switch binary.BigEndian.Uint32(pkt) {
		case muxProtoTCP:
			if th, payload, ok := parseTCPHdr(pkt[h:]); ok {
				m.tcpInput(th, payload)
			}
		case muxProtoControl:
			if p := pkt[h:]; len(p) > 1 && (p[0] == 3 || p[0] == 5) {
				logf("iPhone usbmux: %s", p[1:])
			}
		}
		stream = stream[l:]
	}
	return append([]byte(nil), stream...)
}

func (m *usbMux) tcpInput(th tcpHdr, payload []byte) {
	m.mu.Lock()
	c := m.conns[th.dport]
	m.mu.Unlock()
	if c == nil || c.dport != th.sport {
		if th.flags&thRST == 0 {
			m.sendTCP(tcpHdr{sport: th.dport, dport: th.sport, ack: th.seq, flags: thRST}, nil)
		}
		return
	}
	c.input(th, payload)
}

func (m *usbMux) closeAll(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.conns {
		c.shut(err)
	}
}

// Dial opens a connection to port on the phone.
func (m *usbMux) Dial(port uint16, timeout time.Duration) (*muxConn, error) {
	m.mu.Lock()
	sport := m.nextPort
	for m.conns[sport] != nil || sport == 0 {
		sport++
	}
	m.nextPort = sport + 1
	c := &muxConn{m: m, sport: sport, dport: port, estab: make(chan error, 1),
		notify: make(chan struct{}, 1)}
	m.conns[sport] = c
	m.mu.Unlock()
	if err := m.sendTCP(tcpHdr{sport: sport, dport: port, flags: thSYN, window: muxWindow >> 8}, nil); err != nil {
		c.forget()
		return nil, err
	}
	select {
	case err := <-c.estab:
		if err != nil {
			c.forget()
			return nil, err
		}
		return c, nil
	case <-m.done:
		c.forget()
		return nil, m.err
	case <-time.After(timeout):
		c.forget()
		return nil, fmt.Errorf("usbmux: port %d: no answer", port)
	}
}

// muxConn is one connection, a net.Conn for the lockdown client and its
// TLS session.
type muxConn struct {
	m            *usbMux
	sport, dport uint16

	mu        sync.Mutex
	connected bool
	txSeq     uint32 // next byte we send
	txAck     uint32 // next byte we expect
	buf       []byte
	err       error // set once the connection has ended
	deadline  time.Time
	estab     chan error
	notify    chan struct{}
}

func (c *muxConn) input(th tcpHdr, payload []byte) {
	c.mu.Lock()
	if !c.connected {
		if th.flags != thSYN|thACK {
			c.mu.Unlock()
			c.estab <- fmt.Errorf("usbmux: port %d refused", c.dport)
			return
		}
		c.connected = true
		c.txSeq++
		c.txAck = th.seq + 1
		h := c.header(thACK)
		c.mu.Unlock()
		c.m.sendTCP(h, nil)
		c.estab <- nil
		return
	}
	if th.flags != thACK {
		c.mu.Unlock()
		c.shut(io.EOF)
		c.forget()
		return
	}
	if len(payload) == 0 {
		c.mu.Unlock()
		return
	}
	c.buf = append(c.buf, payload...)
	c.txAck += uint32(len(payload))
	h := c.header(thACK)
	c.mu.Unlock()
	c.wake()
	c.m.sendTCP(h, nil)
}

// header is a segment header from the connection's current state; c.mu
// is held.
func (c *muxConn) header(flags byte) tcpHdr {
	return tcpHdr{sport: c.sport, dport: c.dport, seq: c.txSeq, ack: c.txAck, flags: flags, window: muxWindow >> 8}
}

func (c *muxConn) wake() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *muxConn) shut(err error) {
	c.mu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
	c.wake()
	select {
	case c.estab <- err:
	default:
	}
}

func (c *muxConn) forget() {
	c.m.mu.Lock()
	if c.m.conns[c.sport] == c {
		delete(c.m.conns, c.sport)
	}
	c.m.mu.Unlock()
}

func (c *muxConn) Read(p []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.buf) > 0 {
			n := copy(p, c.buf)
			c.buf = c.buf[n:]
			c.mu.Unlock()
			return n, nil
		}
		if c.err != nil {
			err := c.err
			c.mu.Unlock()
			return 0, err
		}
		dl := c.deadline
		c.mu.Unlock()
		if dl.IsZero() {
			<-c.notify
			continue
		}
		d := time.Until(dl)
		if d <= 0 {
			return 0, timeoutError{}
		}
		t := time.NewTimer(d)
		select {
		case <-c.notify:
			t.Stop()
		case <-t.C:
			return 0, timeoutError{}
		}
	}
}

func (c *muxConn) Write(p []byte) (int, error) {
	sent := 0
	for len(p) > 0 {
		n := len(p)
		if n > muxChunk {
			n = muxChunk
		}
		c.mu.Lock()
		if c.err != nil {
			err := c.err
			c.mu.Unlock()
			return sent, err
		}
		h := c.header(thACK)
		c.txSeq += uint32(n)
		c.mu.Unlock()
		if err := c.m.sendTCP(h, p[:n]); err != nil {
			return sent, err
		}
		sent += n
		p = p[n:]
	}
	return sent, nil
}

// Close resets the connection, as usbmuxd ends every connection.
func (c *muxConn) Close() error {
	c.mu.Lock()
	open := c.err == nil && c.connected
	h := c.header(thRST)
	c.mu.Unlock()
	if open {
		c.m.sendTCP(h, nil)
	}
	c.shut(errMuxClosed)
	c.forget()
	return nil
}

func (c *muxConn) LocalAddr() net.Addr  { return muxAddr(c.sport) }
func (c *muxConn) RemoteAddr() net.Addr { return muxAddr(c.dport) }
func (c *muxConn) SetDeadline(t time.Time) error {
	return c.SetReadDeadline(t)
}
func (c *muxConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.deadline = t
	c.mu.Unlock()
	c.wake()
	return nil
}
func (c *muxConn) SetWriteDeadline(t time.Time) error { return nil }

type muxAddr uint16

func (a muxAddr) Network() string { return "usbmux" }
func (a muxAddr) String() string  { return fmt.Sprintf("usbmux:%d", uint16(a)) }

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
