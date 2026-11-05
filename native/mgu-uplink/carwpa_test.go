package main

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCar is the car's D-Bus wpa_supplicant with one station interface:
// networks as wpa_supplicant keeps them (quoted strings, hex SSIDs), a
// scan list, and an association to the best enabled network in range whose
// password is right, made when the interface is looked at.
type fakeCar struct {
	mu           sync.Mutex
	iface        string
	path         objPath
	has          bool
	disabled     bool // interface_disabled
	nets         map[objPath]map[string]string
	next         int
	current      objPath
	disconnected bool
	bss          []fakeBSS
	calls        []string
	state        string
	groups       map[string]fakeGroup // the P2P group interfaces, by name
	refuse       string               // a network property Set refuses
	autoStart    []string             // calls sent without NO_AUTO_START
	slowGet      time.Duration        // a BSS's Frequency answers this late
}

// fakeGroup is a P2P group interface of the car's supplicant.
type fakeGroup struct {
	path objPath
	freq uint16
}

type fakeBSS struct {
	ssid   string
	signal int16
	psk    string // "" open
	freq   uint16 // MHz; 0: not reported
}

func (f *fakeCar) bssPath(i int) objPath { return objPath(fmt.Sprintf("%s/BSSs/%d", f.path, i)) }

// associate joins the best enabled network in range, as the supplicant's
// scans would, or leaves the current one when it is gone or disabled.
func (f *fakeCar) associate() {
	if f.current != "" {
		if n, ok := f.nets[f.current]; !ok || n["disabled"] == "1" || f.inRange(n) < 0 {
			f.current = ""
		}
	}
	if f.current != "" || f.disconnected {
		f.setState()
		return
	}
	var ids []objPath
	for p := range f.nets {
		ids = append(ids, p)
	}
	sort.Slice(ids, func(i, j int) bool { return prio(f.nets[ids[i]]) > prio(f.nets[ids[j]]) })
	for _, p := range ids {
		if n := f.nets[p]; n["disabled"] != "1" && f.inRange(n) >= 0 {
			f.current = p
			break
		}
	}
	f.setState()
}

func prio(n map[string]string) int {
	var v int
	fmt.Sscan(n["priority"], &v)
	return v
}

func (f *fakeCar) setState() {
	enabled := false
	for _, n := range f.nets {
		enabled = enabled || n["disabled"] != "1"
	}
	switch {
	case f.disabled:
		f.state = "interface_disabled"
	case f.current != "":
		f.state = "completed"
	case enabled && !f.disconnected:
		f.state = "scanning"
	default:
		f.state = "disconnected"
	}
}

// inRange is the BSS the network can join (its name, and the right
// password or none), -1 none.
func (f *fakeCar) inRange(n map[string]string) int {
	ssid, _ := hex.DecodeString(n["ssid"])
	for i, b := range f.bss {
		if b.ssid != string(ssid) {
			continue
		}
		if b.psk == "" && n["key_mgmt"] == "NONE" || b.psk != "" && n["psk"] == `"`+b.psk+`"` {
			return i
		}
	}
	return -1
}

