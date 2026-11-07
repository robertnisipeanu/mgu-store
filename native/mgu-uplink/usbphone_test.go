package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The shipped conf takes phones over USB; the settings file switches them
// off, and a value it can't take is skipped.
func TestUSBPhoneSetting(t *testing.T) {
	if c, err := loadConfig("mgu-uplink.conf"); err != nil || !c.USBPhone {
		t.Fatalf("shipped: %v %v", c.USBPhone, err)
	}
	if !defaults().USBPhone {
		t.Fatal("a conf without usb_phone leaves phones alone")
	}
	dir := t.TempDir()
	conf, settings := filepath.Join(dir, "u.conf"), filepath.Join(dir, "settings.conf")
	writeFile(t, conf, "uplink = auto\nusb_phone = on\nsettings_conf = "+settings+"\n")
	if err := setSetting(settings, "usb_phone", "off"); err != nil {
		t.Fatal(err)
	}
	if c, err := loadConfig(conf); err != nil || c.USBPhone || len(c.Skipped) != 0 {
		t.Fatalf("set: %v %v %v", c.USBPhone, c.Skipped, err)
	}
	writeFile(t, settings, "usb_phone = maybe\n")
	if c, err := loadConfig(conf); err != nil || !c.USBPhone || len(c.Skipped) != 1 {
		t.Fatalf("bad value: %v %v %v", c.USBPhone, c.Skipped, err)
	}
}

// fakeUSBSysfs puts an iPhone (1-3.1), an Android phone in RNDIS tethering
// (1-4) and a CDC-ECM stick (1-5) under sysBusUSB.
func fakeUSBSysfs(t *testing.T) {
	fakeIPhoneSysfs(t, 9)
	for sys, d := range map[string]struct {
		vid, pid string
		desc     []byte
	}{
		"1-4": {"18d1", "4ee3", rndisGadgetDesc([3]byte{0x02, 0x02, 0xff}, true)},
		"1-5": {"12d1", "14dc", hilinkDesc()},
	} {
		dir := filepath.Join(sysBusUSB, sys)
		for name, v := range map[string]string{"idVendor": d.vid, "idProduct": d.pid, "busnum": "1",
			"devnum": "5", "bConfigurationValue": "1"} {
			writeFile(t, filepath.Join(dir, name), v+"\n")
		}
		writeFile(t, filepath.Join(dir, "descriptors"), string(d.desc))
	}
}

func candidateKinds(u *scanUplink) []string {
	var out []string
	for _, c := range u.candidates() {
		out = append(out, c.kind)
	}
	return out
}

// Off, the scan passes every phone by and the stick stays; on, the phones
// are back, each in its usual place.
func TestUSBPhoneCandidates(t *testing.T) {
	defer func(s string) { sysBusUSB = s }(sysBusUSB)
	sysBusUSB = t.TempDir()
	fakeUSBSysfs(t)
	c := defaults()
	c.USBPhone = false
	u := newScanUplink(c)
	if got := candidateKinds(u); !reflect.DeepEqual(got, []string{kindECM}) {
		t.Fatalf("off: %v", got)
	}
	u.setUSBPhone(true)
	if got := candidateKinds(u); !reflect.DeepEqual(got, []string{kindECM, kindRNDIS, kindIPhone}) {
		t.Fatalf("on: %v", got)
	}
	u.setPreferred("phone")
	u.setUSBPhone(false)
	if got := candidateKinds(u); !reflect.DeepEqual(got, []string{kindECM}) {
		t.Fatalf("off with phone preferred: %v", got)
	}
}

