package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"path/filepath"
	"reflect"
	"testing"
)

// The builders below assemble descriptor blobs the way sysfs hands them
// over: a device descriptor, then each configuration whole.

func deviceDesc() []byte {
	d := make([]byte, 18)
	d[0], d[1] = 18, 1
	binary.LittleEndian.PutUint16(d[8:10], 0x12d1)
	binary.LittleEndian.PutUint16(d[10:12], 0x14dc)
	return d
}

func configDesc(value byte, parts ...[]byte) []byte {
	body := bytes.Join(parts, nil)
	d := make([]byte, 9)
	d[0], d[1] = 9, 2
	binary.LittleEndian.PutUint16(d[2:4], uint16(9+len(body)))
	d[5] = value
	return append(d, body...)
}

func ifaceDesc(num, alt, class, subclass byte) []byte {
	return []byte{9, 4, num, alt, 0, class, subclass, 0, 0}
}

func endpointDesc(addr byte, mps uint16) []byte {
	d := []byte{7, 5, addr, 2, 0, 0, 0} // bulk
	binary.LittleEndian.PutUint16(d[4:6], mps)
	return d
}

func unionDesc(master, slave byte) []byte { return []byte{5, 0x24, 0x06, master, slave} }

func ethernetDesc(macIndex byte, maxSegment uint16) []byte {
	d := make([]byte, 13)
	d[0], d[1], d[2], d[3] = 13, 0x24, 0x0f, macIndex
	binary.LittleEndian.PutUint16(d[8:10], maxSegment)
	return d
}

// hilinkDesc is a Huawei HiLink stick in network mode: ECM on interfaces
// 0+1 (data endpoints under alt 1), mass storage on interface 2.
func hilinkDesc() []byte {
	return append(deviceDesc(), configDesc(1,
		ifaceDesc(0, 0, 0x02, 0x06),
		unionDesc(0, 1),
		ethernetDesc(3, 1514),
		[]byte{7, 5, 0x83, 3, 16, 0, 4}, // interrupt notification
		ifaceDesc(1, 0, 0x0a, 0x00),
		ifaceDesc(1, 1, 0x0a, 0x00),
		endpointDesc(0x82, 512),
		endpointDesc(0x02, 512),
		ifaceDesc(2, 0, 0x08, 0x06),
		endpointDesc(0x84, 512),
		endpointDesc(0x04, 512),
	)...)
}

// activeFunction parses desc as a device in configuration conf.
func activeFunction(desc []byte, conf int, kind string) (netFunction, bool) {
	return usbDeviceInfo{vidpid: "1234:5678", config: conf, configs: parseDescriptors(desc)}.function(kind)
}

func TestParseECMHiLink(t *testing.T) {
	fn, ok := activeFunction(hilinkDesc(), 1, kindECM)
	if !ok {
		t.Fatal("no ECM function found")
	}
	want := netFunction{kind: kindECM, config: 1, commIface: 0, dataIface: 1, dataAlt: 1,
		bulkIn: 0x82, bulkOut: 0x02, inPacket: 512, outPacket: 512, notify: 0x83,
		macIndex: 3, maxSegment: 1514}
	if fn != want {
		t.Fatalf("got %+v, want %+v", fn, want)
	}
}

func TestParseECMActiveConfig(t *testing.T) {
	// ECM sits in configuration 2; configuration 1 carries only storage.
	desc := deviceDesc()
	desc = append(desc, configDesc(1,
		ifaceDesc(0, 0, 0x08, 0x06),
		endpointDesc(0x81, 512), endpointDesc(0x01, 512))...)
	desc = append(desc, configDesc(2,
		ifaceDesc(0, 0, 0x02, 0x06),
		unionDesc(0, 1),
		ethernetDesc(4, 1514),
		ifaceDesc(1, 0, 0x0a, 0x00),
		endpointDesc(0x83, 64), endpointDesc(0x03, 64))...)
	fn, ok := activeFunction(desc, 2, kindECM)
	if !ok || fn.bulkIn != 0x83 || fn.dataAlt != 0 {
		t.Fatalf("got %+v ok=%v", fn, ok)
	}
	if _, ok := activeFunction(desc, 1, kindECM); ok {
		t.Fatal("found ECM in configuration 1, which has none")
	}
}

func TestParseECMRejectsGarbage(t *testing.T) {
	for _, desc := range [][]byte{
		nil,
		{0},
		{2, 1},
		append(deviceDesc(), []byte{9, 2, 0xff, 0xff, 1, 1, 0, 0, 0, 3, 4}...),
		append(deviceDesc(), configDesc(1, ifaceDesc(0, 0, 0x02, 0x02))...), // ACM, not ECM
		append(deviceDesc(), configDesc(1, // ECM without its Union
			ifaceDesc(0, 0, 0x02, 0x06), ifaceDesc(1, 0, 0x0a, 0x00),
			endpointDesc(0x81, 512), endpointDesc(0x01, 512))...),
	} {
		for _, kind := range []string{kindECM, kindNCM, kindRNDIS, kindIPhone} {
			if _, ok := activeFunction(desc, 1, kind); ok {
				t.Errorf("% x: claimed a %s function", desc, kind)
			}
		}
	}
}