func (f *fakeCar) netPaths() []objPath {
	var out []objPath
	for p := range f.nets {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// add puts a network in, as AddNetwork does: disabled unless the
// properties say otherwise.
func (f *fakeCar) add(props map[string]any) objPath {
	n := map[string]string{"disabled": "1"}
	for k, v := range props {
		switch x := v.(dbusVariant).val.(type) {
		case []byte:
			n[k] = hex.EncodeToString(x)
		case string:
			if k == "key_mgmt" || k == "scan_freq" || k == "freq_list" {
				n[k] = x
			} else {
				n[k] = `"` + x + `"`
			}
		default:
			n[k] = fmt.Sprint(x)
		}
	}
	f.next++
	p := objPath(fmt.Sprintf("%s/Networks/%d", f.path, f.next))
	f.nets[p] = n
	return p
}

func (f *fakeCar) reply(m dbusMsg) (string, string, []any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, m.member)
	if m.flags&dbusNoAutoStart == 0 {
		f.autoStart = append(f.autoStart, m.member)
	}
	unknown := func() (string, string, []any) { return "org.freedesktop.DBus.Error.UnknownObject", "", nil }
	switch m.member {
	case "GetInterface":
		if g, ok := f.groups[m.body[0].(string)]; ok {
			return "", "o", []any{g.path}
		}
		if !f.has || m.body[0] != f.iface {
			return wpaDBus + ".InterfaceUnknown", "", nil
		}
		return "", "o", []any{f.path}
	case "GetAll":
		switch {
		case m.path == f.path && f.has:
			f.associate()
			cur, bss := objPath("/"), objPath("/")
			if f.current != "" {
				cur, bss = f.current, f.bssPath(f.inRange(f.nets[f.current]))
			}
			var bsss []objPath
			for i := range f.bss {
				bsss = append(bsss, f.bssPath(i))
			}
			return "", "a{sv}", []any{dbusProps{
				{"State", dbusVariant{"s", f.state}},
				{"Networks", dbusVariant{"ao", f.netPaths()}},
				{"CurrentNetwork", dbusVariant{"o", cur}},
				{"CurrentBSS", dbusVariant{"o", bss}},
				{"BSSs", dbusVariant{"ao", bsss}},
			}}
		case f.nets[m.path] != nil:
			var props dbusProps
			for k, v := range f.nets[m.path] {
				props = append(props, dbusProp{k, dbusVariant{"s", v}})
			}
			return "", "a{sv}", []any{dbusProps{
				{"Properties", dbusVariant{"a{sv}", props}},
				{"Enabled", dbusVariant{"b", f.nets[m.path]["disabled"] != "1"}},
			}}
		}
		for i, b := range f.bss {
			if m.path == f.bssPath(i) {
				return "", "a{sv}", []any{dbusProps{
					{"SSID", dbusVariant{"ay", []byte(b.ssid)}},
					{"Signal", dbusVariant{"n", b.signal}},
					{"Privacy", dbusVariant{"b", b.psk != ""}},
				}}
			}
		}
		return unknown()
	case "Set":
		n := f.nets[m.path]
		if n == nil {
			return unknown()
		}
		if m.body[1] == "Enabled" {
			n["disabled"] = map[bool]string{true: "0", false: "1"}[m.body[2].(dbusVariant).val == true]
		}
		if m.body[1] == "Properties" {
			for k, v := range m.body[2].(dbusVariant).val.(map[string]any) {
				if k == f.refuse {
					return wpaDBus + ".InvalidArgs", "", nil
				}
				n[k] = v.(dbusVariant).val.(string)
			}
		}
		return "", "", nil
	case "Get":
		if m.path == f.path && f.has && m.body[1] == "CurrentBSS" {
			f.associate()
			if f.current == "" {
				return "", "v", []any{dbusVariant{"o", objPath("/")}}
			}
			return "", "v", []any{dbusVariant{"o", f.bssPath(f.inRange(f.nets[f.current]))}}
		}
		for i, b := range f.bss {
			if m.path == f.bssPath(i) && m.body[1] == "Frequency" {
				if b.freq == 0 {
					return "org.freedesktop.DBus.Error.InvalidArgs", "", nil
				}
				return "", "v", []any{dbusVariant{"q", b.freq}}
			}
		}
		for _, g := range f.groups {
			switch {
			case m.path == g.path && m.body[0] == wpaDBusP2P && m.body[1] == "Group":
				return "", "v", []any{dbusVariant{"o", g.path + "/Groups/1"}}
			case m.path == g.path+"/Groups/1" && m.body[0] == wpaDBusGroup && m.body[1] == "Frequency":
				return "", "v", []any{dbusVariant{"q", g.freq}}
			}
		}
		return unknown()
	case "AddNetwork":
		return "", "o", []any{f.add(m.body[0].(map[string]any))}
	case "RemoveNetwork":
		p := m.body[0].(objPath)
		if f.nets[p] == nil {
			return wpaDBus + ".NetworkUnknown", "", nil
		}
		delete(f.nets, p)
		return "", "", nil
	case "SelectNetwork":
		p := m.body[0].(objPath)
		if f.nets[p] == nil {
			return wpaDBus + ".NetworkUnknown", "", nil
		}
		for q, n := range f.nets {
			n["disabled"] = map[bool]string{true: "0", false: "1"}[q == p]
		}
		f.current, f.disconnected = "", false
		return "", "", nil
	case "Reassociate":
		f.disconnected = false
		return "", "", nil
	case "Disconnect":
		f.current, f.disconnected = "", true
		return "", "", nil
	case "Scan":
		return "", "", nil
	}
	return "org.freedesktop.DBus.Error.UnknownMethod", "", nil
}

// serve answers calls on the fake system bus socket.
func (f *fakeCar) serve(t *testing.T) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "bus")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	old := systemBusSocket
	systemBusSocket = sock
	t.Cleanup(func() { systemBusSocket = old })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go f.conn(c)
		}
	}()
}