// Off, an iPhone's take stops before its first deauthorize: the phone is
// not switched to another configuration, so nothing asks it for Trust.
func TestUSBPhoneOffNoTake(t *testing.T) {
	defer func(s string) { sysBusUSB = s }(sysBusUSB)
	sysBusUSB = t.TempDir()
	fakeIPhoneSysfs(t, 9)
	u := newScanUplink(defaults())
	cand, ok := iphoneCandidate(u)
	if !ok {
		t.Fatal("no iPhone while on")
	}
	u.setUSBPhone(false)
	if _, err := u.open(context.Background(), cand); !errors.Is(err, errPhoneOff) {
		t.Fatalf("open: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sysBusUSB, "1-3.1", "authorized")); !os.IsNotExist(err) {
		t.Fatalf("authorized written: %v", err)
	}
}

// fakeLink is a running link that records its Close.
type fakeLink struct {
	done   chan struct{}
	closed chan struct{}
}

func newFakeLink() *fakeLink {
	return &fakeLink{done: make(chan struct{}), closed: make(chan struct{})}
}

func (l *fakeLink) Ifname() string        { return Ifname }
func (l *fakeLink) Done() <-chan struct{} { return l.done }
func (l *fakeLink) Err() error            { return nil }
func (l *fakeLink) Close()                { close(l.closed) }
func (l *fakeLink) String() string        { return "fake" }

func ended(l Link) bool {
	select {
	case <-l.Done():
		return true
	case <-time.After(300 * time.Millisecond):
		return false
	}
}

// Switching phones off ends a phone's link at once, which the session
// closes as it closes an unplugged one; a stick's link runs on. Switched
// on again, the phone is a candidate again.
func TestUSBPhoneOffEndsPhoneLink(t *testing.T) {
	defer func(s string) { sysBusUSB = s }(sysBusUSB)
	sysBusUSB = t.TempDir()
	fakeIPhoneSysfs(t, 9)
	u := newScanUplink(defaults())
	for _, kind := range []string{kindIPhone, kindRNDIS, kindNCM, kindECM, kindUSB} {
		u.setUSBPhone(true)
		inner := newFakeLink()
		l := u.watchPreferred(inner, candidate{kind: kind})
		if ended(l) {
			t.Fatalf("%s: ended while on", kind)
		}
		u.setUSBPhone(false)
		if got := ended(l); got != isPhoneKind(kind) {
			t.Fatalf("%s: ended %v after the switch-off", kind, got)
		}
		if isPhoneKind(kind) && !errors.Is(l.Err(), errPhoneOff) {
			t.Fatalf("%s: %v", kind, l.Err())
		}
		l.Close()
		select {
		case <-inner.closed:
		default:
			t.Fatalf("%s: not closed", kind)
		}
	}
	// a phone link opened while off (switched off during its take) ends at once
	l := u.watchPreferred(newFakeLink(), candidate{kind: kindIPhone})
	if !ended(l) {
		t.Fatal("a phone link opened while off runs")
	}
	l.Close()
	if _, ok := iphoneCandidate(u); ok {
		t.Fatal("an iPhone candidate while off")
	}
	u.setUSBPhone(true)
	if _, ok := iphoneCandidate(u); !ok {
		t.Fatal("no iPhone after switching on again")
	}
	l = u.watchPreferred(newFakeLink(), candidate{kind: kindIPhone})
	defer l.Close()
	if ended(l) {
		t.Fatal("a phone link opened after switching on again ended")
	}
}

// The usb-phone request keeps the setting, switches the scan and shows in
// status.json; with a named interface there is none.
func TestUSBPhoneRequest(t *testing.T) {
	dir := t.TempDir()
	c := defaults()
	c.RunDir, c.Settings = dir, filepath.Join(dir, "settings.conf")
	writeFile(t, c.Settings, "wifi = on\n")
	statusInit(c.statusFile())
	defer statusInit("")
	setStatus(nil, stateSearching, "")
	on := true
	setStatusUSBPhone(&on)
	su := newScanUplink(c)
	s := &service{cfg: c, up: su}
	status := func() uplinkStatus {
		t.Helper()
		var st uplinkStatus
		b, _ := os.ReadFile(c.statusFile())
		if err := json.Unmarshal(b, &st); err != nil {
			t.Fatalf("%s: %v", b, err)
		}
		return st
	}
	if st := status(); st.USBPhone == nil || !*st.USBPhone {
		t.Fatalf("status before: %+v", st)
	}
	if err := s.request(ctlRequest{Op: "usb-phone"}); err == nil || !strings.Contains(err.Error(), "on: true or false") {
		t.Fatalf("no on: %v", err)
	}
	off := false
	if err := s.request(ctlRequest{Op: "usb-phone", On: &off}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(c.Settings); string(b) != "wifi = on\nusb_phone = off\n" {
		t.Fatalf("settings_conf:\n%s", b)
	}
	if on, _ := su.phoneGate(); on {
		t.Fatal("the scan still takes phones")
	}
	if st := status(); st.USBPhone == nil || *st.USBPhone {
		t.Fatalf("status after: %+v", st)
	}
	if err := s.request(ctlRequest{Op: "usb-phone", On: &on}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(c.Settings); string(b) != "wifi = on\nusb_phone = on\n" {
		t.Fatalf("settings_conf:\n%s", b)
	}
	if on, _ := su.phoneGate(); !on {
		t.Fatal("the scan does not take phones again")
	}
	s = &service{cfg: c, up: &netdevUplink{name: "eth1"}}
	if err := s.request(ctlRequest{Op: "usb-phone", On: &off}); err == nil {
		t.Fatal("accepted with uplink netdev:")
	}
	setStatusUSBPhone(nil)
	if b, _ := os.ReadFile(c.statusFile()); strings.Contains(string(b), "usbPhone") {
		t.Fatalf("status.json names it without the scan: %s", b)
	}
}
