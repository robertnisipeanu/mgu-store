package main

// fakePhone is the phone side of usbmux and lockdown as this package
// understands them, for the unit tests and the gadget test
// (gadget_test.go): it answers the version exchange, accepts usbmux
// connections to lockdownd, answers QueryType and GetValue, shows a Trust
// prompt for a number of Pair rounds before accepting (or declines), and
// runs StartSession with the TLS switch, requiring the paired host
// certificate. It checks the pair record it is offered: the device
// certificate holds its own public key, and both leaf certificates are
// signed by the root.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"
	"time"
)

// fakeTrust is what a phone remembers across attachments.
type fakeTrust struct {
	mu       sync.Mutex
	key      *rsa.PrivateKey
	udid     string
	hostID   string
	hostCert []byte // PEM
	devCert  []byte // PEM
}

func newFakeTrust(udid string) *fakeTrust {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &fakeTrust{key: k, udid: udid}
}

type fakePhone struct {
	trust   *fakeTrust
	prompts int  // Pair rounds answered PairingDialogResponsePending
	deny    bool // the owner declines
	logf    func(string, ...interface{})

	mu        sync.Mutex
	version   int
	toHost    chan []byte
	conns     map[uint16]*fakeConn
	pairs     int  // Pair requests seen
	sessions  int  // sessions started
	trusted   bool // a session has started on this attachment
	gone      bool
	lastError string
}

type fakeConn struct {
	hostPort uint16
	seq      uint32 // next byte the phone sends
	in       chan []byte
	muxEnd   net.Conn
}

func newFakePhone(trust *fakeTrust) *fakePhone {
	return &fakePhone{trust: trust, toHost: make(chan []byte, 256), conns: map[uint16]*fakeConn{},
		logf: func(string, ...interface{}) {}}
}

func (p *fakePhone) Trusted() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.trusted
}

func (p *fakePhone) send(proto uint32, payload []byte) {
	p.mu.Lock()
	v := p.version
	p.mu.Unlock()
	if proto == muxProtoVersion {
		v = 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.gone {
		p.toHost <- encodeMux(v, proto, 0, 0, payload)
	}
}

// fromHost takes one packet the host wrote (a zero-length one ends a
// transfer and carries nothing).
func (p *fakePhone) fromHost(b []byte) {
	if len(b) < 8 {
		return
	}
	proto, l := binary.BigEndian.Uint32(b), int(binary.BigEndian.Uint32(b[4:]))
	if l != len(b) {
		p.logf("fake phone: packet length %d in a %d-byte transfer", l, len(b))
		return
	}
	p.mu.Lock()
	h := muxHeaderLen(p.version)
	p.mu.Unlock()
	switch proto {
	case muxProtoVersion:
		if len(b) < 8+12 || binary.BigEndian.Uint32(b[8:]) != 2 {
			return
		}
		p.mu.Lock()
		p.version = 2
		p.mu.Unlock()
		p.send(muxProtoVersion, putBE32(2, 0, 0))
	case muxProtoSetup:
	case muxProtoTCP:
		if len(b) < h || binary.BigEndian.Uint32(b[8:]) != muxMagic {
			p.logf("fake phone: TCP packet without the v2 header")
			return
		}
		th, payload, ok := parseTCPHdr(b[h:])
		if ok {
			p.tcp(th, payload)
		}
	}
}

func (p *fakePhone) tcp(th tcpHdr, payload []byte) {
	p.mu.Lock()
	c := p.conns[th.sport]
	p.mu.Unlock()
	switch {
	case th.flags == thSYN:
		if th.dport != lockdownPort || c != nil {
			p.send(muxProtoTCP, tcpHdr{sport: th.dport, dport: th.sport, flags: thRST}.encode(nil))
			return
		}
		phoneEnd, muxEnd := net.Pipe()
		c = &fakeConn{hostPort: th.sport, seq: 1, in: make(chan []byte, 64), muxEnd: muxEnd}
		p.mu.Lock()
		p.conns[th.sport] = c
		p.mu.Unlock()
		p.send(muxProtoTCP, tcpHdr{sport: lockdownPort, dport: th.sport, flags: thSYN | thACK, window: 512}.encode(nil))
		go func() { // host -> lockdownd
			for b := range c.in {
				if _, err := muxEnd.Write(b); err != nil {
					return
				}
			}
			muxEnd.Close()
		}()
		go func() { // lockdownd -> host
			buf := make([]byte, 16384)
			for {
				n, err := muxEnd.Read(buf)
				if err != nil {
					return
				}
				p.send(muxProtoTCP, tcpHdr{sport: lockdownPort, dport: c.hostPort, seq: c.seq, flags: thACK, window: 512}.encode(buf[:n]))
				c.seq += uint32(n)
			}
		}()
		go p.lockdownd(phoneEnd)
	case c == nil:
	case th.flags&thRST != 0:
		p.mu.Lock()
		delete(p.conns, th.sport)
		p.mu.Unlock()
		close(c.in)
	case len(payload) > 0:
		c.in <- append([]byte{}, payload...)
	}
}

func (p *fakePhone) fail(code string) map[string]interface{} {
	p.mu.Lock()
	p.lastError = code
	p.mu.Unlock()
	return map[string]interface{}{"Error": code}
}

// lockdownd serves one connection.
func (p *fakePhone) lockdownd(conn net.Conn) {
	defer conn.Close()
	t := p.trust
	for {
		req, err := readPlistMessage(conn)
		if err != nil {
			return
		}
		r, _ := req["Request"].(string)
		resp := map[string]interface{}{"Request": r}
		switch r {
		case "QueryType":
			resp["Type"] = "com.apple.mobile.lockdown"
		case "GetValue":
			switch req["Key"] {
			case "UniqueDeviceID":
				resp["Value"] = t.udid
			case "DevicePublicKey":
				resp["Value"] = pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&t.key.PublicKey)})
			default:
				resp = p.fail("MissingValue")
			}
		case "SetValue":
		case "Pair":
			resp = p.pair(req)
		case "StartSession":
			t.mu.Lock()
			known := t.hostID != "" && req["HostID"] == t.hostID
			hostCert, devCert := t.hostCert, t.devCert
			t.mu.Unlock()
			if !known {
				resp = p.fail("InvalidHostID")
				break
			}
			resp["SessionID"] = "FAKE-SESSION"
			resp["EnableSessionSSL"] = true
			if err := writePlistMessage(conn, resp); err != nil {
				return
			}
			tc, err := p.tlsServer(conn, hostCert, devCert)
			if err != nil {
				p.logf("fake phone: TLS: %v", err)
				return
			}
			conn = tc
			p.mu.Lock()
			p.sessions++
			p.trusted = true
			p.mu.Unlock()
			continue
		case "StopSession":
		default:
			resp = p.fail("InvalidRequest")
		}
		if err := writePlistMessage(conn, resp); err != nil {
			return
		}
	}
}

