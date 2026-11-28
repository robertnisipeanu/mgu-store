package main

// usbmux: the protocol an iPhone speaks on its ff/fe/02 interface (what
// usbmuxd runs on a computer), enough to open connections to the phone's
// lockdown service and its notification proxy. Everything is big-endian, as
// usbmuxd's device.c sends it:
//
//	header   protocol, total length; from version 2 on also 0xfeedface and
//	         the transmit and receive sequence numbers (16 bytes)
//	VERSION  (0) major 2, minor 0, padding, with the 8-byte header both ways
//	SETUP    (2) the byte 0x07, sent once the phone answers version 2; it
//	         restarts the sequence numbers
//	TCP      (6) a 20-byte TCP header, then the payload: SYN, SYN|ACK, ACK,
//	         data with ACK, RST; the window is sent shifted right by 8
//
// A connection is a local port the host picks and the phone's service port.
// Each USB transfer carries whole packets; a packet that fills whole USB
// packets is ended by a zero-length packet.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

const (
	muxProtoVersion = 0
	muxProtoSetup   = 2
	muxProtoTCP     = 6
	muxMagic        = 0xfeedface

	tcpSYN = 0x02
	tcpRST = 0x04
	tcpACK = 0x10

	muxWindow     = 131072
	muxReadSize   = 16384
	muxMaxPayload = 3*16384 - 16 - 20
	muxConnectTO  = 5 * time.Second

	// muxConnMaxBuffered: what a connection holds unread at most, the
	// largest lockdown message with its framing and TLS records.
	muxConnMaxBuffered = lockdownMax + 64<<10
)

// muxPipe is the bulk endpoint pair of the phone's usbmux interface
// (usbPipe).
type muxPipe interface {
	write(b []byte, zlp bool) error
	read(buf []byte, timeoutMS uint32) (int, error)
}

// usbMux is the usbmux session on one open device's ff/fe/02 interface.
type usbMux struct {
	p muxPipe

	mu           sync.Mutex // writes, sequence numbers, connections
	v2           bool
	txSeq, rxSeq uint16
	nextPort     uint16
	conns        map[uint16]*muxConn

	ready    chan struct{} // closed once the phone answered VERSION
	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{} // closed when the reader ends
	err      error
}

// openMux starts usbmux on the pipe: it sends VERSION and waits for the
// answer.
func openMux(p muxPipe) (*usbMux, error) {
	m := &usbMux{p: p, nextPort: 1, conns: map[uint16]*muxConn{},
		ready: make(chan struct{}), stop: make(chan struct{}), done: make(chan struct{})}
	go m.reader()
	if err := m.send(muxProtoVersion, []byte{0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}, nil); err != nil {
		m.Close()
		return nil, fmt.Errorf("usbmux version: %w", err)
	}
	select {
	case <-m.ready:
		return m, nil
	case <-m.done:
		return nil, fmt.Errorf("usbmux: %v", m.err)
	case <-time.After(muxConnectTO):
		m.Close()
		return nil, errors.New("usbmux: the phone did not answer")
	}
}

// Close ends every connection and the reader.
func (m *usbMux) Close() {
	m.stopOnce.Do(func() { close(m.stop) })
	<-m.done
}

// send writes one packet: the header, hdr (VERSION's or TCP's) and data.
func (m *usbMux) send(proto uint32, hdr, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	hl := 8
	if m.v2 {
		hl = 16
	}
	b := make([]byte, hl+len(hdr)+len(data))
	binary.BigEndian.PutUint32(b, proto)
	binary.BigEndian.PutUint32(b[4:], uint32(len(b)))
	if m.v2 {
		if proto == muxProtoSetup {
			m.txSeq, m.rxSeq = 0, 0xffff
		}
		binary.BigEndian.PutUint32(b[8:], muxMagic)
		binary.BigEndian.PutUint16(b[12:], m.txSeq)
		binary.BigEndian.PutUint16(b[14:], m.rxSeq)
		m.txSeq++
	}
	copy(b[hl:], hdr)
	copy(b[hl+len(hdr):], data)
	return m.p.write(b, true)
}

