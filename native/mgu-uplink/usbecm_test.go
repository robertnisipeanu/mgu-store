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

func TestParseECMHiLink(t *testing.T) {
	fn, ok := parseECM(hilinkDesc(), 1)
	if !ok {
		t.Fatal("no ECM function found")
	}
	want := ecmFunction{commIface: 0, dataIface: 1, dataAlt: 1,
		bulkIn: 0x82, bulkOut: 0x02, inPacket: 512, outPacket: 512,
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
	fn, ok := parseECM(desc, 2)
	if !ok || fn.bulkIn != 0x83 || fn.dataAlt != 0 {
		t.Fatalf("got %+v ok=%v", fn, ok)
	}
	if _, ok := parseECM(desc, 1); ok {
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
		if _, ok := parseECM(desc, 1); ok {
			t.Errorf("% x: claimed an ECM function", desc)
		}
	}
}

func TestStorageEndpoints(t *testing.T) {
	iface, in, out, ok := storageEndpoints(hilinkDesc(), 1)
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

func TestECMUplinkMatching(t *testing.T) {
	stick := usbDeviceInfo{vidpid: "12d1:14dc"}
	cd := usbDeviceInfo{vidpid: "12d1:1f01"}
	other := usbDeviceInfo{vidpid: "0525:a4a2"}

	any := &usbECMUplink{}
	if !any.matches(stick) || any.matches(other) || any.matches(cd) {
		t.Fatal("default matching wrong")
	}
	if !any.switchable(cd) || any.switchable(stick) {
		t.Fatal("default switchable wrong")
	}
	named := &usbECMUplink{device: "0525:a4a2"}
	if !named.matches(other) || named.matches(stick) || named.switchable(cd) {
		t.Fatal("named-device matching wrong")
	}
}

func TestUplinkUSBECMConfig(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.conf")
	writeFile(t, p, "uids = 12990\nuplink = usbecm\n")
	c, err := loadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	up, err := parseUplink(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := up.(*usbECMUplink); !ok {
		t.Fatalf("uplink is %T, want *usbECMUplink", up)
	}
	if up.String() != "usbecm" {
		t.Fatalf("String() = %q", up)
	}
}