func (f *fakeCar) conn(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	r.ReadByte()
	r.ReadString('\n')
	c.Write([]byte("OK 0123456789abcdef0123456789abcdef\r\n"))
	r.ReadString('\n')
	var serial uint32 = 100
	for {
		m, err := dbusRead(r)
		if err != nil {
			return
		}
		serial++
		if m.member == "Hello" {
			c.Write(fakeReply(serial, m.serial, "", "s", ":1.42"))
			continue
		}
		errName, sig, vals := f.reply(m)
		f.mu.Lock()
		var slow time.Duration
		if m.member == "Get" && len(m.body) > 1 && m.body[1] == "Frequency" {
			slow = f.slowGet
		}
		f.mu.Unlock()
		time.Sleep(slow)
		if errName != "" {
			c.Write(fakeReply(serial, m.serial, errName, "s", "failed"))
		} else {
			c.Write(fakeReply(serial, m.serial, "", sig, vals...))
		}
	}
}

// fakeReply is a method return (or an error) with vals encoded as sig.
func fakeReply(serial, replyTo uint32, errName, sig string, vals ...any) []byte {
	var body dbusEnc
	rest := sig
	for _, v := range vals {
		n := sigNext(rest)
		if err := body.value(rest[:n], v); err != nil {
			panic(err)
		}
		rest = rest[n:]
	}
	h := dbusEnc{b: make([]byte, 16)}
	field := func(code byte, s string, v any) {
		h.pad(8)
		h.b = append(h.b, code)
		h.value("g", s)
		h.value(s, v)
	}
	field(dbusFieldReplySerial, "u", replyTo)
	typ := byte(dbusMethodReturn)
	if errName != "" {
		typ = dbusError
		field(dbusFieldErrorName, "s", errName)
	}
	if sig != "" {
		field(dbusFieldSignature, "g", sig)
	}
	m := h.b
	copy(m, []byte{'l', typ, 0, 1})
	binary.LittleEndian.PutUint32(m[4:], uint32(len(body.b)))
	binary.LittleEndian.PutUint32(m[8:], serial)
	binary.LittleEndian.PutUint32(m[12:], uint32(len(m)-16))
	return append(dbusPad(m, 8), body.b...)
}

func (f *fakeCar) do(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

// ours and theirs: the networks tagged as ours and the others.
func (f *fakeCar) count() (ours, theirs int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range f.nets {
		if n["id_str"] == `"`+carTag+`"` {
			ours++
		} else {
			theirs++
		}
	}
	return
}

func (f *fakeCar) called(member string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == member {
			n++
		}
	}
	return n
}

