package main

// A USB stick as sysfs shows it: its CDC-ECM function, found by walking its
// descriptors (the communications interface, class 02 subclass 06, and the
// data interface its Union names, class 0a, with the bulk endpoints under
// one alternate setting, the driver MAC string index and the largest
// segment the device sends), and the mode switch of a stick still in its
// CD-ROM mode. The descriptor walking is exercised by usbecm_test.go.

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ecmFunction is one CDC-ECM function inside one configuration.
type ecmFunction struct {
	commIface  int  // communications interface number
	dataIface  int  // data interface number
	dataAlt    int  // data alternate setting carrying the bulk endpoints
	bulkIn     byte // device -> host endpoint address
	bulkOut    byte // host -> device endpoint address
	inPacket   int  // bulk IN wMaxPacketSize
	outPacket  int  // bulk OUT wMaxPacketSize
	macIndex   int  // string index of the driver's MAC address, 0 if none
	maxSegment int  // Ethernet functional descriptor's wMaxSegmentSize
}

type ifaceInfo struct {
	num, alt             int
	class, subclass      byte
	slaveIface           int // from a Union functional descriptor, -1 if none
	macIndex, maxSegment int
	bulkIn, bulkOut      byte
	inPacket, outPacket  int
}

// parseECM walks a sysfs "descriptors" blob (device descriptor, then each
// configuration with its interfaces) and returns the complete ECM function
// in configuration conf, the active one: its data interface has a bulk
// endpoint in each direction. Malformed trailing bytes end the walk, never
// a panic.
func parseECM(desc []byte, conf int) (ecmFunction, bool) {
	var fn ecmFunction
	rest := desc
	// The blob starts with the device descriptor.
	if len(rest) < 2 || int(rest[0]) < 2 || len(rest) < int(rest[0]) {
		return fn, false
	}
	rest = rest[rest[0]:]
	for len(rest) >= 9 && rest[1] == 2 { // CONFIGURATION
		total := int(binary.LittleEndian.Uint16(rest[2:4]))
		if total < 9 || total > len(rest) {
			total = len(rest)
		}
		if int(rest[5]) == conf {
			return parseECMConfig(rest[:total])
		}
		rest = rest[total:]
	}
	return fn, false
}

func parseECMConfig(conf []byte) (ecmFunction, bool) {
	var fn ecmFunction
	var ifaces []*ifaceInfo
	var cur *ifaceInfo
	for off := 0; off+2 <= len(conf); {
		l, typ := int(conf[off]), conf[off+1]
		if l < 2 || off+l > len(conf) {
			break
		}
		d := conf[off : off+l]
		switch typ {
		case 4: // INTERFACE
			if l >= 9 {
				cur = &ifaceInfo{num: int(d[2]), alt: int(d[3]), class: d[5], subclass: d[6], slaveIface: -1}
				ifaces = append(ifaces, cur)
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
				}
			}
		case 5: // ENDPOINT
			if cur != nil && l >= 7 && d[3]&0x03 == 2 { // bulk
				pkt := int(binary.LittleEndian.Uint16(d[4:6]))
				if d[2]&0x80 != 0 {
					cur.bulkIn, cur.inPacket = d[2], pkt
				} else {
					cur.bulkOut, cur.outPacket = d[2], pkt
				}
			}
		}
		off += l
	}
	for _, c := range ifaces {
		if c.class != 0x02 || c.subclass != 0x06 || c.slaveIface < 0 { // Communications, ECM, with its Union
			continue
		}
		for _, d := range ifaces {
			if d.class != 0x0a || d.num != c.slaveIface || d.bulkIn == 0 || d.bulkOut == 0 {
				continue
			}
			fn.commIface, fn.dataIface, fn.dataAlt = c.num, d.num, d.alt
			fn.bulkIn, fn.bulkOut = d.bulkIn, d.bulkOut
			fn.inPacket, fn.outPacket = d.inPacket, d.outPacket
			fn.macIndex, fn.maxSegment = c.macIndex, c.maxSegment
			return fn, true
		}
	}
	return fn, false
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

const sysBusUSB = "/sys/bus/usb/devices"

// usbDeviceInfo is one USB device as sysfs lists it.
type usbDeviceInfo struct {
	sysName  string // "1-2" under sysBusUSB
	bus, dev int
	vidpid   string // "12d1:14dc"
	config   int    // active bConfigurationValue, 0 when unconfigured
	fn       ecmFunction
	hasECM   bool
}

func (u usbDeviceInfo) String() string {
	return fmt.Sprintf("USB %s (%s, bus %d device %d)", u.sysName, u.vidpid, u.bus, u.dev)
}

// scanUSBDevices lists the USB devices under sysBusUSB with their ids and,
// where their active configuration has one, their ECM function.
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
		info.config, _ = strconv.Atoi(sysValue(readSysctl(filepath.Join(dir, "bConfigurationValue"))))
		if desc, err := os.ReadFile(filepath.Join(dir, "descriptors")); err == nil {
			info.fn, info.hasECM = parseECM(desc, info.config)
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
	desc, err := os.ReadFile(filepath.Join(sysBusUSB, info.sysName, "descriptors"))
	if err != nil {
		return err
	}
	iface, in, out, ok := storageEndpoints(desc, info.config)
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
func storageEndpoints(desc []byte, conf int) (iface int, in, out byte, ok bool) {
	rest := desc
	if len(rest) < 2 || int(rest[0]) < 2 || len(rest) < int(rest[0]) {
		return 0, 0, 0, false
	}
	rest = rest[rest[0]:]
	for len(rest) >= 9 && rest[1] == 2 {
		total := int(binary.LittleEndian.Uint16(rest[2:4]))
		if total < 9 || total > len(rest) {
			total = len(rest)
		}
		blob := rest[:total]
		if conf == 0 || int(blob[5]) == conf {
			cur := -1
			storage := false
			for off := 0; off+2 <= len(blob); {
				l, typ := int(blob[off]), blob[off+1]
				if l < 2 || off+l > len(blob) {
					break
				}
				d := blob[off : off+l]
				switch typ {
				case 4:
					if l >= 9 {
						cur, storage = int(d[2]), d[5] == 0x08
					}
				case 5:
					if storage && l >= 7 && d[3]&0x03 == 2 {
						if d[2]&0x80 != 0 {
							in = d[2]
						} else {
							out = d[2]
						}
						if in != 0 && out != 0 {
							return cur, in, out, true
						}
					}
				}
				off += l
			}
		}
		rest = rest[total:]
	}
	return 0, 0, 0, false
}
