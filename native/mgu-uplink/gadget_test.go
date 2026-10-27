//go:build linux

package main

// A fake iPhone on a real USB bus, for testing the iphone uplink end to end
// in a Linux VM (test/vm-gadget.sh): FunctionFS functions in a configfs
// gadget with Apple's ids, four configurations like an iPhone in its default
// mode (PTP in 1-3; PTP and the hotspot interface in 4), and the hotspot
// interface bridged to a TAP device on which the VM runs a DHCP server. The
// phone needs no host-side pairing; with MGU_FAKEPHONE_SILENT=1 it sends
// nothing (as if Trust has not been tapped or the hotspot is off), so the
// uplink reports trust-needed. It runs only when MGU_FAKEPHONE_FFS names the
// FunctionFS mounts:
//
//	MGU_FAKEPHONE_FFS=/dev/ffs-ptp1,/dev/ffs-ptp2,/dev/ffs-ptp3,/dev/ffs-iphone
//	MGU_FAKEPHONE_TAP=iph0          the TAP device to create
//	MGU_FAKEPHONE_RX=ncm|legacy     how the phone frames what it sends
//	MGU_FAKEPHONE_SILENT=1          send nothing (untrusted / hotspot off)

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	ffsDescMagicV2  = 3
	ffsStringsMagic = 2
	ffsHasFS        = 1
	ffsHasHS        = 2
	ffsAllCtrlRecip = 64

	ffsEvBind    = 0
	ffsEvUnbind  = 1
	ffsEvEnable  = 2
	ffsEvDisable = 3
	ffsEvSetup   = 4
)

func ifaceD(num, alt, neps, class, sub, proto byte) []byte {
	return []byte{9, 4, num, alt, neps, class, sub, proto, 1}
}

func epD(addr byte, mps uint16) []byte {
	return []byte{7, 5, addr, 2, byte(mps), byte(mps >> 8), 0}
}

// ffsDescriptors is a v2 descriptor blob with the same interfaces at full
// and high speed.
func ffsDescriptors(flags uint32, speed func(mps uint16) [][]byte) []byte {
	fs, hs := speed(64), speed(512)
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, []uint32{ffsDescMagicV2, 0, flags | ffsHasFS | ffsHasHS,
		uint32(len(fs)), uint32(len(hs))})
	for _, d := range append(fs, hs...) {
		b.Write(d)
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)))
	return out
}

func ffsStrings(s string) []byte {
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, []uint32{ffsStringsMagic, 0, 1, 1})
	binary.Write(&b, binary.LittleEndian, uint16(0x0409))
	b.WriteString(s)
	b.WriteByte(0)
	out := b.Bytes()
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)))
	return out
}

func ptpInterface(mps uint16) [][]byte { return [][]byte{ifaceD(0, 0, 0, 0x06, 0x01, 0x01)} }

// iphoneInterfaces: interface 0 a PTP filler, interface 1 the hotspot
// interface (ff/fd/01) with ep1 OUT and ep2 IN. A real iPhone carries these
// endpoints on alternate setting 1 with an empty alt 0; FunctionFS cannot
// model the empty-alt-0 switch, so the fake exposes them on the default
// setting and the uplink reaches them without a switch.
func iphoneInterfaces(mps uint16) [][]byte {
	return [][]byte{
		ifaceD(0, 0, 0, 0x06, 0x01, 0x01),
		ifaceD(1, 0, 2, 0xff, 0xfd, 0x01), epD(0x01, mps), epD(0x82, mps),
	}
}

type gadgetPhone struct {
	t      *testing.T
	ncmRx  bool
	silent bool
	mac    []byte
	tap    *os.File

	mu  sync.Mutex
	on  bool       // the hotspot interface is enabled (the host claimed config 4)
	eps []*os.File // ep1 (OUT, host->phone), ep2 (IN, phone->host)
}