// reader reads transfers, splits them into packets by their length field
// and hands them to input.
func (m *usbMux) reader() {
	defer close(m.done)
	defer m.closeConns()
	buf := make([]byte, muxReadSize)
	var pending []byte
	for {
		select {
		case <-m.stop:
			m.err = errors.New("closed")
			return
		default:
		}
		n, err := m.p.read(buf, 500)
		if err != nil {
			if isUSBTimeout(err) {
				continue
			}
			m.err = err
			return
		}
		pending = append(pending, buf[:n]...)
		for len(pending) >= 8 {
			l := int(binary.BigEndian.Uint32(pending[4:]))
			if l < 8 || l > 4*muxReadSize {
				pending = nil // lost framing: start again at the next transfer
				break
			}
			if len(pending) < l {
				break
			}
			if err := m.input(pending[:l]); err != nil {
				m.err = err
				return
			}
			pending = pending[l:]
		}
	}
}

func (m *usbMux) input(pkt []byte) error {
	m.mu.Lock()
	hl := 8
	if m.v2 {
		hl = 16
		if len(pkt) >= 16 {
			m.rxSeq = binary.BigEndian.Uint16(pkt[14:])
		}
	}
	m.mu.Unlock()
	if len(pkt) < hl {
		return nil
	}
	body := pkt[hl:]
	switch binary.BigEndian.Uint32(pkt) {
	case muxProtoVersion:
		if len(body) < 12 {
			return errors.New("short VERSION answer")
		}
		select {
		case <-m.ready:
			return nil
		default:
		}
		major := binary.BigEndian.Uint32(body)
		if major != 1 && major != 2 {
			return fmt.Errorf("usbmux version %d is not supported", major)
		}
		if major == 2 {
			m.mu.Lock()
			m.v2 = true
			m.mu.Unlock()
			if err := m.send(muxProtoSetup, nil, []byte{0x07}); err != nil {
				return err
			}
		}
		close(m.ready)
	case muxProtoTCP:
		if len(body) < 20 {
			return nil
		}
		port := binary.BigEndian.Uint16(body[2:]) // the phone's destination: our port
		m.mu.Lock()
		c := m.conns[port]
		m.mu.Unlock()
		if c != nil {
			c.input(body[13], body[20:])
		}
	}
	return nil // CONTROL and others carry log text
}

func (m *usbMux) closeConns() {
	m.mu.Lock()
	conns := m.conns
	m.conns = map[uint16]*muxConn{}
	m.mu.Unlock()
	for _, c := range conns {
		c.fail(errors.New("usbmux closed"))
	}
}

// Dial opens a connection to the phone's port.
func (m *usbMux) Dial(port uint16) (*muxConn, error) {
	m.mu.Lock()
	c := &muxConn{m: m, lport: m.nextPort, rport: port, established: make(chan error, 1),
		closed: make(chan struct{}), wake: make(chan struct{}, 1)}
	m.nextPort++
	m.conns[c.lport] = c
	m.mu.Unlock()
	if err := c.sendTCP(tcpSYN, nil); err != nil {
		c.Close()
		return nil, err
	}
	select {
	case err := <-c.established:
		if err != nil {
			c.Close()
			return nil, err
		}
		return c, nil
	case <-time.After(muxConnectTO):
		c.Close()
		return nil, fmt.Errorf("usbmux: port %d did not answer", port)
	}
}

// muxConn is one connection, a net.Conn for the lockdown session's TLS.
type muxConn struct {
	m            *usbMux
	lport, rport uint16

	mu           sync.Mutex
	txSeq, txAck uint32
	connected    bool
	rbuf         []byte
	err          error
	deadline     time.Time
	established  chan error
	closed       chan struct{}
	closeOnce    sync.Once
	wake         chan struct{}
}

func (c *muxConn) sendTCP(flags byte, data []byte) error {
	c.mu.Lock()
	th := make([]byte, 20)
	binary.BigEndian.PutUint16(th, c.lport)
	binary.BigEndian.PutUint16(th[2:], c.rport)
	binary.BigEndian.PutUint32(th[4:], c.txSeq)
	binary.BigEndian.PutUint32(th[8:], c.txAck)
	th[12] = 5 << 4 // data offset: 20 bytes
	th[13] = flags
	binary.BigEndian.PutUint16(th[14:], muxWindow>>8)
	c.txSeq += uint32(len(data))
	c.mu.Unlock()
	return c.m.send(muxProtoTCP, th, data)
}

