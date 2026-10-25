package main

// usbECMUplink is a CDC-ECM USB stick driven from user space over usbfs,
// for sticks the unit's kernel has no driver for. The stick's Ethernet
// frames move over its bulk endpoints to one end of a veth pair; the other
// end is Ifname, so DHCP, routing, the firewall and the lease files see
// the same kernel interface as with every other uplink. A stick still
// presenting its install CD-ROM is switched into network mode first
// (ecmdesc.go). Nothing here loads or changes kernel code: usbfs claims,
// a veth pair and a packet socket are the whole mechanism, the one
// mgu-tether (luigiwidmore/bmw_project tools/tether) runs on the unit for
// RNDIS phones, here with ECM framing: one Ethernet frame per bulk transfer.

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// PeerIfname is the relay's end of the veth pair. Frames copied out of it
// go to the stick; frames copied into it arrive on Ifname. The prefix is
// on the same connman blacklist as Ifname.
const PeerIfname = "vethuplinkp"

// SET_ETHERNET_PACKET_FILTER (CDC-ECM), and the filter asking the stick to
// pass everything on the segment: promiscuous, all multicast, directed
// and broadcast (USB_CDC_PACKET_TYPE_* bits 0-3).
const (
	ecmSetPacketFilter = 0x43
	ecmFilterAll       = 0x000f
)

type usbECMUplink struct {
	device string // VID:PID of the stick, or "" for the known HiLink ids
}

func (u *usbECMUplink) String() string {
	if u.device != "" {
		return "usbecm:" + u.device
	}
	return "usbecm"
}

func (u *usbECMUplink) matches(info usbDeviceInfo) bool {
	if u.device != "" {
		return info.vidpid == u.device
	}
	return ecmStickDevices[info.vidpid]
}

// switchable reports whether the device is a stick in CD-ROM mode that
// modeSwitch turns into one matches accepts.
func (u *usbECMUplink) switchable(info usbDeviceInfo) bool {
	if !switchDevices[info.vidpid] {
		return false
	}
	if u.device != "" {
		return u.device[:5] == info.vidpid[:5] // same vendor
	}
	return true
}

