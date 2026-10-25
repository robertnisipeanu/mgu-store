package main

// CDC-NCM, as Pixel 6 and later phones present USB tethering (the f_ncm
// gadget) and an iPhone frames what it receives. Frames travel in NCM
// Transfer Blocks: an NTH16 header, NDP16 tables of datagram pointers and
// the datagrams. The host sends one datagram per OUT block; an IN block
// holds as many as the device packs, behind one or more chained NDPs.
// The framing is tested in ncm_test.go.

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	nth16Sign     = 0x484d434e // "NCMH"
	ndp16NoCRC    = 0x304d434e // "NCM0"
	nth16Len      = 12
	ndp16MinLen   = 16 // header and one entry plus the terminator
	ncmGetNTBPars = 0x80
	ncmSetNTBFmt  = 0x84
	ncmSetCRCMode = 0x8a
	ncmCapCRC     = 0x10 // bmNetworkCapabilities: SET/GET_CRC_MODE
)

// ntbParams is GET_NTB_PARAMETERS' reply.
type ntbParams struct {
	formats  uint16 // bit 0 NTB16, bit 1 NTB32
	inMax    uint32
	outMax   uint32
	outDiv   uint16
	outRem   uint16
	outAlign uint16
}

func parseNTBParams(b []byte) (ntbParams, error) {
	if len(b) < 28 {
		return ntbParams{}, fmt.Errorf("NTB parameters: %d bytes", len(b))
	}
	u16 := func(o int) uint16 { return binary.LittleEndian.Uint16(b[o:]) }
	p := ntbParams{formats: u16(2), inMax: le32(b[4:]), outMax: le32(b[16:]),
		outDiv: u16(20), outRem: u16(22), outAlign: u16(24)}
	if p.formats&1 == 0 {
		return p, fmt.Errorf("NTB parameters: no NTB16 support (formats 0x%x)", p.formats)
	}
	return p, nil
}

// layout is where an OUT block puts its NDP and its datagram: the NDP
// right after the header at the device's alignment, the datagram after
// the NDP at offset ≡ wNdpOutPayloadRemainder (mod wNdpOutDivisor).
func (p ntbParams) layout() (ndpOff, dgOff int) {
	align := int(p.outAlign)
	if align < 4 {
		align = 4
	}
	ndpOff = (nth16Len + align - 1) / align * align
	div := int(p.outDiv)
	if div < 1 {
		div = 1
	}
	rem := int(p.outRem) % div
	dgOff = ndpOff + ndp16MinLen
	dgOff += ((rem-dgOff)%div + div) % div
	return ndpOff, dgOff
}

// buildNTB16 puts one Ethernet frame in an OUT block.
func buildNTB16(seq uint16, frame []byte, p ntbParams) []byte {
	ndpOff, dgOff := p.layout()
	b := make([]byte, dgOff+len(frame))
	le := binary.LittleEndian
	le.PutUint32(b[0:], nth16Sign)
	le.PutUint16(b[4:], nth16Len)
	le.PutUint16(b[6:], seq)
	le.PutUint16(b[8:], uint16(len(b)))
	le.PutUint16(b[10:], uint16(ndpOff))
	n := b[ndpOff:]
	le.PutUint32(n[0:], ndp16NoCRC)
	le.PutUint16(n[4:], ndp16MinLen)
	le.PutUint16(n[6:], 0) // no next NDP
	le.PutUint16(n[8:], uint16(dgOff))
	le.PutUint16(n[10:], uint16(len(frame)))
	// n[12:16] is the terminating zero entry.
	copy(b[dgOff:], frame)
	return b
}

var errNTB = errors.New("malformed NTB")

