package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestPlistRoundTrip(t *testing.T) {
	in := map[string]any{
		"Request": "Pair", "ProtocolVersion": "2", "Flag": true, "Off": false,
		"Data": []byte{0, 1, 2, 0xff}, "Esc": "a<b>&c",
		"PairRecord": map[string]any{"HostID": "ABC"},
	}
	doc, err := plistEncode(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := plistDecode(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round trip:\n%v\n%v", in, out)
	}
	// What lockdown sends: the whitespace and line breaks of a pretty plist.
	v, err := plistDecode([]byte("<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>Value</key>\n\t<data>\n\tAAEC\n\t/w==\n\t</data>\n</dict>\n</plist>\n"))
	if err != nil || !bytes.Equal(v.(map[string]any)["Value"].([]byte), []byte{0, 1, 2, 0xff}) {
		t.Fatalf("pretty data: %v %v", v, err)
	}
	// Integers and arrays only come from the phone.
	v, err = plistDecode([]byte(`<plist><dict><key>Port</key><integer> 62078 </integer><key>L</key><array><string>x</string><integer>1</integer></array></dict></plist>`))
	if err != nil || !reflect.DeepEqual(v, map[string]any{"Port": int64(62078), "L": []any{"x", int64(1)}}) {
		t.Fatalf("integer and array: %v %v", v, err)
	}
	if _, err := plistEncode(map[string]any{"Port": 1}); err == nil {
		t.Fatal("encoded a type no request carries")
	}
	if _, err := plistDecode([]byte("bplist00")); err == nil {
		t.Fatal("binary plist accepted")
	}
}

func TestHostIdentity(t *testing.T) {
	dir := t.TempDir()
	id, err := loadHostIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(hostIdentityFile(dir)); err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("host.json: %v %v", fi, err)
	}
	again, err := loadHostIdentity(dir)
	if err != nil || *again != *id {
		t.Fatal("the identity is not kept")
	}
	root, _, err := id.root()
	if err != nil || !root.IsCA {
		t.Fatalf("root: %v", err)
	}
	host := mustCert(t, []byte(id.HostCertificate))
	if err := host.CheckSignatureFrom(root); err != nil || host.IsCA || host.KeyUsage != x509.KeyUsageDigitalSignature|x509.KeyUsageKeyEncipherment {
		t.Fatalf("host certificate: %v %+v", err, host.KeyUsage)
	}
	if _, err := tls.X509KeyPair([]byte(id.HostCertificate), []byte(id.HostPrivateKey)); err != nil {
		t.Fatal(err)
	}
	devKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	devPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&devKey.PublicKey)})
	dc, err := id.deviceCertificate(devPEM)
	if err != nil {
		t.Fatal(err)
	}
	dev := mustCert(t, dc)
	if dev.CheckSignatureFrom(root) != nil || !dev.PublicKey.(*rsa.PublicKey).Equal(&devKey.PublicKey) || len(dev.SubjectKeyId) != 20 {
		t.Fatal("device certificate does not carry the phone's key under the root")
	}
	// A damaged file is replaced by a new identity.
	writeFile(t, hostIdentityFile(dir), "{")
	if n, err := loadHostIdentity(dir); err != nil || n.HostID == id.HostID {
		t.Fatalf("damaged identity: %v", err)
	}
}