// carProvider is a provider on a unit without its own radio: the car's
// Broadcom station wlanc0 and the fake car supplicant.
func carProvider(t *testing.T) (*wifiProvider, config, *fakeCar) {
	fastWiFi(t)
	old := dbusTimeout
	dbusTimeout = time.Second
	t.Cleanup(func() { dbusTimeout = old })
	dir := t.TempDir()
	c := defaults()
	c.RunDir, c.StateDir, c.WiFiIf = filepath.Join(dir, "run"), filepath.Join(dir, "state"), "wlant1"
	os.MkdirAll(c.RunDir, 0755)
	p := newWiFiProvider(c, os.Args[0])
	p.sys, p.proc, p.connmanConf = filepath.Join(dir, "sys"), filepath.Join(dir, "proc"), filepath.Join(dir, "main.conf")
	p.carIf, p.bcmdhd = "wlanc0", filepath.Join(dir, "module", "bcmdhd")
	p.car = newCarSupplicant("wlanc0", c.wpaConf(), c.wpaCtrl())
	p.groupFreq = p.car.groupFreq
	os.MkdirAll(p.proc, 0755)
	os.MkdirAll(p.bcmdhd, 0755)
	writeFile(t, filepath.Join(p.sys, "wlanc0", "ifindex"), "26\n")
	// the car's radio: connman runs (it manages wlanc0), the D-Bus supplicant too
	writeFile(t, filepath.Join(p.proc, "50", "cmdline"), "/usr/sbin/connmand\x00-n\x00")
	writeFile(t, filepath.Join(p.proc, "51", "cmdline"), "/usr/sbin/wpa_supplicant\x00-u\x00-s\x00")
	writeFile(t, filepath.Join(p.sys, "wlanc0", "phy80211", "rfkill6", "soft"), "0\n")
	p.linkUp = func(iface string) (linkState, error) {
		v, _ := readSysctl(filepath.Join(p.sys, iface, "ifindex"))
		var idx int
		fmt.Sscan(v, &idx)
		return linkState{Index: idx, Name: iface, OrigName: iface, WasUp: true}, nil
	}
	p.iftype = func(string) (uint32, error) { return nl80211Station, nil }
	p.dbusHas = func(string) (bool, error) { t.Error("asked about the D-Bus supplicant as a user"); return false, nil }
	f := &fakeCar{iface: "wlanc0", path: "/fi/w1/wpa_supplicant1/Interfaces/13", has: true, nets: map[objPath]map[string]string{},
		bss: []fakeBSS{{"Robert’s iPhone", -44, "rightpass1", 0}, {"Cafe", -60, "", 0}, {"DIGI-m8Yj", -84, "x", 0}}}
	f.serve(t)
	return p, c, f
}

// The car-supplicant backend: networks from the car's supplicant's scan,
// a wrong password not saved and its network gone, the right one joined
// and saved in our wpa.conf, only tagged networks of ours in the car's
// supplicant, and all of them removed when the provider stops.
func TestCarWiFi(t *testing.T) {
	p, c, f := carProvider(t)
	p.start()
	stopped := false
	defer func() {
		if !stopped {
			p.stop()
		}
	}()
	waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" })
	if f.called("GetInterface") != 0 {
		t.Fatal("asked the car's supplicant while off")
	}
	p.setEnabled(true)
	st := waitWiFi(t, p, "idle with 3 networks", func(st wifiStatus) bool { return st.Link == "idle" && len(st.Networks) == 3 })
	if st.Backend != backendCar || p.ifname() != "wlanc0" || !p.guarding() {
		t.Fatalf("backend %q on %s, guarding %v", st.Backend, p.ifname(), p.guarding())
	}
	if n := st.Networks[0]; n.SSID != "Robert’s iPhone" || n.Signal != -44 || !n.Secure || st.Networks[1].Secure {
		t.Fatalf("networks %+v", st.Networks)
	}
	if v, _ := readSysctl(filepath.Join(p.sys, "wlanc0", "phy80211", "rfkill6", "soft")); v != "0" {
		t.Fatal("touched the car's rfkill")
	}
	if err := p.scan(); err != nil || f.called("Scan") != 1 {
		t.Fatalf("scan: %v", err)
	}

	if err := p.connect("Robert’s iPhone", "wrongpass9"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "connecting", func(st wifiStatus) bool { return st.Link == "connecting" && len(st.Saved) == 0 })
	waitWiFi(t, p, "join failed", func(st wifiStatus) bool {
		return st.Error != nil && strings.Contains(*st.Error, "could not join Robert’s iPhone") && len(st.Saved) == 0
	})
	if ours, theirs := f.count(); ours != 0 || theirs != 0 || exists(c.wpaConf()) {
		t.Fatalf("after a wrong password: %d ours, %d theirs, wpa.conf %v", ours, theirs, exists(c.wpaConf()))
	}

	if err := p.connect("Robert’s iPhone", "rightpass1"); err != nil {
		t.Fatal(err)
	}
	st = waitWiFi(t, p, "joined", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == "Robert’s iPhone" && reflect.DeepEqual(st.Saved, []string{"Robert’s iPhone"})
	})
	if st.Signal == nil || *st.Signal != -44 || !st.Networks[0].Current || !st.Networks[0].Saved {
		t.Fatalf("joined: %+v", st)
	}
	b, _ := os.ReadFile(c.wpaConf())
	if !strings.Contains(string(b), "ssid="+hex.EncodeToString([]byte("Robert’s iPhone"))) || !strings.Contains(string(b), `psk="rightpass1"`) {
		t.Fatalf("wpa.conf:\n%s", b)
	}
	if fi, err := os.Stat(filepath.Dir(c.wpaConf())); err != nil || fi.Mode().Perm() != 0700 {
		t.Fatalf("wpa.conf's folder: %v %v", fi, err)
	}
	if fi, err := os.Stat(c.wpaConf()); err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("wpa.conf: %v %v", fi, err)
	}
	if ours, theirs := f.count(); ours != 1 || theirs != 0 {
		t.Fatalf("in the car's supplicant: %d ours, %d theirs", ours, theirs)
	}
	l := p.openLink("Robert’s iPhone")
	if l.Ifname() != "wlanc0" {
		t.Fatalf("link on %s", l.Ifname())
	}
	p.setOnline("172.20.10.4", "")
	waitWiFi(t, p, "online", func(st wifiStatus) bool { return st.Link == "online" })

	// An open network, then forgetting it: back on the saved one.
	if err := p.connect("Cafe", ""); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "on Cafe", func(st wifiStatus) bool { return st.Link != "connecting" && st.SSID == "Cafe" })
	waitDone(t, l, "joined Cafe instead")
	if err := p.forget("Cafe"); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "back on the iPhone", func(st wifiStatus) bool {
		return st.Link != "connecting" && st.SSID == "Robert’s iPhone" && reflect.DeepEqual(st.Saved, []string{"Robert’s iPhone"})
	})

	stopped = true
	p.stop()
	if ours, theirs := f.count(); ours != 0 || theirs != 0 || f.called("Disconnect") != 1 || p.guarding() {
		t.Fatalf("after stop: %d ours, %d theirs, %d disconnects", ours, theirs, f.called("Disconnect"))
	}
	f.do(func() {
		if len(f.autoStart) > 0 {
			t.Errorf("calls that could start the car's supplicant: %v", f.autoStart)
		}
	})
}