// parseNTB16 calls emit for each datagram of each NTB16 in one IN
// transfer, following every NDP's wNextNdpIndex. A malformed block ends
// the transfer with errNTB after emitting what came before it.
func parseNTB16(b []byte, emit func([]byte)) error {
	le := binary.LittleEndian
	for len(b) >= nth16Len {
		if le.Uint32(b[0:]) != nth16Sign || le.Uint16(b[4:]) != nth16Len {
			return errNTB
		}
		blk := int(le.Uint16(b[8:]))
		if blk == 0 { // NTB16 has no "rest of the transfer" length; tolerate it
			blk = len(b)
		}
		if blk < nth16Len || blk > len(b) {
			return errNTB
		}
		ntb := b[:blk]
		ndp := int(le.Uint16(b[10:]))
		for hops := 0; ndp != 0; hops++ {
			if hops > 32 || ndp < nth16Len || ndp%4 != 0 || ndp+ndp16MinLen > blk ||
				le.Uint32(ntb[ndp:]) != ndp16NoCRC {
				return errNTB
			}
			l := int(le.Uint16(ntb[ndp+4:]))
			if l < ndp16MinLen || l%4 != 0 || ndp+l > blk {
				return errNTB
			}
			for e := ndp + 8; e+4 <= ndp+l; e += 4 {
				idx, n := int(le.Uint16(ntb[e:])), int(le.Uint16(ntb[e+2:]))
				if idx == 0 || n == 0 {
					break
				}
				if idx < nth16Len || idx+n > blk {
					return errNTB
				}
				emit(ntb[idx : idx+n])
			}
			ndp = int(le.Uint16(ntb[ndp+6:]))
		}
		b = b[blk:]
	}
	return nil
}

// ncmFramer is one NCM function after its setup.
type ncmFramer struct {
	p   usbPipe
	par ntbParams
	seq uint16
	in  int
}

func (f *ncmFramer) pipe() usbPipe { return f.p }
func (f *ncmFramer) rxSize() int   { return f.in }

func (f *ncmFramer) send(frame []byte) error {
	_, dgOff := f.par.layout()
	if f.par.outMax > 0 && dgOff+len(frame) > int(f.par.outMax) {
		return nil // larger than the device takes: dropped, as on a wire
	}
	f.seq++
	b := buildNTB16(f.seq, frame, f.par)
	// A block of exactly dwNtbOutMaxSize needs no terminator.
	return f.p.write(b, len(b) != int(f.par.outMax))
}

// recv reads with a buffer of exactly the IN block size: the device ends a
// full-size block without a zero-length packet.
func (f *ncmFramer) recv(buf []byte, emit func([]byte)) error {
	n, err := f.p.read(buf, 500)
	if err != nil {
		return err
	}
	parseNTB16(buf[:n], emit)
	return nil
}

// mtu fits a frame into one OUT block and the function's segment size.
func (f *ncmFramer) mtu(maxSegment int) int {
	m := 1500
	if maxSegment > 14 && maxSegment-14 < m {
		m = maxSegment - 14
	}
	_, dgOff := f.par.layout()
	if f.par.outMax > 0 && int(f.par.outMax)-dgOff-14 < m {
		m = int(f.par.outMax) - dgOff - 14
	}
	return m
}

// initNCM follows cdc_ncm's bring-up: with the data interface at alt 0,
// read the NTB parameters, choose 16-bit blocks and no CRC; then the data
// alt setting and the packet filter.
func initNCM(dev *usbDevice, info usbDeviceInfo, fn netFunction, p usbPipe) (*ncmFramer, error) {
	comm := uint16(fn.commIface)
	if err := dev.setInterface(fn.dataIface, 0); err != nil {
		return nil, err
	}
	buf := make([]byte, 28)
	n, err := dev.control(0xa1, ncmGetNTBPars, 0, comm, buf, 1000)
	if err != nil {
		return nil, fmt.Errorf("%s: GET_NTB_PARAMETERS: %v", info, err)
	}
	par, err := parseNTBParams(buf[:n])
	if err != nil {
		return nil, fmt.Errorf("%s: %v", info, err)
	}
	if par.formats&2 != 0 {
		if _, err := dev.control(0x21, ncmSetNTBFmt, 0, comm, nil, 1000); err != nil {
			return nil, fmt.Errorf("%s: SET_NTB_FORMAT: %v", info, err)
		}
	}
	if fn.ncmCaps&ncmCapCRC != 0 {
		if _, err := dev.control(0x21, ncmSetCRCMode, 0, comm, nil, 1000); err != nil {
			logf("%s: SET_CRC_MODE: %v (continuing)", info, err)
		}
	}
	if err := dev.setInterface(fn.dataIface, fn.dataAlt); err != nil {
		return nil, err
	}
	if _, err := dev.control(0x21, cdcSetPacketFilter, cdcFilterAll, comm, nil, 1000); err != nil {
		logf("%s: set packet filter: %v (continuing)", info, err)
	}
	in := int(par.inMax)
	if in < 2048 {
		in = 2048
	}
	if in > 65536 {
		in = 65536
	}
	logf("%s: NCM in %d out %d, divisor %d remainder %d alignment %d", info, par.inMax, par.outMax, par.outDiv, par.outRem, par.outAlign)
	return &ncmFramer{p: p, par: par, in: in}, nil
}
