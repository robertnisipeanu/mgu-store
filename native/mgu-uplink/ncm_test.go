package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// f_ncm's parameters: 16 KiB blocks, divisor 4, NTB16 and NTB32.
func gadgetNTBParams() []byte {
	b := make([]byte, 28)
	le := binary.LittleEndian
	le.PutUint16(b[0:], 28)
	le.PutUint16(b[2:], 3)
	le.PutUint32(b[4:], 16384)
	le.PutUint16(b[8:], 4)
	le.PutUint16(b[12:], 4)
	le.PutUint32(b[16:], 16384)
	le.PutUint16(b[20:], 4)
	le.PutUint16(b[24:], 4)
	return b
}

func TestNTBParams(t *testing.T) {
	p, err := parseNTBParams(gadgetNTBParams())
	if err != nil || p.inMax != 16384 || p.outMax != 16384 || p.outDiv != 4 || p.outAlign != 4 || p.formats != 3 {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := parseNTBParams(make([]byte, 27)); err == nil {
		t.Fatal("short reply accepted")
	}
	if _, err := parseNTBParams(make([]byte, 28)); err == nil {
		t.Fatal("no NTB16 accepted")
	}
}

func TestBuildNTB16(t *testing.T) {
	p, _ := parseNTBParams(gadgetNTBParams())
	frame := bytes.Repeat([]byte{0x5a}, 98)
	b := buildNTB16(9, frame, p)
	le := binary.LittleEndian
	if le.Uint32(b) != nth16Sign || le.Uint16(b[4:]) != 12 || le.Uint16(b[6:]) != 9 ||
		int(le.Uint16(b[8:])) != len(b) || le.Uint16(b[10:]) != 12 {
		t.Fatalf("NTH16 % x", b[:12])
	}
	if le.Uint32(b[12:]) != ndp16NoCRC || le.Uint16(b[16:]) != 16 || le.Uint16(b[18:]) != 0 ||
		le.Uint16(b[20:]) != 28 || le.Uint16(b[22:]) != 98 || le32(b[24:]) != 0 {
		t.Fatalf("NDP16 % x", b[12:28])
	}
	if len(b) != 28+98 || !bytes.Equal(b[28:], frame) {
		t.Fatalf("%d bytes", len(b))
	}
	var got [][]byte
	if err := parseNTB16(b, func(f []byte) { got = append(got, f) }); err != nil || len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("round trip: %v %d", err, len(got))
	}
	// A device asking for 8-byte NDP alignment and datagrams at 2 mod 8.
	p.outAlign, p.outDiv, p.outRem = 8, 8, 2
	ndp, dg := p.layout()
	if ndp != 16 || dg != 34 {
		t.Fatalf("layout %d %d", ndp, dg)
	}
	b = buildNTB16(1, frame, p)
	got = nil
	if err := parseNTB16(b, func(f []byte) { got = append(got, f) }); err != nil || len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("aligned round trip: %v %d", err, len(got))
	}
}

// ntb assembles an IN block: datagrams first, then NDPs each listing some
// of them, chained in the given order (the f_ncm gadget puts its one NDP
// at the end).
func ntb(datagrams [][]byte, ndps [][]int) []byte {
	le := binary.LittleEndian
	b := make([]byte, 12)
	var idx []int
	for _, d := range datagrams {
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
		idx = append(idx, len(b))
		b = append(b, d...)
	}
	var ndpOff []int
	for _, list := range ndps {
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
		ndpOff = append(ndpOff, len(b))
		n := make([]byte, 8+4*(len(list)+1))
		le.PutUint32(n, ndp16NoCRC)
		le.PutUint16(n[4:], uint16(len(n)))
		for i, d := range list {
			le.PutUint16(n[8+4*i:], uint16(idx[d]))
			le.PutUint16(n[10+4*i:], uint16(len(datagrams[d])))
		}
		b = append(b, n...)
	}
	for i := 0; i+1 < len(ndpOff); i++ {
		le.PutUint16(b[ndpOff[i]+6:], uint16(ndpOff[i+1]))
	}
	le.PutUint32(b, nth16Sign)
	le.PutUint16(b[4:], 12)
	le.PutUint16(b[8:], uint16(len(b)))
	le.PutUint16(b[10:], uint16(ndpOff[0]))
	return b
}

func TestParseNTB16(t *testing.T) {
	d := [][]byte{bytes.Repeat([]byte{1}, 60), bytes.Repeat([]byte{2}, 1514), bytes.Repeat([]byte{3}, 61), bytes.Repeat([]byte{4}, 42)}
	collect := func(b []byte) ([][]byte, error) {
		var got [][]byte
		err := parseNTB16(b, func(f []byte) { got = append(got, append([]byte{}, f...)) })
		return got, err
	}
	// One NDP listing all four; two chained NDPs; two blocks in one transfer.
	for name, b := range map[string][]byte{
		"one NDP":    ntb(d, [][]int{{0, 1, 2, 3}}),
		"chained":    ntb(d, [][]int{{0, 1}, {2, 3}}),
		"two blocks": append(ntb(d[:2], [][]int{{0, 1}}), ntb(d[2:], [][]int{{0}, {1}})...),
		"three NDPs": ntb(d, [][]int{{0}, {1, 2}, {3}}),
	} {
		got, err := collect(b)
		if err != nil || len(got) != 4 {
			t.Errorf("%s: %d datagrams, %v", name, len(got), err)
			continue
		}
		for i := range d {
			if !bytes.Equal(got[i], d[i]) {
				t.Errorf("%s: datagram %d differs", name, i)
			}
		}
	}

	good := ntb(d, [][]int{{0, 1}, {2, 3}})
	le := binary.LittleEndian
	mutate := func(f func(b []byte)) []byte {
		b := append([]byte{}, good...)
		f(b)
		return b
	}
	ndp1 := int(le.Uint16(good[10:]))
	ndp2 := int(le.Uint16(good[ndp1+6:]))
	for name, b := range map[string][]byte{
		"bad signature":     mutate(func(b []byte) { b[0] = 'X' }),
		"block too long":    mutate(func(b []byte) { le.PutUint16(b[8:], uint16(len(b)+4)) }),
		"NDP outside":       mutate(func(b []byte) { le.PutUint16(b[10:], uint16(len(b))) }),
		"NDP misaligned":    mutate(func(b []byte) { le.PutUint16(b[10:], uint16(ndp1+2)) }),
		"NDP chain loops":   mutate(func(b []byte) { le.PutUint16(b[ndp2+6:], uint16(ndp1)) }),
		"datagram past end": mutate(func(b []byte) { le.PutUint16(b[ndp2+10:], 0xfff0) }),
		"NDP length short":  mutate(func(b []byte) { le.PutUint16(b[ndp1+4:], 8) }),
	} {
		if _, err := collect(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if got, err := collect(nil); err != nil || got != nil {
		t.Errorf("empty transfer: %v %v", got, err)
	}
}

func TestNCMMTU(t *testing.T) {
	p, _ := parseNTBParams(gadgetNTBParams())
	f := &ncmFramer{par: p}
	if m := f.mtu(1514); m != 1500 {
		t.Fatalf("mtu %d", m)
	}
	p.outMax = 1400
	f.par = p
	if m := f.mtu(1514); m != 1400-28-14 {
		t.Fatalf("small blocks: mtu %d", m)
	}
}