func mustCert(t *testing.T, p []byte) *x509.Certificate {
	b, _ := pem.Decode(p)
	if b == nil {
		t.Fatal("no PEM")
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// The pairing flow against a fake iPhone speaking usbmux, lockdown (with
// TLS after StartSession) and the notification proxy: an unpaired phone
// shows Trust, pairs once its owner taps it, and is trusted with a session;
// the next connection needs no Trust; a phone that forgot the unit pairs
// again.
func TestIPhoneTrust(t *testing.T) {
	dir := t.TempDir()
	phone := newFakePhone(t)
	var mu sync.Mutex
	var notes []string
	note := func(s string) {
		mu.Lock()
		notes = append(notes, s)
		mu.Unlock()
		if s == trustTapNote {
			go phone.tap()
		}
	}
	trust := func() error {
		m, err := openMux(phone.pipe())
		if err != nil {
			return err
		}
		defer m.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return iphoneTrust(ctx, m, dir, note)
	}
	if err := trust(); err != nil {
		t.Fatal(err)
	}
	id, _ := loadHostIdentity(dir)
	if phone.pairedHost() != id.HostID || phone.sessions() != 1 || phone.pairs() != 2 {
		t.Fatalf("first connection: paired %q sessions %d pairs %d", phone.pairedHost(), phone.sessions(), phone.pairs())
	}
	if want := []string{trustTapNote, ""}; !reflect.DeepEqual(notes, want) {
		t.Fatalf("notes %q, want %q", notes, want)
	}
	notes = nil
	if err := trust(); err != nil || phone.sessions() != 2 || phone.pairs() != 2 || notes != nil {
		t.Fatalf("second connection: %v, sessions %d, pairs %d, notes %q", err, phone.sessions(), phone.pairs(), notes)
	}
	phone.forget()
	if err := trust(); err != nil || phone.pairedHost() != id.HostID || phone.sessions() != 3 {
		t.Fatalf("after the phone forgot: %v", err)
	}
}

// fakePhone is the phone's side of usbmux on one interface.
type fakePhone struct {
	t      *testing.T
	key    *rsa.PrivateKey
	tlsKey tls.Certificate

	mu       sync.Mutex
	out      chan []byte
	v2       bool
	conns    map[uint16]*fakeConn // by the host's port
	tapped   bool
	denied   bool // the owner answered "Don't Trust"
	failSess int  // StartSession requests still to refuse with a transient error
	nVersion int
	host     string // paired HostID
	hostCert []byte
	nSession int
	nPair    int
	watchers []net.Conn
}

func newFakePhone(t *testing.T) *fakePhone {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	return &fakePhone{t: t, key: key, tlsKey: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		out: make(chan []byte, 256), conns: map[uint16]*fakeConn{}}
}

func (p *fakePhone) pairedHost() string { p.mu.Lock(); defer p.mu.Unlock(); return p.host }
func (p *fakePhone) sessions() int      { p.mu.Lock(); defer p.mu.Unlock(); return p.nSession }
func (p *fakePhone) pairs() int         { p.mu.Lock(); defer p.mu.Unlock(); return p.nPair }

func (p *fakePhone) forget() {
	p.mu.Lock()
	p.host, p.hostCert, p.tapped = "", nil, false
	p.mu.Unlock()
}

// tap is the owner tapping Trust and entering the passcode: the phone
// posts request_pair to its watchers.
func (p *fakePhone) tap() {
	time.Sleep(100 * time.Millisecond)
	p.mu.Lock()
	p.tapped = true
	ws := p.watchers
	p.mu.Unlock()
	for _, w := range ws {
		plistSend(w, map[string]any{"Command": "RelayNotification", "Name": notifyRequestPair})
	}
}

// deny is the owner answering "Don't Trust": the next Pair is refused.
func (p *fakePhone) deny() {
	p.mu.Lock()
	p.denied = true
	p.mu.Unlock()
}

// pipe is a fresh connection of the cable: usbmux starts over.
func (p *fakePhone) pipe() muxPipe {
	p.mu.Lock()
	p.v2 = false
	p.mu.Unlock()
	return fakePipe{p}
}

type fakePipe struct{ p *fakePhone }

func (f fakePipe) read(buf []byte, timeoutMS uint32) (int, error) {
	select {
	case b := <-f.p.out:
		return copy(buf, b), nil
	case <-time.After(time.Duration(timeoutMS) * time.Millisecond):
		return 0, syscall.ETIMEDOUT
	}
}

func (f fakePipe) write(b []byte, zlp bool) error {
	p := f.p
	proto := binary.BigEndian.Uint32(b)
	if int(binary.BigEndian.Uint32(b[4:])) != len(b) {
		p.t.Errorf("usbmux length %d for a %d-byte packet", binary.BigEndian.Uint32(b[4:]), len(b))
	}
	p.mu.Lock()
	v2 := p.v2
	p.mu.Unlock()
	switch proto {
	case muxProtoVersion:
		p.mu.Lock()
		p.nVersion++
		p.mu.Unlock()
		if v2 || len(b) != 20 || binary.BigEndian.Uint32(b[8:]) != 2 {
			p.t.Errorf("VERSION % x", b)
		}
		p.send(muxProtoVersion, []byte{0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0})
	case muxProtoSetup:
		if len(b) != 17 || binary.BigEndian.Uint32(b[8:]) != muxMagic || b[16] != 7 {
			p.t.Errorf("SETUP % x", b)
		}
		p.mu.Lock()
		p.v2 = true
		p.mu.Unlock()
	case muxProtoTCP:
		if !v2 || binary.BigEndian.Uint32(b[8:]) != muxMagic {
			p.t.Errorf("TCP before SETUP")
		}
		p.tcp(b[16:36], b[36:])
	}
	return nil
}

// send queues a packet from the phone (16-byte header once in version 2).
func (p *fakePhone) send(proto uint32, body []byte) {
	p.mu.Lock()
	hl := 8
	if p.v2 {
		hl = 16
	}
	p.mu.Unlock()
	b := make([]byte, hl+len(body))
	binary.BigEndian.PutUint32(b, proto)
	binary.BigEndian.PutUint32(b[4:], uint32(len(b)))
	if hl == 16 {
		binary.BigEndian.PutUint32(b[8:], muxMagic)
	}
	copy(b[hl:], body)
	p.out <- b
}

func (p *fakePhone) sendTCP(c *fakeConn, flags byte, data []byte) {
	th := make([]byte, 20)
	binary.BigEndian.PutUint16(th, c.port)
	binary.BigEndian.PutUint16(th[2:], c.hostPort)
	th[12], th[13] = 0x50, flags
	p.send(muxProtoTCP, append(th, data...))
}

type fakeConn struct {
	port, hostPort uint16
	host, phone    net.Conn // a pipe: the host's TCP payload enters at host
	in             chan []byte
}

func (p *fakePhone) tcp(th, data []byte) {
	hostPort, port, flags := binary.BigEndian.Uint16(th), binary.BigEndian.Uint16(th[2:]), th[13]
	p.mu.Lock()
	c := p.conns[hostPort]
	p.mu.Unlock()
	switch {
	case flags == tcpSYN:
		hostEnd, phoneEnd := net.Pipe()
		c = &fakeConn{port: port, hostPort: hostPort, host: hostEnd, phone: phoneEnd, in: make(chan []byte, 64)}
		p.mu.Lock()
		p.conns[hostPort] = c
		p.mu.Unlock()
		p.sendTCP(c, tcpSYN|tcpACK, nil)
		go func() { // the host's bytes, in order, into the pipe
			for b := range c.in {
				hostEnd.Write(b)
			}
		}()
		go func() { // the service's bytes out to the host
			buf := make([]byte, 4096)
			for {
				n, err := hostEnd.Read(buf)
				if err != nil {
					return
				}
				p.sendTCP(c, tcpACK, append([]byte{}, buf[:n]...))
			}
		}()
		go p.serve(c)
	case c == nil:
	case flags&tcpRST != 0:
		p.mu.Lock()
		delete(p.conns, hostPort)
		p.mu.Unlock()
		close(c.in)
		c.phone.Close()
	case len(data) > 0:
		c.in <- append([]byte{}, data...)
	}
}

func (p *fakePhone) serve(c *fakeConn) {
	switch c.port {
	case lockdownPort:
		p.lockdown(c.phone)
	case 4000: // the notification proxy
		for {
			doc, err := plistRecvRaw(c.phone)
			if err != nil {
				return
			}
			if bytes.Contains(doc, []byte("ObserveNotification")) && bytes.Contains(doc, []byte(notifyRequestPair)) {
				p.mu.Lock()
				p.watchers = append(p.watchers, c.phone)
				p.mu.Unlock()
			}
		}
	}
}

func (p *fakePhone) lockdown(conn net.Conn) {
	var rw io.ReadWriter = conn
	for {
		doc, err := plistRecvRaw(rw)
		if err != nil {
			return
		}
		v, err := plistDecode(doc)
		if err != nil {
			p.t.Errorf("lockdown request: %v", err)
			return
		}
		req := v.(map[string]any)
		if req["Label"] != lockdownLabel {
			p.t.Errorf("no Label: %v", req)
		}
		resp, startTLS := p.answer(req)
		resp["Request"] = req["Request"]
		fakePlistSend(rw, resp)
		if startTLS {
			tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{p.tlsKey}, ClientAuth: tls.RequireAnyClientCert})
			if err := tc.Handshake(); err != nil {
				p.t.Errorf("session TLS: %v", err)
				return
			}
			p.mu.Lock()
			ok := bytes.Equal(tc.ConnectionState().PeerCertificates[0].Raw, p.hostCert)
			p.nSession++
			p.mu.Unlock()
			if !ok {
				p.t.Error("session TLS with a certificate other than the paired host's")
			}
			rw = tc
		}
	}
}