func TestStorageEndpoints(t *testing.T) {
	iface, in, out, ok := storageEndpoints(parseDescriptors(hilinkDesc()), 1)
	if !ok || iface != 2 || in != 0x84 || out != 0x04 {
		t.Fatalf("got iface %d in 0x%02x out 0x%02x ok %v", iface, in, out, ok)
	}
}

func macStringDesc(mac string) []byte {
	d := []byte{byte(2 + 2*len(mac)), 3}
	for _, c := range mac {
		d = append(d, byte(c), 0)
	}
	return d
}

func TestParseMACString(t *testing.T) {
	mac, err := parseMACString(macStringDesc("02AB34cd56EF"))
	if err != nil {
		t.Fatal(err)
	}
	if want := []byte{0x02, 0xab, 0x34, 0xcd, 0x56, 0xef}; !reflect.DeepEqual(mac, want) {
		t.Fatalf("got %x want %x", mac, want)
	}
	for _, bad := range [][]byte{nil, {4, 3, '0', 0}, macStringDesc("02ab34cd56e!")} {
		if _, err := parseMACString(bad); err == nil {
			t.Errorf("% x: accepted", bad)
		}
	}
}

// The switch bytes are a 31-byte mass-storage command block.
func TestHuaweiSwitchCBW(t *testing.T) {
	cbw, err := hex.DecodeString(huaweiSwitchCBW)
	if err != nil {
		t.Fatal(err)
	}
	if len(cbw) != 31 || string(cbw[:4]) != "USBC" {
		t.Fatalf("%d bytes, signature %q", len(cbw), cbw[:4])
	}
}

func TestSwitchable(t *testing.T) {
	cd := usbDeviceInfo{vidpid: "12d1:1f01"}
	stick := usbDeviceInfo{vidpid: "12d1:14dc"}
	c := defaults()
	any := newScanUplink("usbecm", c)
	if !any.switchable(cd) || any.switchable(stick) {
		t.Fatal("default switchable wrong")
	}
	c.USBDevice = "0525:a4a2"
	if newScanUplink("usbecm", c).switchable(cd) {
		t.Fatal("switches another vendor's stick for a named device")
	}
	c.USBDevice = "12d1:14db"
	if !newScanUplink("auto", c).switchable(cd) {
		t.Fatal("does not switch the named vendor's stick")
	}
}

func TestUplinkChoices(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.conf")
	writeFile(t, p, "uids = 12990\n")
	c, err := loadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if up, _ := parseUplink(c); up.String() != "auto" {
		t.Fatalf("default uplink %q, want auto", up)
	}
	for _, spec := range []string{"auto", "usb", "usbecm", "rndis", "ncm", "iphone"} {
		writeFile(t, p, "uids = 12990\nuplink = "+spec+"\n")
		c, err := loadConfig(p)
		if err != nil {
			t.Fatal(err)
		}
		up, err := parseUplink(c)
		if err != nil {
			t.Fatal(err)
		}
		su, ok := up.(*scanUplink)
		if !ok || up.String() != spec {
			t.Fatalf("%s: uplink is %T %q", spec, up, up)
		}
		if want := 1; spec == "auto" {
			if !reflect.DeepEqual(su.kinds, autoKinds) {
				t.Fatalf("auto covers %v", su.kinds)
			}
		} else if len(su.kinds) != want || su.kinds[0] != spec {
			t.Fatalf("%s covers %v", spec, su.kinds)
		}
	}
}

// rndisGadgetDesc is the mainline f_rndis gadget: an IAD, the control
// interface 02/02/ff with its Union and a notification endpoint, the data
// interface 0a/00/00.
func rndisGadgetDesc(ctl [3]byte, union bool) []byte {
	parts := [][]byte{
		{8, 0x0b, 0, 2, 0xef, 0x04, 0x01, 0}, // IAD
		{9, 4, 0, 0, 1, ctl[0], ctl[1], ctl[2], 0},
	}
	if union {
		parts = append(parts, unionDesc(0, 1))
	}
	parts = append(parts, []byte{7, 5, 0x81, 3, 8, 0, 9},
		ifaceDesc(1, 0, 0x0a, 0x00), endpointDesc(0x82, 512), endpointDesc(0x01, 512))
	return append(deviceDesc(), configDesc(1, parts...)...)
}