func (u *usbECMUplink) Open(ctx context.Context) (Link, error) {
	waiting := false
	switched := map[string]time.Time{}
	for {
		var toSwitch *usbDeviceInfo
		for _, info := range scanUSBDevices() {
			info := info
			switch {
			case info.hasECM && u.matches(info):
				return openECMLink(info)
			case u.switchable(info):
				toSwitch = &info
			}
		}
		if toSwitch != nil {
			key := toSwitch.sysName
			if last, ok := switched[key]; !ok || time.Since(last) > 30*time.Second {
				switched[key] = time.Now()
				logf("%s is in CD-ROM mode, switching it to a network device", toSwitch)
				if err := modeSwitch(*toSwitch); err != nil {
					logf("mode switch: %v", err)
				}
			}
		}
		if !waiting {
			logf("waiting for a CDC-ECM USB stick (%s)", u)
			waiting = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// ecmLink is one attachment of the stick: the claimed usbfs device, the
// veth pair and the two frame pumps between them.
type ecmLink struct {
	info    usbDeviceInfo
	dev     *usbDevice
	unbound unboundDrivers
	pktFd   int
	peerIdx int

	done     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	failOnce sync.Once
	wg       sync.WaitGroup
	err      error
}

func (l *ecmLink) Ifname() string        { return Ifname }
func (l *ecmLink) Done() <-chan struct{} { return l.done }
func (l *ecmLink) Err() error            { return l.err }
func (l *ecmLink) String() string {
	return fmt.Sprintf("interface %s via %s", Ifname, l.info)
}

func (l *ecmLink) fail(err error) {
	l.failOnce.Do(func() {
		l.err = err
		close(l.done)
	})
}

// openECMLink takes the stick over in its active configuration: claims,
// data alternate setting, packet filter, then the veth pair and the pumps.
func openECMLink(info usbDeviceInfo) (Link, error) {
	fn := info.fn
	dev, err := openUSBDevice(info.bus, info.dev)
	if err != nil {
		return nil, err
	}
	l := &ecmLink{info: info, dev: dev, pktFd: -1,
		done: make(chan struct{}), stop: make(chan struct{})}
	fail := func(err error) (Link, error) {
		l.teardown()
		return nil, err
	}
	l.unbound = unbindInterfaces(info, fn.commIface, fn.dataIface)
	if err := dev.claimInterface(fn.commIface); err != nil {
		return fail(err)
	}
	if err := dev.claimInterface(fn.dataIface); err != nil {
		return fail(err)
	}
	if fn.dataAlt != 0 {
		if err := dev.setInterface(fn.dataIface, fn.dataAlt); err != nil {
			return fail(err)
		}
	}
	if _, err := dev.control(0x21, ecmSetPacketFilter, ecmFilterAll, uint16(fn.commIface), nil, 1000); err != nil {
		logf("%s: set packet filter: %v (continuing)", info, err)
	}
	mac := stickMAC(dev, info)
	if err := l.setupVeth(mac); err != nil {
		return fail(err)
	}
	logf("%s: ECM up, driver MAC %s, bulk in 0x%02x out 0x%02x", info, net.HardwareAddr(mac), fn.bulkIn, fn.bulkOut)
	l.wg.Add(2)
	go l.pumpToStick()
	go l.pumpFromStick()
	return l, nil
}

// stickMAC reads the MAC string the ECM descriptor names. Without a
// usable one it derives a locally administered address from the device's
// bus position and says so; a stick that filters on its own address then
// stays silent, which the log makes findable.
func stickMAC(dev *usbDevice, info usbDeviceInfo) []byte {
	fn := info.fn
	if fn.macIndex > 0 {
		lang := uint16(0x0409)
		buf := make([]byte, 4)
		if n, err := dev.control(0x80, 6, 3<<8|0, 0, buf, 1000); err == nil && n >= 4 {
			lang = binary.LittleEndian.Uint16(buf[2:4])
		}
		buf = make([]byte, 64)
		if n, err := dev.control(0x80, 6, 3<<8|uint16(fn.macIndex), lang, buf, 1000); err == nil {
			if mac, err := parseMACString(buf[:n]); err == nil {
				return mac
			} else {
				logf("%s: %v", info, err)
			}
		} else {
			logf("%s: read MAC string: %v", info, err)
		}
	}
	mac := []byte{0x02, 0x12, 0xd1, byte(info.bus), byte(info.dev), 0x01}
	logf("%s: no MAC string, using locally administered %s", info, net.HardwareAddr(mac))
	return mac
}

// setupVeth creates the pair Ifname <-> PeerIfname with the stick's MAC on
// Ifname, brings both ends up with IPv6 off, and opens the promiscuous
// packet socket on the relay's end.
func (l *ecmLink) setupVeth(mac []byte) error {
	deleteECMVethPair()
	peerMAC := append([]byte{}, mac...)
	peerMAC[0] = peerMAC[0]&^0x01 | 0x02
	peerMAC[5] ^= 0x01
	attrs := netlink.LinkAttrs{Name: Ifname, HardwareAddr: net.HardwareAddr(mac)}
	if seg := l.info.fn.maxSegment; seg > 14+576 && seg-14 < 1500 {
		attrs.MTU = seg - 14
	}
	veth := &netlink.Veth{LinkAttrs: attrs, PeerName: PeerIfname,
		PeerHardwareAddr: net.HardwareAddr(peerMAC)}
	if err := netlink.LinkAdd(veth); err != nil {
		return fmt.Errorf("create veth pair %s/%s: %v", Ifname, PeerIfname, err)
	}
	for _, name := range []string{Ifname, PeerIfname} {
		link, err := netlink.LinkByName(name)
		if err != nil {
			return fmt.Errorf("%s: %v", name, err)
		}
		if name == PeerIfname {
			l.peerIdx = link.Attrs().Index
		} else if err := txChecksumOff(name); err != nil {
			return err
		}
		if err := disableIPv6(name); err != nil {
			return err
		}
		if err := netlink.LinkSetUp(link); err != nil {
			return fmt.Errorf("set %s up: %v", name, err)
		}
	}
	fd, err := packetSocket(l.peerIdx)
	if err != nil {
		return err
	}
	l.pktFd = fd
	return nil
}

// txChecksumOff has the kernel finish every frame leaving ifname: full
// checksums, and TCP cut to the MTU. With the offloads a veth has by
// default, the relay's end would read frames whose checksum is left to
// hardware and TCP segments of up to 64 KiB, and the stick would get them
// that way.
func txChecksumOff(ifname string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
	if err != nil {
		return fmt.Errorf("checksum offload off on %s: %v", ifname, err)
	}
	defer unix.Close(fd)
	val := struct{ cmd, data uint32 }{0x17, 0} // ETHTOOL_STXCSUM, off
	var ifr struct {
		name [unix.IFNAMSIZ]byte
		data unsafe.Pointer
		_    [16]byte // the rest of struct ifreq
	}
	copy(ifr.name[:], ifname)
	ifr.data = unsafe.Pointer(&val)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.SIOCETHTOOL, uintptr(unsafe.Pointer(&ifr))); errno != 0 {
		return fmt.Errorf("checksum offload off on %s: %v", ifname, errno)
	}
	return nil
}

// deleteECMVethPair removes the relay's veth pair when both names exist
// and are each other's peer — what a killed run leaves behind. Any other
// interface under those names is untouched.
func deleteECMVethPair() {
	a, err1 := netlink.LinkByName(Ifname)
	b, err2 := netlink.LinkByName(PeerIfname)
	if err1 != nil || err2 != nil {
		return
	}
	if _, okA := a.(*netlink.Veth); !okA {
		return
	}
	if _, okB := b.(*netlink.Veth); !okB {
		return
	}
	// A veth's sysfs iflink is its peer's index.
	peer, _ := readSysctl(sysClassNet + "/" + Ifname + "/iflink")
	if peer != fmt.Sprint(b.Attrs().Index) {
		return
	}
	if err := netlink.LinkDel(a); err != nil {
		logf("delete veth pair %s/%s: %v", Ifname, PeerIfname, err)
	}
}

func (l *ecmLink) Close() {
	l.stopOnce.Do(func() { close(l.stop) })
	l.wg.Wait()
	l.teardown()
}

// teardown releases everything openECMLink took, in the order that leaves
// the stick free for the kernel drivers it had. Safe to call twice.
func (l *ecmLink) teardown() {
	l.stopOnce.Do(func() { close(l.stop) })
	if l.pktFd >= 0 {
		unix.Close(l.pktFd)
		l.pktFd = -1
	}
	deleteECMVethPair()
	fn := l.info.fn
	l.dev.releaseInterface(fn.dataIface)
	l.dev.releaseInterface(fn.commIface)
	l.dev.Close()
	l.unbound.rebind()
	l.unbound = nil
}

// htons returns v held big-endian (the target is little-endian amd64).
func htons(v uint16) uint16 {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, v)
	return binary.LittleEndian.Uint16(b)
}

// packetSocket opens a promiscuous AF_PACKET socket on the interface with
// a short receive timeout, so the pumps notice a stop within half a second.
func packetSocket(ifindex int) (int, error) {
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW, int(htons(unix.ETH_P_ALL)))
	if err != nil {
		return -1, fmt.Errorf("packet socket: %v", err)
	}
	sa := &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_ALL), Ifindex: ifindex}
	if err := unix.Bind(fd, sa); err != nil {
		unix.Close(fd)
		return -1, fmt.Errorf("bind packet socket to %s: %v", PeerIfname, err)
	}
	mreq := &unix.PacketMreq{Ifindex: int32(ifindex), Type: unix.PACKET_MR_PROMISC}
	if err := unix.SetsockoptPacketMreq(fd, unix.SOL_PACKET, unix.PACKET_ADD_MEMBERSHIP, mreq); err != nil {
		unix.Close(fd)
		return -1, fmt.Errorf("promiscuous %s: %v", PeerIfname, err)
	}
	tv := unix.Timeval{Usec: 500000}
	unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	return fd, nil
}