func (p *fakePhone) pair(req map[string]interface{}) map[string]interface{} {
	p.mu.Lock()
	p.pairs++
	round := p.pairs
	p.mu.Unlock()
	rec, _ := req["PairRecord"].(map[string]interface{})
	if req["ProtocolVersion"] != "2" || rec == nil {
		return p.fail("InvalidPairRecord")
	}
	root, _ := rec["RootCertificate"].([]byte)
	host, _ := rec["HostCertificate"].([]byte)
	dev, _ := rec["DeviceCertificate"].([]byte)
	hostID, _ := rec["HostID"].(string)
	if _, ok := rec["SystemBUID"].(string); !ok || hostID == "" {
		return p.fail("InvalidPairRecord")
	}
	if err := checkChain(root, host, dev, &p.trust.key.PublicKey); err != nil {
		p.logf("fake phone: pair record: %v", err)
		return p.fail("InvalidPairRecord")
	}
	if round <= p.prompts {
		return p.fail("PairingDialogResponsePending")
	}
	if p.deny {
		return p.fail("UserDeniedPairing")
	}
	t := p.trust
	t.mu.Lock()
	t.hostID, t.hostCert, t.devCert = hostID, host, dev
	t.mu.Unlock()
	return map[string]interface{}{"Request": "Pair", "EscrowBag": []byte("escrow")}
}

func parsePEMCert(b []byte) (*x509.Certificate, error) {
	blk, _ := pem.Decode(b)
	if blk == nil || blk.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("not a PEM certificate")
	}
	return x509.ParseCertificate(blk.Bytes)
}

func checkChain(rootPEM, hostPEM, devPEM []byte, devKey *rsa.PublicKey) error {
	root, err := parsePEMCert(rootPEM)
	if err != nil {
		return fmt.Errorf("root: %v", err)
	}
	if !root.IsCA {
		return fmt.Errorf("root is not a CA")
	}
	for name, b := range map[string][]byte{"host": hostPEM, "device": devPEM} {
		c, err := parsePEMCert(b)
		if err != nil {
			return fmt.Errorf("%s: %v", name, err)
		}
		if err := c.CheckSignatureFrom(root); err != nil {
			return fmt.Errorf("%s: %v", name, err)
		}
		if name == "device" {
			k, ok := c.PublicKey.(*rsa.PublicKey)
			if !ok || k.N.Cmp(devKey.N) != 0 {
				return fmt.Errorf("device certificate does not hold the device key")
			}
		}
	}
	return nil
}

// tlsServer switches conn to TLS with the device certificate, requiring
// the paired host certificate from the host.
func (p *fakePhone) tlsServer(conn net.Conn, hostPEM, devPEM []byte) (net.Conn, error) {
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(p.trust.key)})
	cert, err := tls.X509KeyPair(devPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	hostCert, err := parsePEMCert(hostPEM)
	if err != nil {
		return nil, err
	}
	tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAnyClientCert,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 || string(raw[0]) != string(hostCert.Raw) {
				return fmt.Errorf("host certificate is not the paired one")
			}
			return nil
		}})
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	err = tc.Handshake()
	conn.SetDeadline(time.Time{})
	return tc, err
}

// unplug ends the attachment: reads on the host side fail as for a
// device that left.
func (p *fakePhone) unplug() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.gone {
		p.gone = true
		close(p.toHost)
	}
}

// fakeMuxPipe is the host's view of the phone's usbmux endpoints.
type fakeMuxPipe struct {
	p       *fakePhone
	pending []byte
}

func (f *fakeMuxPipe) write(b []byte, zlp bool) error {
	f.p.mu.Lock()
	gone := f.p.gone
	f.p.mu.Unlock()
	if gone {
		return syscall.ENODEV
	}
	f.p.fromHost(append([]byte{}, b...))
	return nil
}

func (f *fakeMuxPipe) read(buf []byte, timeoutMS uint32) (int, error) {
	if len(f.pending) == 0 {
		select {
		case b, ok := <-f.p.toHost:
			if !ok {
				return 0, syscall.ENODEV
			}
			f.pending = b
		case <-time.After(time.Duration(timeoutMS) * time.Millisecond):
			return 0, syscall.ETIMEDOUT
		}
	}
	n := copy(buf, f.pending)
	f.pending = f.pending[n:]
	return n, nil
}

var _ io.Closer = (*muxConn)(nil)
