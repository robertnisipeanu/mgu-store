package main

// The user-space relay every usbfs uplink shares (ECM sticks, Android
// phones over RNDIS or NCM, iPhones). The device's bulk endpoints feed one
// end of a veth pair; the other end is Ifname, so DHCP, routing, the
// firewall and the lease files see the same kernel interface as with every
// other uplink. A framer wraps and unwraps the device's framing; the relay
// moves plain Ethernet frames. Nothing here loads or changes kernel code:
// usbfs claims, a veth pair and a packet socket are the whole mechanism.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall"
	"unsafe"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// PeerIfname is the relay's end of the veth pair. Frames copied out of it
// go to the device; frames copied into it arrive on Ifname. The prefix is
// on the same connman blacklist as Ifname.
const PeerIfname = "vethuplinkp"

// framer is one network function's framing over its bulk endpoints.
type framer interface {
	// send writes one Ethernet frame to the device.
	send(frame []byte) error
	// recv runs one bulk IN transfer into buf and calls emit for each
	// Ethernet frame it carries.
	recv(buf []byte, emit func([]byte)) error
	// rxSize is the IN transfer buffer the function needs.
	rxSize() int
	pipe() usbPipe
}

// A framer that has work besides the frames (status notifications,
// carrier polling) also implements background; it runs until the link
// stops and may end the link through fail.
type backgroundFramer interface {
	background(stop <-chan struct{}, fail func(error))
}

// A framer that tells the device when the host lets go implements halt.
type haltFramer interface {
	halt()
}

// busyError is a device this service could not take: a CDC device a driver
// or process holds (reported busy and left alone), or an iPhone the media
// daemon kept reclaiming before the uplink could.
type busyError struct{ msg string }

func (e *busyError) Error() string { return e.msg }

func isBusy(err error) bool {
	var b *busyError
	return errors.As(err, &b)
}

// relayLink is one attachment of a usbfs device: the open device, its
// claimed interfaces, the veth pair and the two frame pumps between them.
type relayLink struct {
	kind    string
	info    usbDeviceInfo
	dev     *usbDevice
	claimed []int
	unbound unboundDrivers
	fr      framer
	pktFd   int
	peerIdx int

	done     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	failOnce sync.Once
	wg       sync.WaitGroup
	err      error
}

func (l *relayLink) Ifname() string        { return Ifname }
func (l *relayLink) Done() <-chan struct{} { return l.done }
func (l *relayLink) Err() error            { return l.err }
func (l *relayLink) String() string {
	return fmt.Sprintf("interface %s via %s %s", Ifname, l.kind, l.info)
}

// device is what status.json shows for the link.
func (l *relayLink) device() statusDevice { return statusDevice{Kind: l.kind, Name: l.info.name()} }

func (l *relayLink) fail(err error) {
	l.failOnce.Do(func() {
		l.err = err
		close(l.done)
	})
}

// claimInterfaces claims each interface. One a driver or another process
// holds is a busyError.
func claimInterfaces(dev *usbDevice, info usbDeviceInfo, ifaces ...int) ([]int, error) {
	var claimed []int
	for _, n := range ifaces {
		if err := dev.claimInterface(n); err != nil {
			for _, c := range claimed {
				dev.releaseInterface(c)
			}
			if errors.Is(err, syscall.EBUSY) {
				return nil, &busyError{fmt.Sprintf("%s: interface %d is held by %s", info, n, orUnknown(info.ifaceDriver(n)))}
			}
			return nil, err
		}
		claimed = append(claimed, n)
	}
	return claimed, nil
}

func orUnknown(s string) string {
	if s == "" {
		return "another process"
	}
	return s
}

// startRelay sets up the veth pair with mac on Ifname and the given MTU (0:
// the default) and starts the pumps. On failure it releases everything it
// was handed.
func startRelay(kind string, info usbDeviceInfo, dev *usbDevice, claimed []int, unbound unboundDrivers,
	fr framer, mac []byte, mtu int) (Link, error) {
	l := &relayLink{kind: kind, info: info, dev: dev, claimed: claimed, unbound: unbound, fr: fr,
		pktFd: -1, done: make(chan struct{}), stop: make(chan struct{})}
	if err := l.setupVeth(mac, mtu); err != nil {
		l.teardown()
		return nil, err
	}
	p := fr.pipe()
	logf("%s: %s up, MAC %s, MTU %d, bulk in 0x%02x out 0x%02x", info, kind, net.HardwareAddr(mac), mtuOr1500(mtu), p.in, p.out)
	l.wg.Add(2)
	go l.pumpToDevice()
	go l.pumpFromDevice()
	if bg, ok := fr.(backgroundFramer); ok {
		l.wg.Add(1)
		go func() {
			defer l.wg.Done()
			bg.background(l.stop, l.fail)
		}()
	}
	return l, nil
}

