package main

// USB devices as sysfs shows them: their descriptors, parsed into
// configurations and interfaces, the network functions found there
// (CDC-ECM, CDC-NCM, RNDIS and an iPhone's tethering interface), the kernel
// drivers holding their interfaces, and the mode switch of a stick still in
// its CD-ROM mode. The descriptor walking is exercised by usbdesc_test.go.

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// usbEndpoint is one endpoint descriptor.
type usbEndpoint struct {
	addr      byte
	attr      byte // bmAttributes & 3: 2 bulk, 3 interrupt
	maxPacket int
}

func (e usbEndpoint) bulk() bool      { return e.attr&3 == 2 }
func (e usbEndpoint) interrupt() bool { return e.attr&3 == 3 }
func (e usbEndpoint) in() bool        { return e.addr&0x80 != 0 }

// usbAlt is one interface descriptor (one alternate setting) with its
// endpoints and what its CDC functional descriptors say.
type usbAlt struct {
	num, alt                  int
	class, subclass, protocol byte
	eps                       []usbEndpoint
	slaveIface                int  // Union functional descriptor's bSlaveInterface0, -1 if none
	macIndex                  int  // Ethernet functional descriptor's iMACAddress
	maxSegment                int  // Ethernet functional descriptor's wMaxSegmentSize
	ncmCaps                   byte // NCM functional descriptor's bmNetworkCapabilities
}

func (a usbAlt) triple() [3]byte { return [3]byte{a.class, a.subclass, a.protocol} }

// bulkPair returns the alt setting's bulk IN and OUT endpoints.
func (a usbAlt) bulkPair() (in, out usbEndpoint, ok bool) {
	for _, e := range a.eps {
		if !e.bulk() {
			continue
		}
		if e.in() {
			in = e
		} else {
			out = e
		}
	}
	return in, out, in.addr != 0 && out.addr != 0
}

func (a usbAlt) interruptIn() byte {
	for _, e := range a.eps {
		if e.interrupt() && e.in() {
			return e.addr
		}
	}
	return 0
}

// usbConfig is one configuration: its bConfigurationValue and every
// interface descriptor in it, in descriptor order.
type usbConfig struct {
	value int
	alts  []usbAlt
}

// parseDescriptors walks a sysfs "descriptors" blob: the device descriptor,
// then each configuration whole. Malformed trailing bytes end the walk,
// never a panic.
func parseDescriptors(desc []byte) []usbConfig {
	if len(desc) < 2 || int(desc[0]) < 2 || len(desc) < int(desc[0]) {
		return nil
	}
	rest := desc[desc[0]:]
	var out []usbConfig
	for len(rest) >= 9 && rest[1] == 2 { // CONFIGURATION
		total := int(binary.LittleEndian.Uint16(rest[2:4]))
		if total < 9 || total > len(rest) {
			total = len(rest)
		}
		out = append(out, parseConfig(rest[:total]))
		rest = rest[total:]
	}
	return out
}

func parseConfig(conf []byte) usbConfig {
	c := usbConfig{value: int(conf[5])}
	var cur *usbAlt
	for off := 0; off+2 <= len(conf); {
		l, typ := int(conf[off]), conf[off+1]
		if l < 2 || off+l > len(conf) {
			break
		}
		d := conf[off : off+l]
		switch typ {
		case 4: // INTERFACE
			cur = nil
			if l >= 9 {
				c.alts = append(c.alts, usbAlt{num: int(d[2]), alt: int(d[3]),
					class: d[5], subclass: d[6], protocol: d[7], slaveIface: -1})
				cur = &c.alts[len(c.alts)-1]
			}
		case 0x24: // CS_INTERFACE functional descriptor
			if cur != nil && l >= 3 {
				switch d[2] {
				case 0x06: // Union: master, slave0
					if l >= 5 {
						cur.slaveIface = int(d[4])
					}
				case 0x0f: // Ethernet networking: iMACAddress, stats, wMaxSegmentSize
					if l >= 13 {
						cur.macIndex = int(d[3])
						cur.maxSegment = int(binary.LittleEndian.Uint16(d[8:10]))
					}
				case 0x1a: // NCM: bcdNcmVersion, bmNetworkCapabilities
					if l >= 6 {
						cur.ncmCaps = d[5]
					}
				}
			}
		case 5: // ENDPOINT
			if cur != nil && l >= 7 {
				cur.eps = append(cur.eps, usbEndpoint{addr: d[2], attr: d[3],
					maxPacket: int(binary.LittleEndian.Uint16(d[4:6]) & 0x7ff)})
			}
		}
		off += l
	}
	return c
}

func (c usbConfig) find(num, alt int) *usbAlt {
	for i := range c.alts {
		if c.alts[i].num == num && c.alts[i].alt == alt {
			return &c.alts[i]
		}
	}
	return nil
}