// Saved networks come back after a restart; a network a killed run left
// in the car's supplicant is removed first; switching off removes ours.
func TestCarWiFiSaved(t *testing.T) {
	p, _, f := carProvider(t)
	if err := p.car.writeSaved([]savedNet{{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 5}}); err != nil {
		t.Fatal(err)
	}
	f.do(func() {
		f.add(map[string]any{"ssid": dbusVariant{"ay", []byte("Old")}, "id_str": dbusVariant{"s", carTag}})
	})
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "joined the saved network", func(st wifiStatus) bool {
		return st.Link == "connected" && st.SSID == "Robert’s iPhone"
	})
	if ours, _ := f.count(); ours != 1 {
		t.Fatalf("%d networks of ours, want the saved one only", ours)
	}
	p.setEnabled(false)
	waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" && !p.guarding() })
	if ours, _ := f.count(); ours != 0 {
		t.Fatalf("%d networks of ours after off", ours)
	}
}

// The car starts using wlan0 (a network of its own): ours are removed, its
// own stays, and Wi-Fi is unavailable until it is gone again; then the
// saved network is joined again.
func TestCarWiFiTakenBack(t *testing.T) {
	p, _, f := carProvider(t)
	p.car.writeSaved([]savedNet{{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 5}})
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "joined", func(st wifiStatus) bool { return st.Link == "connected" })
	var carNet objPath
	f.do(func() {
		carNet = f.add(map[string]any{"ssid": dbusVariant{"ay", []byte("Cafe")}, "key_mgmt": dbusVariant{"s", "NONE"}})
		for q, n := range f.nets {
			n["disabled"] = map[bool]string{true: "0", false: "1"}[q == carNet]
		}
		f.current = ""
	})
	waitWiFi(t, p, "unavailable", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && strings.Contains(*st.Error, "a network of its own on wlanc0")
	})
	if ours, theirs := f.count(); ours != 0 || theirs != 1 || p.guarding() || f.called("Disconnect") != 0 {
		t.Fatalf("after the car took wlanc0: %d ours, %d theirs, guarding %v, %d disconnects", ours, theirs, p.guarding(), f.called("Disconnect"))
	}
	f.do(func() { delete(f.nets, carNet) })
	waitWiFi(t, p, "joined again", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Robert’s iPhone" })
}

