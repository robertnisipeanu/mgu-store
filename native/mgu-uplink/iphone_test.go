package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

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

func TestDropIns(t *testing.T) {
	c := defaults()
	c.StateDir, c.OAPDir = t.TempDir(), t.TempDir()
	c.UIDs = []int{12990}
	c.Apps = []string{"store"}
	writeFile(t, c.uidsFile(), "12205=store\n12207=doom\n12209=maps\n")
	writeFile(t, filepath.Join(c.uidsDir(), "vpn"), "12993 # a VPN node\n")
	writeFile(t, filepath.Join(c.uidsDir(), "two"), "12994, 12995\n0\nx\n")
	writeFile(t, filepath.Join(c.uidsDir(), ".hidden"), "1\n")
	writeFile(t, filepath.Join(c.uidsDir(), "partial.tmp"), "2\n")
	writeFile(t, filepath.Join(c.appsDir(), "robertn_doom"), "doom\n")
	writeFile(t, filepath.Join(c.appsDir(), "maps"), "")
	writeFile(t, filepath.Join(c.appsDir(), "bad"), "a/b\n")
	uids, byApp, missing := resolveUIDs(c)
	if !reflect.DeepEqual(uids, []int{12205, 12207, 12209, 12990, 12993, 12994, 12995}) ||
		!reflect.DeepEqual(byApp, map[string]int{"store": 12205, "doom": 12207, "maps": 12209}) || len(missing) != 0 {
		t.Fatalf("uids %v byApp %v missing %v", uids, byApp, missing)
	}
	_, _, bad := dropIns(c)
	if len(bad) != 3 {
		t.Fatalf("bad entries %v", bad)
	}
	// Removing a drop-in takes its uid away at the next rescan.
	os.Remove(filepath.Join(c.uidsDir(), "vpn"))
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
	setStatus(&statusDevice{Kind: kindIPhone, Name: "Apple Inc. iPhone"}, stateTrustNeeded, "Tap Trust on the iPhone")
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"state": "trust-needed"`) || !strings.Contains(string(b), "Tap Trust on the iPhone") {
		t.Fatalf("%s", b)
	}
	statusClear(p)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("status.json left")
	}
}

// setLinkTrust is reflected as trust-needed only while a link is up and has
// no lease; a lease takes priority.
func TestLinkTrustState(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	statusInit(p)
	defer statusInit("")
	s := &service{}
	s.link = stubLink{}
	setLinkTrust(true, "Tap Trust on the iPhone")
	s.publishStatus()
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"state": "trust-needed"`) {
		t.Fatalf("trust not shown: %s", b)
	}
	// A lease hides the trust note.
	s.lease = &Lease{IP: "172.20.10.2"}
	s.publishStatus()
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"state": "online"`) {
		t.Fatalf("lease did not take priority: %s", b)
	}
	s.lease = nil
	setLinkTrust(false, "")
	s.publishStatus()
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"state": "connecting"`) {
		t.Fatalf("not connecting after clear: %s", b)
	}
}

// stubLink is a minimal Link reporting an iPhone device, for publishStatus.
type stubLink struct{}

func (stubLink) Ifname() string        { return Ifname }
func (stubLink) Done() <-chan struct{} { return nil }
func (stubLink) Err() error            { return nil }
func (stubLink) Close()                {}
func (stubLink) String() string        { return "stub" }
func (stubLink) device() statusDevice {
	return statusDevice{Kind: kindIPhone, Name: "Apple Inc. iPhone"}
}