// dataAlt is the alternate setting of interface num with a bulk endpoint
// in each direction, preferring the lowest.
func (c usbConfig) dataAlt(num int, class byte) *usbAlt {
	for i := range c.alts {
		a := &c.alts[i]
		if a.num != num || a.class != class {
			continue
		}
		if _, _, ok := a.bulkPair(); ok {
			return a
		}
	}
	return nil
}

// The network functions a device can carry, in the order the auto uplink
// prefers them (a kernel-driven adapter comes before all of them).
const (
	kindECM    = "usbecm"
	kindRNDIS  = "rndis"
	kindNCM    = "ncm"
	kindIPhone = "iphone"
)

// netFunction is one USB network function inside one configuration.
type netFunction struct {
	kind       string
	config     int  // bConfigurationValue it lives in
	commIface  int  // control interface number
	dataIface  int  // data interface number
	dataAlt    int  // data alternate setting carrying the bulk endpoints
	bulkIn     byte // device -> host endpoint address
	bulkOut    byte // host -> device endpoint address
	inPacket   int  // bulk IN wMaxPacketSize
	outPacket  int  // bulk OUT wMaxPacketSize
	notify     byte // control interface's interrupt IN endpoint, 0 if none
	macIndex   int  // string index of the host-side MAC address, 0 if none
	maxSegment int  // Ethernet functional descriptor's wMaxSegmentSize
	ncmCaps    byte
	// iPhone: the usbmux interface, used for pairing.
	muxIface          int
	muxIn, muxOut     byte
	muxOutPacket      int
	numConfigurations int
}

// rndisControl are the control interface triples RNDIS functions present:
// Android's "wireless controller, RNDIS" class, the CDC-ACM vendor
// variant the mainline f_rndis gadget uses, and the miscellaneous RNDIS
// class some modems use (the rndis_host match table).
var rndisControl = map[[3]byte]bool{
	{0xe0, 0x01, 0x03}: true,
	{0x02, 0x02, 0xff}: true,
	{0xef, 0x04, 0x01}: true,
}

// cdcFunction finds the first network function of kind in the
// configuration: its control interface, and the data interface its Union
// names (an RNDIS function without a Union: the next interface), with a
// bulk endpoint in each direction.
func cdcFunction(c usbConfig, kind string) (netFunction, bool) {
	for _, ctl := range c.alts {
		if ctl.alt != 0 {
			continue
		}
		var data *usbAlt
		switch kind {
		case kindECM:
			if ctl.class != 0x02 || ctl.subclass != 0x06 || ctl.slaveIface < 0 {
				continue
			}
			data = c.dataAlt(ctl.slaveIface, 0x0a)
		case kindNCM:
			if ctl.triple() != [3]byte{0x02, 0x0d, 0x00} || ctl.slaveIface < 0 {
				continue
			}
			data = c.dataAlt(ctl.slaveIface, 0x0a)
		case kindRNDIS:
			if !rndisControl[ctl.triple()] {
				continue
			}
			slave := ctl.slaveIface
			if slave < 0 {
				slave = ctl.num + 1
			}
			data = c.dataAlt(slave, 0x0a)
		}
		if data == nil {
			continue
		}
		in, out, _ := data.bulkPair()
		return netFunction{kind: kind, config: c.value,
			commIface: ctl.num, dataIface: data.num, dataAlt: data.alt,
			bulkIn: in.addr, bulkOut: out.addr, inPacket: in.maxPacket, outPacket: out.maxPacket,
			notify: ctl.interruptIn(), macIndex: ctl.macIndex, maxSegment: ctl.maxSegment, ncmCaps: ctl.ncmCaps}, true
	}
	return netFunction{}, false
}

// iphoneFunction picks an Apple device's configuration the way usbmuxd
// does, the highest one holding a usbmux interface (ff/fe/02, a bulk
// pair), and requires the Personal Hotspot interface (ff/fd/01, bulk pair
// under an alternate setting) in it: configuration 4 of an iPhone in its
// default mode.
func iphoneFunction(configs []usbConfig) (netFunction, bool) {
	best := -1
	for i, c := range configs {
		if best >= 0 && configs[best].value > c.value {
			continue
		}
		for _, a := range c.alts {
			if a.triple() == [3]byte{0xff, 0xfe, 0x02} {
				if _, _, ok := a.bulkPair(); ok {
					best = i
				}
			}
		}
	}
	if best < 0 {
		return netFunction{}, false
	}
	c := configs[best]
	fn := netFunction{kind: kindIPhone, config: c.value, numConfigurations: len(configs)}
	found := false
	for _, a := range c.alts {
		in, out, ok := a.bulkPair()
		if !ok {
			continue
		}
		switch a.triple() {
		case [3]byte{0xff, 0xfe, 0x02}:
			fn.muxIface, fn.muxIn, fn.muxOut, fn.muxOutPacket = a.num, in.addr, out.addr, out.maxPacket
		case [3]byte{0xff, 0xfd, 0x01}:
			if !found {
				fn.commIface, fn.dataIface, fn.dataAlt = a.num, a.num, a.alt
				fn.bulkIn, fn.bulkOut, fn.inPacket, fn.outPacket = in.addr, out.addr, in.maxPacket, out.maxPacket
				found = true
			}
		}
	}
	return fn, found
}