func TestGadgetFakePhone(t *testing.T) {
	mounts := strings.Split(os.Getenv("MGU_FAKEPHONE_FFS"), ",")
	if mounts[0] == "" {
		t.Skip("MGU_FAKEPHONE_FFS not set")
	}
	g := &gadgetPhone{t: t, ncmRx: os.Getenv("MGU_FAKEPHONE_RX") != "legacy",
		silent: os.Getenv("MGU_FAKEPHONE_SILENT") == "1", mac: []byte{0x02, 0xac, 0x05, 0x12, 0xa8, 0x01}}
	tap, err := openTAP(os.Getenv("MGU_FAKEPHONE_TAP"))
	if err != nil {
		t.Fatal(err)
	}
	g.tap = tap
	go g.tapToHost()
	for i, m := range mounts {
		ep0, err := os.OpenFile(m+"/ep0", os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		iphone := i == len(mounts)-1
		desc := ffsDescriptors(0, ptpInterface)
		if iphone {
			desc = ffsDescriptors(ffsAllCtrlRecip, iphoneInterfaces)
		}
		if _, err := ep0.Write(desc); err != nil {
			t.Fatalf("%s descriptors: %v", m, err)
		}
		if _, err := ep0.Write(ffsStrings("fake")); err != nil {
			t.Fatalf("%s strings: %v", m, err)
		}
		if iphone {
			go g.serve(ep0, m)
		} else {
			go drainEP0(ep0)
		}
	}
	t.Logf("fake iPhone ready (%s receive, silent %v)", map[bool]string{true: "NCM", false: "legacy"}[g.ncmRx], g.silent)
	select {}
}

func drainEP0(ep0 *os.File) {
	buf := make([]byte, 12*4)
	for {
		if _, err := ep0.Read(buf); err != nil {
			return
		}
	}
}

func (g *gadgetPhone) logf(format string, a ...interface{}) {
	fmt.Fprintf(os.Stderr, time.Now().Format("15:04:05.000 ")+format+"\n", a...)
}

// serve handles the hotspot function's control events: enable wires the
// endpoints (the host has claimed config 4), the vendor requests answer as
// ipheth expects.
func (g *gadgetPhone) serve(ep0 *os.File, mount string) {
	buf := make([]byte, 12*8)
	for {
		n, err := ep0.Read(buf)
		if err != nil {
			g.logf("ep0: %v", err)
			return
		}
		for o := 0; o+12 <= n; o += 12 {
			ev := buf[o : o+12]
			switch ev[8] {
			case ffsEvEnable:
				g.logf("enabled")
				g.attach(mount)
			case ffsEvDisable, ffsEvUnbind:
				g.logf("disabled")
				g.detach()
			case ffsEvSetup:
				g.setup(ep0, ev[:8])
			}
		}
	}
}

func (g *gadgetPhone) setup(ep0 *os.File, req []byte) {
	typ, r := req[0], req[1]
	wLength := binary.LittleEndian.Uint16(req[6:])
	reply := func(b []byte) {
		if len(b) > int(wLength) {
			b = b[:wLength]
		}
		ep0.Write(b)
	}
	fd := int(ep0.Fd())
	ack := func() { unix.Read(fd, nil) }
	stall := func() {
		if typ&0x80 != 0 {
			unix.Read(fd, nil)
		} else {
			unix.Write(fd, nil)
		}
	}
	switch {
	case typ == 0xc0 && r == iphethGetMAC:
		g.logf("GET_MACADDR")
		reply(g.mac)
	case typ == 0x41 && r == iphethEnableNCM:
		if g.ncmRx {
			g.logf("ENABLE_NCM: accepted")
			ack()
		} else {
			g.logf("ENABLE_NCM: refused (legacy)")
			stall()
		}
	case typ == 0xc0 && r == iphethCarrier:
		on := byte(iphethCarrierOn)
		if g.silent {
			on = 0
		}
		reply([]byte{0x00, on})
	default:
		g.logf("control %02x/%02x: stall", typ, r)
		stall()
	}
}

// attach wires the hotspot endpoints once the host has selected config 4 and
// enabled the interface. ep1 is the OUT endpoint (host -> phone), ep2 the IN
// endpoint (phone -> host).
func (g *gadgetPhone) attach(mount string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.eps == nil {
		g.eps = make([]*os.File, 3)
		for n, flag := range map[int]int{1: os.O_RDONLY, 2: os.O_WRONLY} {
			f, err := os.OpenFile(fmt.Sprintf("%s/ep%d", mount, n), flag, 0)
			if err != nil {
				g.logf("ep%d: %v", n, err)
				return
			}
			g.eps[n] = f
		}
		go g.hostToTAP(g.eps[1])
	}
	g.on = true
	// The control frame a real iPhone sends first.
	if !g.silent {
		go g.eps[2].Write([]byte{0x00, 0x01, 0x00, 0x00})
	}
}

func (g *gadgetPhone) detach() {
	g.mu.Lock()
	g.on = false
	g.mu.Unlock()
}

// hostToTAP forwards the host's raw Ethernet frames to the phone network.
func (g *gadgetPhone) hostToTAP(ep *os.File) {
	buf := make([]byte, 65536)
	for {
		n, err := ep.Read(buf)
		if err != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		g.mu.Lock()
		on := g.on && !g.silent
		g.mu.Unlock()
		if on && n >= 14 {
			g.tap.Write(buf[:n])
		}
	}
}

// tapToHost frames what the phone's network sends: two bytes of padding per
// frame (legacy) or an iOS-style NTB, sent only while the interface is up and
// not silent.
func (g *gadgetPhone) tapToHost() {
	buf := make([]byte, 2048)
	var seq uint16
	for {
		n, err := g.tap.Read(buf)
		if err != nil {
			g.logf("tap: %v", err)
			return
		}
		g.mu.Lock()
		var ep *os.File
		if g.on && !g.silent && g.eps != nil {
			ep = g.eps[2]
		}
		g.mu.Unlock()
		if ep == nil {
			continue
		}
		var out []byte
		if g.ncmRx {
			seq++
			out = iosNTBFrame(seq, buf[:n])
		} else {
			out = append([]byte{0, 0}, buf[:n]...)
		}
		writeZLP(ep, out)
	}
}

// writeZLP writes one transfer, ended by a zero-length packet when it is a
// whole number of high-speed packets, as a phone ends each one.
func writeZLP(ep *os.File, b []byte) error {
	if _, err := ep.Write(b); err != nil {
		return err
	}
	if len(b)%512 == 0 {
		_, err := unix.Write(int(ep.Fd()), nil)
		return err
	}
	return nil
}

func iosNTBFrame(seq uint16, frame []byte) []byte {
	le := binary.LittleEndian
	b := make([]byte, iphethNCMHeader, iphethNCMHeader+len(frame))
	le.PutUint32(b, nth16Sign)
	le.PutUint16(b[4:], 12)
	le.PutUint16(b[6:], seq)
	le.PutUint16(b[10:], 12)
	le.PutUint32(b[12:], ndp16NoCRC)
	le.PutUint16(b[16:], 96)
	le.PutUint16(b[20:], iphethNCMHeader)
	le.PutUint16(b[22:], uint16(len(frame)))
	b = append(b, frame...)
	le.PutUint16(b[8:], uint16(len(b)))
	return b
}

func openTAP(name string) (*os.File, error) {
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var ifr struct {
		name  [unix.IFNAMSIZ]byte
		flags uint16
		_     [22]byte
	}
	copy(ifr.name[:], name)
	ifr.flags = unix.IFF_TAP | unix.IFF_NO_PI
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.TUNSETIFF, uintptr(unsafe.Pointer(&ifr))); errno != 0 {
		unix.Close(fd)
		return nil, fmt.Errorf("TUNSETIFF %s: %v", name, errno)
	}
	return os.NewFile(uintptr(fd), "tap"), nil
}