// input handles one TCP packet for this connection, as usbmuxd does: the
// SYN|ACK completes the connect, data is acknowledged at once, anything
// else ends the connection.
func (c *muxConn) input(flags byte, payload []byte) {
	c.mu.Lock()
	connected := c.connected
	c.mu.Unlock()
	if !connected {
		if flags != tcpSYN|tcpACK {
			c.settle(fmt.Errorf("usbmux: port %d refused the connection", c.rport))
			return
		}
		c.mu.Lock()
		c.txSeq++
		c.txAck++
		c.connected = true
		c.mu.Unlock()
		c.settle(c.sendTCP(tcpACK, nil))
		return
	}
	if flags != tcpACK {
		c.fail(fmt.Errorf("usbmux: port %d reset the connection", c.rport))
		return
	}
	if len(payload) == 0 {
		return
	}
	c.mu.Lock()
	if len(c.rbuf)+len(payload) > muxConnMaxBuffered {
		c.mu.Unlock()
		c.fail(fmt.Errorf("usbmux: port %d sent more than %d bytes unread", c.rport, muxConnMaxBuffered))
		return
	}
	c.txAck += uint32(len(payload))
	c.rbuf = append(c.rbuf, payload...)
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	c.sendTCP(tcpACK, nil)
}

func (c *muxConn) fail(err error) {
	c.mu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closed) })
	c.settle(err)
}

// settle reports the outcome of the connect once; later outcomes are dropped.
func (c *muxConn) settle(err error) {
	select {
	case c.established <- err:
	default:
	}
}

func (c *muxConn) Read(b []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.rbuf) > 0 {
			n := copy(b, c.rbuf)
			c.rbuf = c.rbuf[n:]
			c.mu.Unlock()
			return n, nil
		}
		err, deadline := c.err, c.deadline
		c.mu.Unlock()
		if err != nil {
			return 0, err
		}
		var t *time.Timer
		var timeout <-chan time.Time
		if !deadline.IsZero() {
			d := time.Until(deadline)
			if d <= 0 {
				return 0, errMuxTimeout
			}
			t = time.NewTimer(d)
			timeout = t.C
		}
		select {
		case <-c.wake:
		case <-c.closed:
		case <-timeout:
			return 0, errMuxTimeout
		}
		if t != nil && !t.Stop() {
			select {
			case <-t.C:
			default:
			}
		}
	}
}

func (c *muxConn) Write(b []byte) (int, error) {
	for off := 0; off < len(b); off += muxMaxPayload {
		c.mu.Lock()
		err := c.err
		c.mu.Unlock()
		if err != nil {
			return off, err
		}
		end := min(off+muxMaxPayload, len(b))
		if err := c.sendTCP(tcpACK, b[off:end]); err != nil {
			return off, err
		}
	}
	return len(b), nil
}

// Close resets the connection on the phone and forgets it.
func (c *muxConn) Close() error {
	c.mu.Lock()
	open := c.err == nil
	c.mu.Unlock()
	if open {
		c.sendTCP(tcpRST, nil)
	}
	c.fail(errors.New("closed"))
	c.m.mu.Lock()
	delete(c.m.conns, c.lport)
	c.m.mu.Unlock()
	return nil
}

var errMuxTimeout = &muxTimeout{}

type muxTimeout struct{}

func (*muxTimeout) Error() string   { return "usbmux: timed out" }
func (*muxTimeout) Timeout() bool   { return true }
func (*muxTimeout) Temporary() bool { return true }

type muxAddr struct{}

func (muxAddr) Network() string { return "usbmux" }
func (muxAddr) String() string  { return "usbmux" }

func (c *muxConn) LocalAddr() net.Addr  { return muxAddr{} }
func (c *muxConn) RemoteAddr() net.Addr { return muxAddr{} }
func (c *muxConn) SetDeadline(t time.Time) error {
	return c.SetReadDeadline(t)
}
func (c *muxConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.deadline = t
	c.mu.Unlock()
	return nil
}
func (c *muxConn) SetWriteDeadline(time.Time) error { return nil }