// The car switches its Wi-Fi off under us: unavailable, given back (not a
// failure), and joined again once it is back on.
func TestCarWiFiSwitchedOff(t *testing.T) {
	p, _, f := carProvider(t)
	p.car.writeSaved([]savedNet{{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 5}})
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "joined", func(st wifiStatus) bool { return st.Link == "connected" })
	f.do(func() { f.disabled = true })
	waitWiFi(t, p, "unavailable", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && strings.Contains(*st.Error, "radio is blocked")
	})
	if ours, _ := f.count(); ours != 0 || p.guarding() {
		t.Fatalf("after the car's Wi-Fi went off: %d ours, guarding %v", ours, p.guarding())
	}
	f.do(func() { f.disabled = false })
	waitWiFi(t, p, "joined again", func(st wifiStatus) bool { return st.Link == "connected" })
}

// The driver reloads (suspend): wlan0 comes back with a new index and the
// car's supplicant has it under a new object; the provider takes it again
// and joins the saved network.
func TestCarWiFiResume(t *testing.T) {
	p, _, f := carProvider(t)
	p.car.writeSaved([]savedNet{{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 5}})
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "joined", func(st wifiStatus) bool { return st.Link == "connected" })
	f.do(func() {
		f.path, f.nets, f.current = "/fi/w1/wpa_supplicant1/Interfaces/14", map[objPath]map[string]string{}, ""
	})
	writeFile(t, filepath.Join(p.sys, "wlanc0", "ifindex"), "27\n")
	waitWiFi(t, p, "joined after the reload", func(st wifiStatus) bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return st.Link == "connected" && st.SSID == "Robert’s iPhone" && p.ownedIdx == 27
	})
}

// enabledOurs counts our networks in the car's supplicant that are enabled.
func (f *fakeCar) enabledOurs() (on, all int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range f.nets {
		if n["id_str"] == `"`+carTag+`"` {
			all++
			if n["disabled"] != "1" {
				on++
			}
		}
	}
	return
}