func TestRNDISFunction(t *testing.T) {
	for _, ctl := range [][3]byte{{0x02, 0x02, 0xff}, {0xe0, 0x01, 0x03}, {0xef, 0x04, 0x01}} {
		for _, union := range []bool{true, false} {
			fn, ok := activeFunction(rndisGadgetDesc(ctl, union), 1, kindRNDIS)
			if !ok || fn.commIface != 0 || fn.dataIface != 1 || fn.bulkIn != 0x82 || fn.bulkOut != 0x01 ||
				fn.notify != 0x81 || fn.outPacket != 512 {
				t.Errorf("% x union %v: %+v %v", ctl, union, fn, ok)
			}
			if _, ok := activeFunction(rndisGadgetDesc(ctl, union), 1, kindECM); ok {
				t.Errorf("% x: taken for ECM", ctl)
			}
		}
	}
	// ACM proper (02/02/01) is a serial port.
	if _, ok := activeFunction(rndisGadgetDesc([3]byte{2, 2, 1}, true), 1, kindRNDIS); ok {
		t.Error("ACM taken for RNDIS")
	}
}

// ncmGadgetDesc is the f_ncm gadget: control 02/0d/00 with Header, Union,
// Ethernet and NCM descriptors; data 0a/00/01 with no endpoints at alt 0
// and the bulk pair at alt 1.
func ncmGadgetDesc() []byte {
	return append(deviceDesc(), configDesc(1,
		[]byte{8, 0x0b, 0, 2, 0x02, 0x0d, 0x00, 0},
		[]byte{9, 4, 0, 0, 1, 0x02, 0x0d, 0x00, 0},
		[]byte{5, 0x24, 0x00, 0x10, 0x01},
		unionDesc(0, 1),
		ethernetDesc(5, 1514),
		[]byte{6, 0x24, 0x1a, 0x00, 0x01, 0x11},
		[]byte{7, 5, 0x81, 3, 16, 0, 9},
		[]byte{9, 4, 1, 0, 0, 0x0a, 0x00, 0x01, 0},
		[]byte{9, 4, 1, 1, 2, 0x0a, 0x00, 0x01, 0},
		endpointDesc(0x82, 512), endpointDesc(0x01, 512),
	)...)
}

func TestNCMFunction(t *testing.T) {
	fn, ok := activeFunction(ncmGadgetDesc(), 1, kindNCM)
	want := netFunction{kind: kindNCM, config: 1, commIface: 0, dataIface: 1, dataAlt: 1,
		bulkIn: 0x82, bulkOut: 0x01, inPacket: 512, outPacket: 512, notify: 0x81,
		macIndex: 5, maxSegment: 1514, ncmCaps: 0x11}
	if !ok || fn != want {
		t.Fatalf("got %+v %v, want %+v", fn, ok, want)
	}
	if _, ok := activeFunction(ncmGadgetDesc(), 1, kindECM); ok {
		t.Fatal("NCM taken for ECM")
	}
}

// iphoneDesc is an iPhone in its default mode: four configurations, PTP
// in each, usbmux from configuration 3, the hotspot interface in 4.
func iphoneDesc(withHotspot bool) []byte {
	ptp := [][]byte{ifaceDesc(0, 0, 0x06, 0x01), endpointDesc(0x81, 512), endpointDesc(0x02, 512)}
	mux := [][]byte{{9, 4, 1, 0, 2, 0xff, 0xfe, 0x02, 0}, endpointDesc(0x04, 512), endpointDesc(0x85, 512)}
	eth := [][]byte{{9, 4, 2, 0, 0, 0xff, 0xfd, 0x01, 0}, {9, 4, 2, 1, 2, 0xff, 0xfd, 0x01, 0},
		endpointDesc(0x86, 512), endpointDesc(0x07, 512)}
	desc := deviceDesc()
	desc = append(desc, configDesc(1, ptp...)...)
	desc = append(desc, configDesc(2, ptp...)...)
	desc = append(desc, configDesc(3, append(append([][]byte{}, ptp...), mux...)...)...)
	c4 := append(append([][]byte{}, ptp...), mux...)
	if withHotspot {
		c4 = append(c4, eth...)
	}
	return append(desc, configDesc(4, c4...)...)
}

func TestIPhoneFunction(t *testing.T) {
	info := usbDeviceInfo{vidpid: "05ac:12a8", config: 1, configs: parseDescriptors(iphoneDesc(true))}
	fn, ok := info.function(kindIPhone)
	want := netFunction{kind: kindIPhone, config: 4, commIface: 2, dataIface: 2, dataAlt: 1,
		bulkIn: 0x86, bulkOut: 0x07, inPacket: 512, outPacket: 512,
		muxIface: 1, muxIn: 0x85, muxOut: 0x04, muxOutPacket: 512, numConfigurations: 4}
	if !ok || fn != want {
		t.Fatalf("got %+v %v, want %+v", fn, ok, want)
	}
	info.configs = parseDescriptors(iphoneDesc(false))
	if _, ok := info.function(kindIPhone); ok {
		t.Fatal("took a configuration without the hotspot interface")
	}
	info = usbDeviceInfo{vidpid: "1234:12a8", config: 1, configs: parseDescriptors(iphoneDesc(true))}
	if _, ok := info.function(kindIPhone); ok {
		t.Fatal("took a non-Apple device")
	}
}
