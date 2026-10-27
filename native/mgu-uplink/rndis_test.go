package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestRNDISPacket(t *testing.T) {
	frame := bytes.Repeat([]byte{0xab}, 100)
	p := rndisPacket(frame, 512)
	if len(p) != rndisPacketHeader+100 || le32(p) != rndisMsgPacket || le32(p[4:]) != uint32(len(p)) ||
		le32(p[8:]) != 36 || le32(p[12:]) != 100 || !bytes.Equal(p[44:], frame) {
		t.Fatalf("% x", p[:44])
	}
	// 468 + 44 = 512: one pad byte after the message, which keeps its length.
	p = rndisPacket(make([]byte, 468), 512)
	if len(p) != 513 || le32(p[4:]) != 512 || p[512] != 0 {
		t.Fatalf("padded packet: %d bytes, length field %d", len(p), le32(p[4:]))
	}
	if p = rndisPacket(make([]byte, 468), 0); len(p) != 512 {
		t.Fatal("padded without a packet size")
	}
}

func TestRNDISUnpack(t *testing.T) {
	a, b := bytes.Repeat([]byte{1}, 60), bytes.Repeat([]byte{2}, 1514)
	// Two messages, the second with a larger DataOffset and trailing bytes
	// inside its MessageLength.
	m2 := rndisPacket(b, 0)
	m2 = append(m2[:8], append(putLE32(36+8), m2[12:]...)...)
	m2 = append(m2[:44], append(make([]byte, 8), b...)...)
	m2 = append(m2, 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(m2[4:], uint32(len(m2)))
	xfer := append(rndisPacket(a, 0), m2...)
	var got [][]byte
	rndisUnpack(xfer, func(f []byte) { got = append(got, append([]byte{}, f...)) })
	if len(got) != 2 || !bytes.Equal(got[0], a) || !bytes.Equal(got[1], b) {
		t.Fatalf("got %d frames", len(got))
	}
	// A message whose length runs past the transfer ends it; the frames
	// before it still count.
	bad := append(rndisPacket(a, 0), rndisPacket(b, 0)[:100]...)
	got = nil
	rndisUnpack(bad, func(f []byte) { got = append(got, f) })
	if len(got) != 1 {
		t.Fatalf("truncated: %d frames", len(got))
	}
	for _, junk := range [][]byte{nil, make([]byte, 44), putLE32(1, 0xffffffff, 36, 10, 0, 0, 0, 0, 0, 0, 0),
		putLE32(1, 44, 0xfffffff0, 10, 0, 0, 0, 0, 0, 0, 0), putLE32(1, 48, 36, 0xffffffff, 0, 0, 0, 0, 0, 0, 0, 0)} {
		rndisUnpack(junk, func(f []byte) { t.Errorf("% x: emitted %d bytes", junk, len(f)) })
	}
}

func TestRNDISMessage(t *testing.T) {
	m := rndisMessage(rndisMsgInit, 7, putLE32(1, 0, rndisRxSize))
	if !bytes.Equal(m, putLE32(2, 24, 7, 1, 0, 16384)) {
		t.Fatalf("% x", m)
	}
	f := &rndisFramer{maxXfer: 1580}
	if f.mtu() != 1500 {
		t.Fatalf("mtu %d", f.mtu())
	}
	f.maxXfer = 1200
	if f.mtu() != 1200-44-14-1 {
		t.Fatalf("mtu %d", f.mtu())
	}
}