func (p *fakePhone) answer(req map[string]any) (map[string]any, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch req["Request"] {
	case "QueryType":
		return map[string]any{"Type": lockdownType}, false
	case "GetValue":
		if req["Key"] == "DevicePublicKey" {
			return map[string]any{"Value": pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY",
				Bytes: x509.MarshalPKCS1PublicKey(&p.key.PublicKey)})}, false
		}
	case "SetValue", "StopSession":
		return map[string]any{}, false
	case "StartService":
		if req["Service"] == notifyProxy {
			return map[string]any{"Port": int64(4000)}, false
		}
	case "StartSession":
		if p.failSess > 0 {
			p.failSess--
			return map[string]any{"Error": "SessionInactive"}, false
		}
		if p.host == "" || req["HostID"] != p.host {
			return map[string]any{"Error": "InvalidHostID"}, false
		}
		return map[string]any{"SessionID": "S1", "EnableSessionSSL": true}, true
	case "Pair":
		p.nPair++
		if p.denied {
			return map[string]any{"Error": "UserDeniedPairing"}, false
		}
		if !p.tapped {
			return map[string]any{"Error": "PairingDialogResponsePending"}, false
		}
		rec := req["PairRecord"].(map[string]any)
		root := mustCertNoT(rec["RootCertificate"].([]byte))
		dev := mustCertNoT(rec["DeviceCertificate"].([]byte))
		host := mustCertNoT(rec["HostCertificate"].([]byte))
		if dev == nil || root == nil || host == nil || dev.CheckSignatureFrom(root) != nil ||
			!dev.PublicKey.(*rsa.PublicKey).Equal(&p.key.PublicKey) || host.CheckSignatureFrom(root) != nil {
			return map[string]any{"Error": "InvalidPairRecord"}, false
		}
		p.host, p.hostCert = rec["HostID"].(string), host.Raw
		return map[string]any{"EscrowBag": []byte{1, 2, 3}}, false
	}
	return map[string]any{"Error": "UnknownRequest"}, false
}

