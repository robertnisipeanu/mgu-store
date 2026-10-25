package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPlistRoundTrip(t *testing.T) {
	v := map[string]interface{}{
		"Request":  "Pair",
		"Label":    "a<b>&c",
		"Data":     []byte{0, 1, 2, 0xff},
		"Bool":     true,
		"False":    false,
		"Int":      int64(-42),
		"Big":      uint64(1 << 63),
		"Real":     1.5,
		"Array":    []interface{}{"x", int64(1), map[string]interface{}{"k": "v"}},
		"Nested":   map[string]interface{}{"ExtendedPairingErrors": true},
		"EmptyStr": "",
	}
	b, err := plistEncode(v)
	if err != nil {
		t.Fatal(err)
	}
	got, err := plistDecode(b)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, v) {
		t.Fatalf("got %#v\nwant %#v\n%s", got, v, b)
	}
	// lockdownd's own layout: whitespace and line-wrapped data.
	got, err = plistDecode([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Value</key>
	<data>
	AAEC
	/w==
	</data>
	<key>Error</key>
	<string>PairingDialogResponsePending</string>
</dict>
</plist>`))
	if err != nil {
		t.Fatal(err)
	}
	m := got.(map[string]interface{})
	if !bytes.Equal(m["Value"].([]byte), []byte{0, 1, 2, 0xff}) || m["Error"] != "PairingDialogResponsePending" {
		t.Fatalf("%#v", m)
	}
	for _, bad := range []string{"", "<plist><dict><string>x</string></dict></plist>", "<plist><integer>x</integer></plist>",
		"<plist><dict><key>a</key>", "<plist><foo/></plist>", strings.Repeat("<array>", 40) + strings.Repeat("</array>", 40)} {
		if _, err := plistDecode([]byte(bad)); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
}

func TestMuxFraming(t *testing.T) {
	v1 := encodeMux(0, muxProtoVersion, 9, 9, putBE32(2, 0, 0))
	if !bytes.Equal(v1, append(putBE32(0, 20), putBE32(2, 0, 0)...)) {
		t.Fatalf("v1 % x", v1)
	}
	th := tcpHdr{sport: 1, dport: lockdownPort, seq: 5, ack: 7, flags: thACK, window: 512}
	v2 := encodeMux(2, muxProtoTCP, 3, 0xffff, th.encode([]byte("hi")))
	want := append(putBE32(6, 16+20+2, muxMagic), 0, 3, 0xff, 0xff)
	if !bytes.Equal(v2[:16], want) {
		t.Fatalf("v2 header % x", v2[:16])
	}
	tcp := v2[16:]
	if binary.BigEndian.Uint16(tcp) != 1 || binary.BigEndian.Uint16(tcp[2:]) != 62078 || tcp[12] != 0x50 ||
		tcp[13] != thACK || binary.BigEndian.Uint16(tcp[14:]) != 512 {
		t.Fatalf("tcphdr % x", tcp[:20])
	}
	got, payload, ok := parseTCPHdr(tcp)
	if !ok || got != th || string(payload) != "hi" {
		t.Fatalf("%+v %q %v", got, payload, ok)
	}
	if _, _, ok := parseTCPHdr(make([]byte, 19)); ok {
		t.Fatal("short header accepted")
	}
}

// A usbmux stream split and joined across transfers is reassembled.
func TestMuxDispatch(t *testing.T) {
	m := &usbMux{version: 2, conns: map[uint16]*muxConn{}}
	c := &muxConn{m: m, sport: 1, dport: lockdownPort, connected: true, estab: make(chan error, 1), notify: make(chan struct{}, 1)}
	m.conns[1] = c
	sent := &recordPipe{}
	m.p = sent
	seg := func(s string) []byte {
		return encodeMux(2, muxProtoTCP, 0, 0, tcpHdr{sport: lockdownPort, dport: 1, flags: thACK}.encode([]byte(s)))
	}
	stream := append(seg("hello "), seg("world")...)
	rest := m.dispatch(stream[:10])
	rest = m.dispatch(append(rest, stream[10:30]...))
	rest = m.dispatch(append(rest, stream[30:]...))
	if len(rest) != 0 || string(c.buf) != "hello world" || c.txAck != 11 {
		t.Fatalf("rest %d, buf %q, ack %d", len(rest), c.buf, c.txAck)
	}
	if len(sent.pkts) != 2 { // one ACK per segment
		t.Fatalf("%d packets sent", len(sent.pkts))
	}
	if r := m.dispatch(putBE32(6, 4)); r != nil {
		t.Fatal("impossible length kept")
	}
}

type recordPipe struct{ pkts [][]byte }

func (r *recordPipe) write(b []byte, zlp bool) error {
	r.pkts = append(r.pkts, append([]byte{}, b...))
	return nil
}
func (r *recordPipe) read(buf []byte, timeoutMS uint32) (int, error) { return 0, nil }

func TestIPhethLegacy(t *testing.T) {
	frame := bytes.Repeat([]byte{7}, 60)
	var got [][]byte
	iphethUnpackLegacy(append([]byte{0, 0}, frame...), func(f []byte) { got = append(got, f) })
	if len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("%v", got)
	}
	iphethUnpackLegacy([]byte{0, 0}, func(f []byte) { t.Fatal("emitted from a pad-only transfer") })
}

// iosNTB is a block as an iPhone sends it: NTH16, a 96-byte NDP16 right
// after it, the datagrams after both.
func iosNTB(datagrams ...[]byte) []byte {
	le := binary.LittleEndian
	b := make([]byte, iphethNCMHeader)
	le.PutUint32(b, nth16Sign)
	le.PutUint16(b[4:], 12)
	le.PutUint16(b[10:], 12)
	le.PutUint32(b[12:], ndp16NoCRC)
	le.PutUint16(b[16:], 96)
	for i, d := range datagrams {
		le.PutUint16(b[20+4*i:], uint16(len(b)))
		le.PutUint16(b[22+4*i:], uint16(len(d)))
		b = append(b, d...)
	}
	le.PutUint16(b[8:], uint16(len(b)))
	return b
}

func TestIPhethNCM(t *testing.T) {
	a, b := bytes.Repeat([]byte{1}, 60), bytes.Repeat([]byte{2}, 1514)
	var got [][]byte
	iphethUnpackNCM(iosNTB(a, b), func(f []byte) { got = append(got, f) })
	if len(got) != 2 || !bytes.Equal(got[0], a) || !bytes.Equal(got[1], b) {
		t.Fatalf("got %d", len(got))
	}
	// The generic parser reads the same block.
	got = nil
	if err := parseNTB16(iosNTB(a, b), func(f []byte) { got = append(got, f) }); err != nil || len(got) != 2 {
		t.Fatalf("parseNTB16: %v %d", err, len(got))
	}
	le := binary.LittleEndian
	for name, blk := range map[string][]byte{
		"NDP elsewhere":  func() []byte { x := iosNTB(a); le.PutUint16(x[10:], 16); return x }(),
		"bad NDP sign":   func() []byte { x := iosNTB(a); x[12] = 'X'; return x }(),
		"inside headers": func() []byte { x := iosNTB(a); le.PutUint16(x[20:], 50); return x }(),
		"past the end":   func() []byte { x := iosNTB(a); le.PutUint16(x[22:], 61); return x }(),
		"too short":      iosNTB(a)[:100],
	} {
		iphethUnpackNCM(blk, func(f []byte) { t.Errorf("%s: emitted %d bytes", name, len(f)) })
	}
	// 22 entries without a terminator: all taken, nothing read beyond.
	many := make([][]byte, 22)
	for i := range many {
		many[i] = []byte{byte(i), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	}
	n := 0
	iphethUnpackNCM(iosNTB(many...), func(f []byte) { n++ })
	if n != 22 {
		t.Fatalf("%d of 22", n)
	}
}

func TestCarrierOn(t *testing.T) {
	for r, want := range map[string]bool{"\x04": true, "\x00\x04": true, "\x04\x00": false, "\x00": false, "": false, "\x01\x04\x00": true} {
		if carrierOn([]byte(r)) != want {
			t.Errorf("% x: want %v", r, want)
		}
	}
}

// pairOnce runs pairIPhone against a fake phone attachment.
func pairOnce(t *testing.T, phone *fakePhone, dir string) (string, []string, error) {
	t.Helper()
	m, err := newUSBMux(&fakeMuxPipe{p: phone})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	var mu sync.Mutex
	var prompts []string
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	udid, err := pairIPhone(ctx, m, dir, func(msg string) error {
		mu.Lock()
		prompts = append(prompts, msg)
		mu.Unlock()
		return nil
	})
	return udid, prompts, err
}

func TestPairIPhone(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pair")
	trust := newFakeTrust("00008030-001A2B3C4D5E6F70")

	// First plug-in: the Trust prompt for two rounds, then trust.
	phone := newFakePhone(trust)
	phone.prompts = 2
	phone.logf = t.Logf
	udid, prompts, err := pairOnce(t, phone, dir)
	if err != nil {
		t.Fatal(err)
	}
	if udid != trust.udid || !reflect.DeepEqual(prompts, []string{trustWaiting, trustWaiting}) || phone.pairs != 3 || !phone.Trusted() {
		t.Fatalf("udid %s prompts %v pairs %d trusted %v", udid, prompts, phone.pairs, phone.Trusted())
	}
	st, err := os.Stat(pairRecordPath(dir, udid))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("pair record: %v %v", st, err)
	}
	if d, _ := os.Stat(dir); d.Mode().Perm() != 0700 {
		t.Fatalf("pair dir mode %v", d.Mode())
	}
	rec := loadPairRecord(dir, udid)
	if rec == nil || string(rec.EscrowBag) != "escrow" || rec.HostID != trust.hostID {
		t.Fatalf("record %+v", rec)
	}

	// Next plug-in: the stored record, no prompt.
	phone = newFakePhone(trust)
	_, prompts, err = pairOnce(t, phone, dir)
	if err != nil || len(prompts) != 0 || phone.pairs != 0 || phone.sessions != 1 {
		t.Fatalf("replug: %v prompts %v pairs %d sessions %d", err, prompts, phone.pairs, phone.sessions)
	}

	// The phone forgot this unit (Reset Location & Privacy): pair again.
	trust.mu.Lock()
	trust.hostID = ""
	trust.mu.Unlock()
	phone = newFakePhone(trust)
	_, _, err = pairOnce(t, phone, dir)
	if err != nil || phone.pairs != 1 || !phone.Trusted() {
		t.Fatalf("re-pair: %v pairs %d", err, phone.pairs)
	}
	if r := loadPairRecord(dir, udid); r == nil || r.HostID == rec.HostID {
		t.Fatal("record not replaced")
	}

	// Declined.
	other := newFakeTrust("0123456789abcdef0123456789abcdef01234567")
	phone = newFakePhone(other)
	phone.deny = true
	if _, _, err := pairOnce(t, phone, dir); err != errTrustDenied || phone.Trusted() {
		t.Fatalf("declined: %v", err)
	}

	// Unplugged while the prompt is open.
	phone = newFakePhone(other)
	phone.prompts = 1000
	go func() {
		time.Sleep(3 * time.Second)
		phone.unplug()
	}()
	if _, _, err := pairOnce(t, phone, dir); err == nil || !strings.Contains(err.Error(), "left") {
		t.Fatalf("unplugged: %v", err)
	}
}

func TestPairRecordName(t *testing.T) {
	for _, bad := range []string{"../../etc/x", "a/b", "short", ""} {
		if udidRe.MatchString(bad) {
			t.Errorf("%q accepted as a UDID", bad)
		}
	}
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "x.json"), `{"udid":"y","hostID":"h","hostCertificate":"AA=="}`)
	if loadPairRecord(dir, "x") != nil {
		t.Fatal("record for another UDID loaded")
	}
}

func TestDropIns(t *testing.T) {
	c := defaults()
	c.StateDir, c.OAPDir = t.TempDir(), t.TempDir()
	c.UIDs = []int{12990}
	c.Apps = []string{"store"}
	writeFile(t, c.uidsFile(), "12205=store\n12207=doom\n12209=waze\n")
	writeFile(t, filepath.Join(c.uidsDir(), "mgu-tailscale"), "12993 # the tailnet node\n")
	writeFile(t, filepath.Join(c.uidsDir(), "two"), "12994, 12995\n0\nx\n")
	writeFile(t, filepath.Join(c.uidsDir(), ".hidden"), "1\n")
	writeFile(t, filepath.Join(c.uidsDir(), "partial.tmp"), "2\n")
	writeFile(t, filepath.Join(c.appsDir(), "robertn_doom"), "doom\n")
	writeFile(t, filepath.Join(c.appsDir(), "waze"), "")
	writeFile(t, filepath.Join(c.appsDir(), "bad"), "a/b\n")
	uids, byApp, missing := resolveUIDs(c)
	if !reflect.DeepEqual(uids, []int{12205, 12207, 12209, 12990, 12993, 12994, 12995}) ||
		!reflect.DeepEqual(byApp, map[string]int{"store": 12205, "doom": 12207, "waze": 12209}) || len(missing) != 0 {
		t.Fatalf("uids %v byApp %v missing %v", uids, byApp, missing)
	}
	_, _, bad := dropIns(c)
	if len(bad) != 3 {
		t.Fatalf("bad entries %v", bad)
	}
	// Removing a drop-in takes its uid away at the next rescan.
	os.Remove(filepath.Join(c.uidsDir(), "mgu-tailscale"))
	uids, _, _ = resolveUIDs(c)
	for _, u := range uids {
		if u == 12993 {
			t.Fatalf("uids %v still hold 12993", uids)
		}
	}
}

func TestStatusFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	statusInit(p)
	defer statusInit("")
	setStatus(nil, stateSearching, "")
	if b, _ := os.ReadFile(p); string(b) != "{\n  \"device\": null,\n  \"state\": \"searching\",\n  \"error\": null\n}\n" {
		t.Fatalf("%s", b)
	}
	setLinkNote("Personal Hotspot is off")
	setStatus(&statusDevice{Kind: kindIPhone, Name: "Apple Inc. iPhone"}, stateConnecting, "")
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), `"kind": "iphone"`) || !strings.Contains(string(b), `"error": "Personal Hotspot is off"`) {
		t.Fatalf("%s", b)
	}
	setStatus(&statusDevice{Kind: kindIPhone, Name: "Apple Inc. iPhone"}, stateTrustNeeded, trustWaiting)
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"state": "trust-needed"`) || !strings.Contains(string(b), trustWaiting) {
		t.Fatalf("%s", b)
	}
	statusClear(p)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("status.json left")
	}
}