// parseMACString decodes a USB string descriptor holding twelve hex digits
// (the iMACAddress form, UTF-16LE) into the six address bytes.
func parseMACString(desc []byte) ([]byte, error) {
	if len(desc) < 2+24 || desc[1] != 3 { // STRING
		return nil, fmt.Errorf("MAC string descriptor: %d bytes", len(desc))
	}
	mac := make([]byte, 6)
	for i := 0; i < 12; i++ {
		c := desc[2+2*i]
		var v byte
		switch {
		case '0' <= c && c <= '9':
			v = c - '0'
		case 'a' <= c && c <= 'f':
			v = c - 'a' + 10
		case 'A' <= c && c <= 'F':
			v = c - 'A' + 10
		default:
			return nil, fmt.Errorf("MAC string: bad hex digit %q", c)
		}
		if i%2 == 0 {
			mac[i/2] = v << 4
		} else {
			mac[i/2] |= v
		}
	}
	return mac, nil
}

var sysBusUSB = "/sys/bus/usb/devices"

// usbDeviceInfo is one USB device as sysfs lists it.
type usbDeviceInfo struct {
	sysName  string // "1-2" under sysBusUSB
	bus, dev int
	vidpid   string // "12d1:14dc"
	product  string // manufacturer and product strings
	config   int    // active bConfigurationValue, 0 when unconfigured
	configs  []usbConfig
}

func (u usbDeviceInfo) String() string {
	return fmt.Sprintf("USB %s (%s, bus %d device %d)", u.sysName, u.vidpid, u.bus, u.dev)
}

// key identifies this attachment of the device: a replug gets a new
// device number.
func (u usbDeviceInfo) key() string { return fmt.Sprintf("%s#%d", u.sysName, u.dev) }

func (u usbDeviceInfo) name() string {
	if u.product != "" {
		return u.product
	}
	return u.vidpid
}

func (u usbDeviceInfo) active() (usbConfig, bool) {
	for _, c := range u.configs {
		if c.value == u.config {
			return c, true
		}
	}
	return usbConfig{}, false
}

// function returns the device's network function of kind: for an iPhone
// the one in the configuration usbmuxd would pick, for the others the one
// in the active configuration.
func (u usbDeviceInfo) function(kind string) (netFunction, bool) {
	if kind == kindIPhone {
		if !strings.HasPrefix(u.vidpid, "05ac:") {
			return netFunction{}, false
		}
		return iphoneFunction(u.configs)
	}
	c, ok := u.active()
	if !ok {
		return netFunction{}, false
	}
	return cdcFunction(c, kind)
}

// ifaceDriver is the driver bound to interface n of the active
// configuration ("usbfs" when a process holds it), "" when none is.
func (u usbDeviceInfo) ifaceDriver(n int) string {
	link, err := filepath.EvalSymlinks(filepath.Join(sysBusUSB, fmt.Sprintf("%s:%d.%d", u.sysName, u.config, n), "driver"))
	if err != nil {
		return ""
	}
	return filepath.Base(link)
}

// boundIfaces lists the interfaces of the active configuration a driver
// holds, as "n=driver".
func (u usbDeviceInfo) boundIfaces() []string {
	c, _ := u.active()
	seen := map[int]bool{}
	var out []string
	for _, a := range c.alts {
		if seen[a.num] {
			continue
		}
		seen[a.num] = true
		if d := u.ifaceDriver(a.num); d != "" {
			out = append(out, fmt.Sprintf("%d=%s", a.num, d))
		}
	}
	return out
}

// scanUSBDevices lists the USB devices under sysBusUSB with their ids,
// names and descriptors.
func scanUSBDevices() []usbDeviceInfo {
	entries, _ := os.ReadDir(sysBusUSB)
	var out []usbDeviceInfo
	for _, e := range entries {
		dir := filepath.Join(sysBusUSB, e.Name())
		vid, err1 := readSysctl(filepath.Join(dir, "idVendor"))
		pid, err2 := readSysctl(filepath.Join(dir, "idProduct"))
		if err1 != nil || err2 != nil {
			continue // an interface entry ("1-2:1.0"), or half-enumerated
		}
		bus, err1 := strconv.Atoi(sysValue(readSysctl(filepath.Join(dir, "busnum"))))
		dev, err2 := strconv.Atoi(sysValue(readSysctl(filepath.Join(dir, "devnum"))))
		if err1 != nil || err2 != nil {
			continue
		}
		info := usbDeviceInfo{sysName: e.Name(), bus: bus, dev: dev,
			vidpid: strings.ToLower(vid + ":" + pid)}
		info.product = strings.TrimSpace(sysValue(readSysctl(filepath.Join(dir, "manufacturer"))) + " " +
			sysValue(readSysctl(filepath.Join(dir, "product"))))
		info.config, _ = strconv.Atoi(sysValue(readSysctl(filepath.Join(dir, "bConfigurationValue"))))
		if desc, err := os.ReadFile(filepath.Join(dir, "descriptors")); err == nil {
			info.configs = parseDescriptors(desc)
		}
		out = append(out, info)
	}
	return out
}