func (l *ecmLink) stopped() bool {
	select {
	case <-l.stop:
		return true
	default:
		return false
	}
}

// pumpFromStick copies Ethernet frames from the stick's bulk IN endpoint
// into the relay's end of the veth pair. One bulk transfer carries one
// frame, ended by a short packet. A zero-length transfer is the
// terminator of a frame whose length is a whole number of packets and
// carries nothing by itself.
func (l *ecmLink) pumpFromStick() {
	defer l.wg.Done()
	fn := l.info.fn
	size := fn.maxSegment
	if size < 2048 {
		size = 2048
	}
	buf := make([]byte, size)
	stalls := 0
	for !l.stopped() {
		n, err := l.dev.bulk(fn.bulkIn, buf, 500)
		if err != nil {
			switch {
			case isUSBTimeout(err):
				continue
			case err == syscall.EPIPE: // stalled endpoint
				stalls++
				l.dev.clearHalt(fn.bulkIn)
				if stalls > 5 {
					l.fail(fmt.Errorf("%s: bulk in stalled repeatedly", l.info))
					return
				}
				continue
			case isUSBGone(err):
				l.fail(fmt.Errorf("%s went away", l.info))
				return
			default:
				if l.stopped() {
					return
				}
				l.fail(fmt.Errorf("%s: bulk in: %v", l.info, err))
				return
			}
		}
		stalls = 0
		if n < 14 {
			continue
		}
		sa := &unix.SockaddrLinklayer{
			Protocol: htons(binary.BigEndian.Uint16(buf[12:14])),
			Ifindex:  l.peerIdx, Halen: 6,
		}
		copy(sa.Addr[:], buf[:6])
		unix.Sendto(l.pktFd, buf[:n], 0, sa) // a frame the veth cannot take is dropped, as on a wire
	}
}