func mtuOr1500(mtu int) int {
	if mtu <= 0 {
		return 1500
	}
	return mtu
}

// functionMAC reads the MAC string the function's Ethernet descriptor
// names. Without a usable one it derives a locally administered address
// from the device's bus position and says so; a device that filters on
// its own address then stays silent, which the log makes findable.
func functionMAC(dev *usbDevice, info usbDeviceInfo, fn netFunction) []byte {
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
	return fallbackMAC(info)
}

func fallbackMAC(info usbDeviceInfo) []byte {
	mac := []byte{0x02, 0x12, 0xd1, byte(info.bus), byte(info.dev), 0x01}
	logf("%s: no MAC from the device, using locally administered %s", info, net.HardwareAddr(mac))
	return mac
}

// setupVeth creates the pair Ifname <-> PeerIfname with mac on Ifname,
// brings both ends up with IPv6 off, and opens the promiscuous packet
// socket on the relay's end.
func (l *relayLink) setupVeth(mac []byte, mtu int) error {
	deleteVethPair()
	peerMAC := append([]byte{}, mac...)
	peerMAC[0] = peerMAC[0]&^0x01 | 0x02
	peerMAC[5] ^= 0x01
	attrs := netlink.LinkAttrs{Name: Ifname, HardwareAddr: net.HardwareAddr(mac)}
	if mtu > 576 && mtu < 1500 {
		attrs.MTU = mtu
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
// hardware and TCP segments of up to 64 KiB, and the device would get them
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

// deleteVethPair removes the relay's veth pair when both names exist and
// are each other's peer — what a killed run leaves behind. Any other
// interface under those names is untouched.
func deleteVethPair() {
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

func (l *relayLink) Close() {
	l.stopOnce.Do(func() { close(l.stop) })
	l.wg.Wait()
	l.teardown()
}

// teardown releases everything the link took, in the order that leaves
// the device free for the kernel drivers it had. Safe to call twice.
func (l *relayLink) teardown() {
	l.stopOnce.Do(func() { close(l.stop) })
	if l.pktFd >= 0 {
		unix.Close(l.pktFd)
		l.pktFd = -1
	}
	deleteVethPair()
	if l.dev == nil {
		return
	}
	select {
	case <-l.done: // the device left, or failed
	default:
		if h, ok := l.fr.(haltFramer); ok {
			h.halt()
		}
	}
	for i := len(l.claimed) - 1; i >= 0; i-- {
		l.dev.releaseInterface(l.claimed[i])
	}
	l.dev.Close()
	l.dev = nil
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

func (l *relayLink) stopped() bool {
	select {
	case <-l.stop:
		return true
	default:
		return false
	}
}

// pumpFromDevice copies the Ethernet frames of each bulk IN transfer into
// the relay's end of the veth pair.
func (l *relayLink) pumpFromDevice() {
	defer l.wg.Done()
	buf := make([]byte, l.fr.rxSize())
	stalls := 0
	emit := func(f []byte) {
		if len(f) < 14 {
			return
		}
		sa := &unix.SockaddrLinklayer{
			Protocol: htons(binary.BigEndian.Uint16(f[12:14])),
			Ifindex:  l.peerIdx, Halen: 6,
		}
		copy(sa.Addr[:], f[:6])
		unix.Sendto(l.pktFd, f, 0, sa) // a frame the veth cannot take is dropped, as on a wire
	}
	for !l.stopped() {
		err := l.fr.recv(buf, emit)
		if err == nil {
			stalls = 0
			continue
		}
		switch {
		case isUSBTimeout(err):
			continue
		case err == syscall.EPIPE: // stalled endpoint
			stalls++
			l.dev.clearHalt(l.fr.pipe().in)
			if stalls > 5 {
				l.fail(fmt.Errorf("%s: bulk in stalled repeatedly", l.info))
				return
			}
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
}

// pumpToDevice copies frames the kernel sends out of Ifname (arriving at
// the relay's end) to the device. Frames this relay itself injected come
// back on the socket marked outgoing and are skipped.
func (l *relayLink) pumpToDevice() {
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
		if err := l.fr.send(buf[:n]); err != nil && isUSBGone(err) {
			if !l.stopped() {
				l.fail(fmt.Errorf("%s went away", l.info))
			}
			return
		}
		// Any other failure drops the frame, as on a wire.
	}
}