func mustCertNoT(p []byte) *x509.Certificate {
	b, _ := pem.Decode(p)
	if b == nil {
		return nil
	}
	c, _ := x509.ParseCertificate(b.Bytes)
	return c
}

// fakePlistSend is plistSend for the phone's answers, which also carry
// integers (StartService's Port).
func fakePlistSend(w io.Writer, resp map[string]any) error {
	ints := map[string]int64{}
	for k, v := range resp {
		if i, ok := v.(int64); ok {
			ints[k] = i
			resp[k] = fmt.Sprintf("@int%d@", i)
		}
	}
	doc, err := plistEncode(resp)
	if err != nil {
		return err
	}
	for _, i := range ints {
		doc = bytes.ReplaceAll(doc, []byte(fmt.Sprintf("<string>@int%d@</string>", i)), []byte(fmt.Sprintf("<integer>%d</integer>", i)))
	}
	msg := make([]byte, 4+len(doc))
	binary.BigEndian.PutUint32(msg, uint32(len(doc)))
	copy(msg[4:], doc)
	_, err = w.Write(msg)
	return err
}

// "Don't Trust": pairing ends with errTrustDenied after the next Pair
// asks, the phone is not asked again on this connection, and the declined
// phone is left alone until it comes back with a new device number.
func TestIPhoneTrustDenied(t *testing.T) {
	defer func(d time.Duration) { pairRetry = d }(pairRetry)
	pairRetry = 200 * time.Millisecond
	phone := newFakePhone(t)
	m, err := openMux(phone.pipe())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	var notes []string
	note := func(s string) {
		notes = append(notes, s)
		if s == trustTapNote {
			phone.deny()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = iphoneTrustRetrying(ctx, m, t.TempDir(), note, 50*time.Millisecond)
	if !errors.Is(err, errTrustDenied) {
		t.Fatalf("got %v, want errTrustDenied", err)
	}
	if phone.pairs() != 2 || phone.pairedHost() != "" || !reflect.DeepEqual(notes, []string{trustTapNote}) {
		t.Fatalf("pairs %d, paired %q, notes %q", phone.pairs(), phone.pairedHost(), notes)
	}
}

// fakeIPhoneSysfs puts an iPhone at sysBusUSB/1-3.1 with device number dev
// (on its media configuration), or removes it when dev is 0.
func fakeIPhoneSysfs(t *testing.T, dev int) {
	dir := filepath.Join(sysBusUSB, "1-3.1")
	if dev == 0 {
		os.RemoveAll(dir)
		return
	}
	for name, v := range map[string]string{"idVendor": "05ac", "idProduct": "12a8", "busnum": "1",
		"devnum": fmt.Sprint(dev), "bConfigurationValue": "2", "manufacturer": "Apple Inc.", "product": "iPhone"} {
		writeFile(t, filepath.Join(dir, name), v+"\n")
	}
	writeFile(t, filepath.Join(dir, "descriptors"), string(iphoneDesc(true)))
}

func iphoneCandidate(u *scanUplink) (candidate, bool) {
	for _, c := range u.candidates() {
		if c.kind == kindIPhone {
			return c, true
		}
	}
	return candidate{}, false
}

// "Don't Trust" through the link's trust(): the link fails with
// errTrustDenied, the scan then reports the phone busy and does not take
// it, until it is plugged in again (a new device number, or gone from
// sysfs and back).
func TestIPhoneDeclinedNotRetaken(t *testing.T) {
	defer func(d time.Duration, s string) { pairRetry, sysBusUSB = d, s }(pairRetry, sysBusUSB)
	pairRetry, sysBusUSB = 200*time.Millisecond, t.TempDir()
	fakeIPhoneSysfs(t, 9)
	phone := newFakePhone(t)
	go func() { // the owner answers "Don't Trust" once the dialog shows
		for phone.pairs() == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		phone.deny()
	}()
	f := &iphethFramer{sysName: "1-3.1", devnum: 9, mux: phone.pipe(), pairDir: t.TempDir()}
	trusted := make(chan struct{})
	var failed error
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f.trust(ctx, trusted, func(err error) { failed = err })
	if !errors.Is(failed, errTrustDenied) {
		t.Fatalf("link failed with %v, want errTrustDenied", failed)
	}
	u := newScanUplink(defaults())
	for i := 0; i < 2; i++ {
		if c, ok := iphoneCandidate(u); !ok || c.busy != iphoneDeclinedNote {
			t.Fatalf("declined phone: %+v %v", c, ok)
		}
	}
	fakeIPhoneSysfs(t, 10) // plugged in again
	if c, ok := iphoneCandidate(u); !ok || c.busy != "" {
		t.Fatalf("replugged phone: %+v %v", c, ok)
	}
	// Gone from a scan and back under the same number: also plugged in again.
	declineIPhone("1-3.1", 10)
	fakeIPhoneSysfs(t, 0)
	u.candidates()
	fakeIPhoneSysfs(t, 10)
	if c, ok := iphoneCandidate(u); !ok || c.busy != "" {
		t.Fatalf("phone back after leaving: %+v %v", c, ok)
	}
}

// heldLink is a Link that ends only when closed.
type heldLink struct {
	done   chan struct{}
	closed bool
}

func (l *heldLink) Ifname() string        { return Ifname }
func (l *heldLink) Done() <-chan struct{} { return l.done }
func (l *heldLink) Err() error            { return nil }
func (l *heldLink) Close()                { l.closed = true }
func (l *heldLink) String() string        { return "held" }

// With iPhones switched off the scan lists no iPhone, and a link on one
// ends with errIPhoneOff; switched on again, the iPhone is listed.
func TestIPhoneSwitchedOff(t *testing.T) {
	defer func(s string, d time.Duration) { sysBusUSB, preferEvery = s, d }(sysBusUSB, preferEvery)
	sysBusUSB, preferEvery = t.TempDir(), 20*time.Millisecond
	fakeIPhoneSysfs(t, 9)
	c := defaults()
	c.IPhone = false
	u := newScanUplink(c)
	if cand, ok := iphoneCandidate(u); ok {
		t.Fatalf("iPhone listed while switched off: %+v", cand)
	}
	u.setIPhone(true)
	cand, ok := iphoneCandidate(u)
	if !ok {
		t.Fatal("iPhone not listed once switched on")
	}
	l := u.watchPreferred(&heldLink{done: make(chan struct{})}, cand)
	defer l.Close()
	u.setIPhone(false)
	select {
	case <-l.Done():
		if !errors.Is(l.Err(), errIPhoneOff) {
			t.Fatalf("link ended with %v, want errIPhoneOff", l.Err())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the iPhone's link kept running while switched off")
	}
}

// The settings file and the request keep whether an iPhone is taken; a
// value that is not on or off is skipped there.
func TestIPhoneSetting(t *testing.T) {
	dir := t.TempDir()
	conf, settings := filepath.Join(dir, "u.conf"), filepath.Join(dir, "settings.conf")
	writeFile(t, conf, "uplink = auto\niphone = on\nsettings_conf = "+settings+"\n")
	c, err := loadConfig(conf)
	if err != nil || !c.IPhone {
		t.Fatalf("shipped: %v %v", c.IPhone, err)
	}
	if err := setSetting(settings, "iphone", "off"); err != nil {
		t.Fatal(err)
	}
	if c, err = loadConfig(conf); err != nil || c.IPhone || len(c.Skipped) != 0 {
		t.Fatalf("set: %v %v %v", c.IPhone, c.Skipped, err)
	}
	writeFile(t, settings, "iphone = maybe\n")
	if c, err = loadConfig(conf); err != nil || !c.IPhone || len(c.Skipped) != 1 {
		t.Fatalf("bad value: %v %v %v", c.IPhone, c.Skipped, err)
	}
	if c, err = loadConfig(filepath.Join(dir, "none.conf")); err == nil && !c.IPhone {
		t.Fatal("iPhones off without a setting")
	}
}

// A failed session is retried on the same usbmux session: VERSION is sent
// once.
func TestIPhoneTrustRetrySameMux(t *testing.T) {
	phone := newFakePhone(t)
	dir := t.TempDir()
	id, _ := loadHostIdentity(dir)
	phone.mu.Lock()
	phone.host, phone.failSess = id.HostID, 2
	hb, _ := pem.Decode([]byte(id.HostCertificate))
	phone.hostCert = hb.Bytes
	phone.mu.Unlock()
	m, err := openMux(phone.pipe())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := iphoneTrustRetrying(ctx, m, dir, func(string) {}, 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	phone.mu.Lock()
	defer phone.mu.Unlock()
	if phone.nVersion != 1 || phone.nSession != 1 || phone.nPair != 0 {
		t.Fatalf("VERSION %d, sessions %d, pairs %d", phone.nVersion, phone.nSession, phone.nPair)
	}
}

// Failed links in a row space out the takes: 20 s doubling to 5 min,
// reset by data and by a replug. A link whose usbmux ended also holds the
// phone back from the scan for that long.
func TestIPhoneBackoff(t *testing.T) {
	defer func(s string) { sysBusUSB = s }(sysBusUSB)
	sysBusUSB = t.TempDir()
	fakeIPhoneSysfs(t, 9)
	var got []time.Duration
	for i := 0; i < 6; i++ {
		got = append(got, iphoneStallWait("1-3.1", 9))
		iphoneFailed("1-3.1", 9, false)
	}
	want := []time.Duration{20 * time.Second, 40 * time.Second, 80 * time.Second, 160 * time.Second, 5 * time.Minute, 5 * time.Minute}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("waits %v", got)
	}
	iphoneDataFlows("1-3.1", 9)
	if iphoneStallWait("1-3.1", 9) != 20*time.Second {
		t.Fatal("data did not reset the wait")
	}
	u := newScanUplink(defaults())
	iphoneFailed("1-3.1", 9, true) // usbmux ended
	if _, ok := iphoneCandidate(u); ok {
		t.Fatal("taken again during the backoff")
	}
	iphoneFailed("1-3.1", 9, false)
	fakeIPhoneSysfs(t, 10) // plugged in again
	if _, ok := iphoneCandidate(u); !ok || iphoneStallWait("1-3.1", 10) != 20*time.Second {
		t.Fatal("a replugged phone keeps the backoff")
	}
}