// sysValue is a sysfs value, or "" when it could not be read.
func sysValue(s string, err error) string { return s }

// unboundDrivers remembers the kernel drivers lifted off a device's
// interfaces so they can be given back afterwards.
type unboundDrivers []usbIfaceDriver

type usbIfaceDriver struct {
	sysName string // interface entry under sysBusUSB, "1-2:1.0"
	driver  string // driver name it was bound to
}

// unbindInterfaces detaches any kernel driver from the named interfaces of
// the device, so the interfaces can be claimed over usbfs. Interfaces with
// no driver bound are left alone.
func unbindInterfaces(dev usbDeviceInfo, ifaces ...int) unboundDrivers {
	var out unboundDrivers
	for _, n := range ifaces {
		name := fmt.Sprintf("%s:%d.%d", dev.sysName, dev.config, n)
		link, err := filepath.EvalSymlinks(filepath.Join(sysBusUSB, name, "driver"))
		if err != nil {
			continue
		}
		drv := filepath.Base(link)
		if drv == "usbfs" {
			continue // another process holds it; the claim says so
		}
		if err := os.WriteFile(filepath.Join(link, "unbind"), []byte(name), 0644); err == nil {
			out = append(out, usbIfaceDriver{name, drv})
		}
	}
	return out
}

// rebind gives the interfaces back to the drivers unbindInterfaces lifted.
func (u unboundDrivers) rebind() {
	for _, d := range u {
		os.WriteFile(filepath.Join("/sys/bus/usb/drivers", d.driver, "bind"), []byte(d.sysName), 0644)
	}
}

// huaweiSwitchCBW is the mass-storage command block usb_modeswitch's
// HuaweiNewMode sends to a Huawei stick still presenting its install
// CD-ROM (12d1:1f01); the stick drops off the bus and returns as a
// network device (12d1:14db or 12d1:14dc).
const huaweiSwitchCBW = "55534243123456780000000000000011062000000101000100000000000000"

// switchDevices are the stick ids that arrive as a CD-ROM and switch into
// one of the ECM ids after huaweiSwitchCBW.
var switchDevices = map[string]bool{"12d1:1f01": true}

// ecmStickDevices are the Huawei HiLink ids the usbecm uplink takes when
// usb_device does not name the stick.
var ecmStickDevices = map[string]bool{"12d1:14db": true, "12d1:14dc": true}

// modeSwitch sends the switch command to the device's mass-storage
// interface: claim it, write the command block on its bulk OUT endpoint,
// read the status block back, release. The device then re-enumerates.
func modeSwitch(info usbDeviceInfo) error {
	iface, in, out, ok := storageEndpoints(info.configs, info.config)
	if !ok {
		return fmt.Errorf("%s: no mass-storage interface to switch", info)
	}
	unb := unbindInterfaces(info, iface)
	defer unb.rebind()
	dev, err := openUSBDevice(info.bus, info.dev)
	if err != nil {
		return err
	}
	defer dev.Close()
	if err := dev.claimInterface(iface); err != nil {
		return err
	}
	defer dev.releaseInterface(iface)
	cbw, _ := hex.DecodeString(huaweiSwitchCBW)
	if _, err := dev.bulk(out, cbw, 5000); err != nil {
		return fmt.Errorf("%s: send switch command: %v", info, err)
	}
	csw := make([]byte, 13)
	dev.bulk(in, csw, 5000) // status block; the stick may already be leaving
	return nil
}

// storageEndpoints finds the first mass-storage interface (class 08) in the
// configuration bConfigurationValue conf (0 matches the first) and its
// bulk endpoints.
func storageEndpoints(configs []usbConfig, conf int) (iface int, in, out byte, ok bool) {
	for _, c := range configs {
		if conf != 0 && c.value != conf {
			continue
		}
		for _, a := range c.alts {
			if a.class != 0x08 {
				continue
			}
			if i, o, ok := a.bulkPair(); ok {
				return a.num, i.addr, o.addr, true
			}
		}
	}
	return 0, 0, 0, false
}