// pumpToStick copies frames the kernel sends out of Ifname (arriving at
// the relay's end) onto the stick's bulk OUT endpoint, one frame per
// transfer, with a zero-length packet after a frame whose length is a
// whole number of packets. Frames this relay itself injected come back
// on the socket marked outgoing and are skipped.
func (l *ecmLink) pumpToStick() {
	defer l.wg.Done()
	buf := make([]byte, 4096)
	for !l.stopped() {
		n, from, err := unix.Recvfrom(l.pktFd, buf, 0)
		if err != nil {
			if err == syscall.EAGAIN || err == syscall.EWOULDBLOCK || err == syscall.EINTR {
				continue
			}
			if !l.stopped() {
				l.fail(fmt.Errorf("read frame from %s: %v", PeerIfname, err))
			}
			return
		}
		if sa, ok := from.(*unix.SockaddrLinklayer); ok && sa.Pkttype == unix.PACKET_OUTGOING {
			continue
		}
		if n < 14 {
			continue
		}
		if err := l.sendFrame(buf[:n]); err != nil {
			if l.stopped() {
				return
			}
			l.fail(err)
			return
		}
	}
}

func (l *ecmLink) sendFrame(frame []byte) error {
	fn := l.info.fn
	for attempt := 0; ; attempt++ {
		_, err := l.dev.bulk(fn.bulkOut, frame, 5000)
		if err == nil {
			break
		}
		if err == syscall.EPIPE && attempt == 0 {
			l.dev.clearHalt(fn.bulkOut)
			continue
		}
		if isUSBGone(err) {
			return fmt.Errorf("%s went away", l.info)
		}
		return nil // a frame the stick did not take is dropped, as on a wire
	}
	if fn.outPacket > 0 && len(frame)%fn.outPacket == 0 {
		if _, err := l.dev.bulk(fn.bulkOut, nil, 1000); err != nil && isUSBGone(err) {
			return fmt.Errorf("%s went away", l.info)
		}
	}
	return nil
}