// While the uplink is online on a device that outranks Wi-Fi, our networks
// are off (no station scans), except for a scan request; on again when it
// is not; an association and a device Wi-Fi outranks are left alone; stop
// and off remove them as before.
func TestCarWiFiQuiet(t *testing.T) {
	p, _, f := carProvider(t)
	shown := scanShown
	scanShown = 300 * time.Millisecond
	t.Cleanup(func() { scanShown = shown })
	p.outranks = func(kind string) bool { return kind == kindIPhone }
	p.car.writeSaved([]savedNet{{ssid: "Home", psk: "homepass1", priority: 5}})
	p.setEnabled(true)
	p.start()
	stopped := false
	defer func() {
		if !stopped {
			p.stop()
		}
	}()
	enabled := func(want int) func(wifiStatus) bool {
		return func(wifiStatus) bool { on, all := f.enabledOurs(); return all == 1 && on == want }
	}
	waitWiFi(t, p, "scanning for Home", func(st wifiStatus) bool { return st.Link == "scanning" && enabled(1)(st) })
	reassoc := f.called("Reassociate")

	// online on a device Wi-Fi outranks: nothing changes
	p.setOnline("", kindUSB)
	time.Sleep(10 * wifiEvery)
	if st := p.status(); st.Link != "scanning" || !enabled(1)(st) {
		t.Fatalf("under a usb uplink Wi-Fi outranks: %+v", st)
	}

	p.setOnline("", kindIPhone)
	waitWiFi(t, p, "paused under the iPhone", func(st wifiStatus) bool { return st.Link == "idle" && enabled(0)(st) })

	// a connect request while paused joins, then out of range: paused again
	f.do(func() { f.bss = append(f.bss, fakeBSS{"Home", -50, "homepass1", 0}) })
	if err := p.connect("Home", ""); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "joined Home while paused", func(st wifiStatus) bool { return st.Link == "connected" && enabled(1)(st) })
	f.do(func() { f.bss = f.bss[:len(f.bss)-1] })
	waitWiFi(t, p, "paused again", func(st wifiStatus) bool { return st.Link == "idle" && enabled(0)(st) })

	// a scan request: on for the scan, then off again
	if err := p.scan(); err != nil {
		t.Fatal(err)
	}
	waitWiFi(t, p, "on for the scan", enabled(1))
	waitWiFi(t, p, "paused after the scan", func(st wifiStatus) bool { return st.Link == "idle" && !st.Scanning && enabled(0)(st) })

	// a supplicant retake (reload) while paused adds ours off, no Reassociate
	if err := p.car.reload(); err != nil {
		t.Fatal(err)
	}
	if on, all := f.enabledOurs(); on != 0 || all != 1 || f.called("Reassociate") != reassoc {
		t.Fatalf("reload while paused: %d of %d on, %d reassociates", on, all, f.called("Reassociate")-reassoc)
	}

	// the iPhone goes: on again, as before
	p.setOnline("", "")
	waitWiFi(t, p, "scanning again", func(st wifiStatus) bool { return st.Link == "scanning" && enabled(1)(st) })

	// joined Home, then the iPhone online: the association stays
	f.do(func() { f.bss = append(f.bss, fakeBSS{"Home", -50, "homepass1", 0}) })
	waitWiFi(t, p, "joined Home", func(st wifiStatus) bool { return st.Link == "connected" && st.SSID == "Home" })
	p.setOnline("", kindIPhone)
	time.Sleep(10 * wifiEvery)
	if st := p.status(); st.Link != "connected" || !enabled(1)(st) {
		t.Fatalf("joined under the iPhone: %+v", st)
	}

	// out of range again: paused; switched off: ours removed as before
	f.do(func() { f.bss = f.bss[:len(f.bss)-1] })
	waitWiFi(t, p, "paused out of range", func(st wifiStatus) bool { return st.Link == "idle" && enabled(0)(st) })
	p.setEnabled(false)
	waitWiFi(t, p, "off", func(st wifiStatus) bool { return st.Link == "off" && !p.guarding() })
	if _, all := f.enabledOurs(); all != 0 || p.car.quiet {
		t.Fatalf("after off: %d of ours, quiet %v", all, p.car.quiet)
	}
	// on again with the iPhone still online: added on, then paused
	p.setEnabled(true)
	waitWiFi(t, p, "paused after on", func(st wifiStatus) bool { return st.Link == "idle" && enabled(0)(st) })
	stopped = true
	p.stop()
	if _, all := f.enabledOurs(); all != 0 || p.car.quiet {
		t.Fatalf("after stop: %d of ours, quiet %v", all, p.car.quiet)
	}
}

// Without wlan1 the car's wlan0 is used only with the Broadcom driver; with
// neither, Wi-Fi is unavailable and nothing is asked; with wlan1, wlan1.
func TestWiFiPick(t *testing.T) {
	p, _, f := carProvider(t)
	os.RemoveAll(p.bcmdhd)
	p.setEnabled(true)
	p.start()
	waitWiFi(t, p, "no radio", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && *st.Error == "no Wi-Fi radio (wlant1)" && st.Backend == ""
	})
	p.stop()
	if f.called("GetInterface") != 0 || p.guarding() {
		t.Fatal("used wlan0 without the Broadcom driver")
	}

	p, _, f = carProvider(t)
	f.do(func() { f.has = false })
	p.setEnabled(true)
	p.start()
	waitWiFi(t, p, "the car's supplicant lacks wlan0", func(st wifiStatus) bool {
		return st.Link == "unavailable" && st.Error != nil && strings.Contains(*st.Error, "does not have wlanc0")
	})
	p.stop()

	p, _, f = carProvider(t)
	writeFile(t, filepath.Join(p.sys, "wlant1", "phy80211", "rfkill1", "soft"), "0\n")
	os.RemoveAll(filepath.Join(p.proc, "50")) // connman leaves wlan1 alone
	p.dbusHas = func(string) (bool, error) { return false, nil }
	t.Setenv(fakeWPAEnv, filepath.Join(t.TempDir(), "scan"))
	p.setEnabled(true)
	p.start()
	defer p.stop()
	waitWiFi(t, p, "wlan1 through mgu-wpa", func(st wifiStatus) bool { return st.Link == "idle" && st.Backend == backendMGU })
	if f.called("GetInterface") != 0 || p.ifname() != "wlant1" {
		t.Fatalf("on %s, %d calls to the car's supplicant", p.ifname(), f.called("GetInterface"))
	}
}

func TestWPAConf(t *testing.T) {
	dir := t.TempDir()
	s := newCarSupplicant("wlan0", filepath.Join(dir, "wifi", "wpa.conf"), "/run/mgu-uplink/wpa")
	in := []savedNet{
		{ssid: "Home", psk: `pa"ss"#1x`, priority: 9},
		{ssid: "Robert’s iPhone", psk: "rightpass1", priority: 7},
		{ssid: "Cafe", open: true, priority: 3},
		{ssid: "Raw", raw: make([]byte, 32), priority: 1},
	}
	if err := s.writeSaved(in); err != nil {
		t.Fatal(err)
	}
	got, err := s.readSaved()
	if err != nil || !reflect.DeepEqual(got, in) {
		t.Fatalf("read back %+v %v", got, err)
	}
	// as SAVE_CONFIG writes it, with a comment
	writeFile(t, s.conf, "ctrl_interface=/x\nnetwork={\n\tssid=\"Home\" # mine\n\tpsk=\"abc#defgh\"\n\tpriority=2\n}\n")
	if got, _ := s.readSaved(); len(got) != 1 || got[0].psk != "abc#defgh" || got[0].priority != 2 {
		t.Fatalf("SAVE_CONFIG's file: %+v", got)
	}
	writeFile(t, s.conf, "network={\n\tssid=\"Home\"\n")
	if got, _ := s.readSaved(); got != nil || !s.takeSetAside() || !exists(s.conf+".bad") {
		t.Fatalf("unreadable file: %+v", got)
	}
}

// Values of every kind the car's supplicant sends come back as sent.
func TestDBusCodec(t *testing.T) {
	var e dbusEnc
	props := dbusProps{
		{"State", dbusVariant{"s", "completed"}},
		{"BSSs", dbusVariant{"ao", []objPath{"/a", "/b"}}},
		{"SSID", dbusVariant{"ay", []byte("x\x00y")}},
		{"Signal", dbusVariant{"n", int16(-44)}},
		{"Privacy", dbusVariant{"b", true}},
		{"Properties", dbusVariant{"a{sv}", dbusProps{{"id_str", dbusVariant{"s", `"mgu-uplink"`}}}}},
	}
	if err := e.value("a{sv}", props); err != nil {
		t.Fatal(err)
	}
	m := append(make([]byte, 16), e.b...)
	d := &dbusDec{b: m, i: 16, o: binary.LittleEndian}
	v, err := d.value("a{sv}")
	if err != nil {
		t.Fatal(err)
	}
	got := v.(map[string]any)
	if s, _ := prop[string](got, "State"); s != "completed" {
		t.Errorf("State %v", got["State"])
	}
	if p := paths(got, "BSSs"); !reflect.DeepEqual(p, []objPath{"/a", "/b"}) {
		t.Errorf("BSSs %v", p)
	}
	if b, _ := prop[[]byte](got, "SSID"); string(b) != "x\x00y" {
		t.Errorf("SSID %q", b)
	}
	if n, _ := prop[int16](got, "Signal"); n != -44 {
		t.Errorf("Signal %v", n)
	}
	inner, _ := prop[map[string]any](got, "Properties")
	if s, _ := inner["id_str"].(dbusVariant).val.(string); s != `"mgu-uplink"` {
		t.Errorf("Properties %v", inner)
	}
	if d.i != len(m) {
		t.Errorf("read %d of %d bytes", d.i, len(m))
	}
	if err := e.value("a{sv}", map[string]string{}); err == nil {
		t.Error("sent a value of the wrong type")
	}
	if _, err := (&dbusDec{b: m[:20], i: 16, o: binary.LittleEndian}).value("a{sv}"); err == nil {
		t.Error("read a cut message")
	}
}
