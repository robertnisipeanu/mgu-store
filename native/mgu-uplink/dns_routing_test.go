package main

import (
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

func TestLeaseDNSRules(t *testing.T) {
	c := defaults()
	lease := &Lease{IP: "192.168.0.25", DNS: []string{"192.168.0.1", "1.1.1.1", "192.168.0.1", "bad", "::1", "127.0.0.1", "0.0.0.0", "224.0.0.1"}}
	rules := wantRules(c, []int{12707, 12244}, lease)
	if len(rules) != 9 {
		t.Fatalf("got %d rules, want 9", len(rules))
	}
	for _, uid := range []uint32{12707, 12244} {
		for _, dns := range []string{"192.168.0.1", "1.1.1.1"} {
			k := ruleKey{pref: c.Pref + prefDNS, uid: uid, dst: dns + "/32", table: c.Table}
			r := rules[k]
			if r == nil || r.Dst == nil || r.UIDRange == nil || r.Priority >= c.Pref+prefMain {
				t.Fatalf("missing scoped DNS exception: %+v", k)
			}
			if !strings.Contains(ruleString(*r), " to "+dns+"/32") {
				t.Fatal("status omits DNS destination")
			}
		}
	}
	for k := range wantRules(c, []int{12707}, nil) {
		if k.dst != "" || k.src != "" {
			t.Fatal("offline rules retain lease destinations")
		}
	}
	changed := wantRules(c, []int{12707}, &Lease{IP: "10.0.0.2", DNS: []string{"10.0.0.1"}})
	for k := range changed {
		if strings.HasPrefix(k.dst, "192.168.") || k.src == "192.168.0.25/32" {
			t.Fatal("old lease retained")
		}
	}
}

// A separate process owns the test network namespace; no host routes change.
func TestOverlappingDNSNetwork(t *testing.T) {
	if os.Getenv("MGU_UPLINK_NETNS_CHILD") != "1" {
		if os.Getenv("MGU_UPLINK_NETNS_TEST") != "1" {
			t.Skip("set MGU_UPLINK_NETNS_TEST=1 and run as root for Linux routing integration")
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(exe, "-test.run=^TestOverlappingDNSNetwork$", "-test.v")
		cmd.Env = append(os.Environ(), "MGU_UPLINK_NETNS_CHILD=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: unix.CLONE_NEWNET}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("network namespace test: %v\n%s", err, out)
		}
		t.Log(string(out))
		return
	}
	add := func(name, ip string, flags int) netlink.Link {
		t.Helper()
		link := &netlink.Dummy{LinkAttrs: netlink.LinkAttrs{Name: name}}
		if err := netlink.LinkAdd(link); err != nil {
			t.Fatal(err)
		}
		actual, err := netlink.LinkByName(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := netlink.LinkSetUp(actual); err != nil {
			t.Fatal(err)
		}
		a, err := netlink.ParseAddr(ip)
		if err != nil {
			t.Fatal(err)
		}
		a.Flags = flags
		if err := netlink.AddrAdd(actual, a); err != nil {
			t.Fatal(err)
		}
		return actual
	}
	car := add("socnet0", "192.168.0.17/24", 0)
	wifi := add("wlan1", "192.168.0.25/24", unix.IFA_F_NOPREFIXROUTE)
	c := defaults()
	uid := uint32(12707)
	lease := &Lease{Interface: "wlan1", IP: "192.168.0.25", Prefix: 24, Router: "192.168.0.1", DNS: []string{"192.168.0.1"}}
	if _, err := syncRoutes(c, wifi.Attrs().Index, lease); err != nil {
		t.Fatal(err)
	}
	// Install the released rules to reproduce the DNS route before migration.
	for p := 0; p < 2; p++ {
		r := netlink.NewRule()
		r.Family = netlink.FAMILY_V4
		r.Priority = c.Pref + p
		r.UIDRange = netlink.NewRuleUIDRange(uid, uid)
		r.Table = c.Table
		if p == 0 {
			r.Table = mainTable
			r.SuppressPrefixlen = 0
		}
		if err := netlink.RuleAdd(r); err != nil {
			t.Fatal(err)
		}
	}
	route := func(dst string, source net.IP, u uint32) (int, error) {
		r, err := netlink.RouteGetWithOptions(net.ParseIP(dst), &netlink.RouteGetOptions{UID: &u, SrcAddr: source})
		if err != nil {
			return 0, err
		}
		if len(r) != 1 {
			t.Fatalf("unexpected routes %+v", r)
		}
		return r[0].LinkIndex, nil
	}
	expect := func(dst string, source net.IP, u uint32, index int) {
		t.Helper()
		got, err := route(dst, source, u)
		if err != nil || got != index {
			t.Fatalf("route %s uid %d source %v: interface %d err %v, want %d", dst, u, source, got, err, index)
		}
	}
	expect("192.168.0.1", nil, uid, car.Attrs().Index)
	if _, err := syncRules(c, []int{int(uid)}, lease); err != nil {
		t.Fatal(err)
	}
	expect("192.168.0.1", nil, uid, wifi.Attrs().Index)
	expect("192.168.0.11", nil, uid, car.Attrs().Index)
	expect("1.1.1.1", nil, uid, wifi.Attrs().Index)
	expect("192.168.0.1", net.ParseIP(lease.IP), uid, wifi.Attrs().Index)
	expect("192.168.0.1", nil, 0, car.Attrs().Index)
	if _, err := syncRules(c, []int{int(uid)}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := syncRoutes(c, 0, nil); err != nil {
		t.Fatal(err)
	}
	for _, r := range ownRules(c) {
		if r.Dst != nil || r.Src != nil {
			t.Fatal("lease rule survives disconnect")
		}
	}
	if _, err := route("1.1.1.1", nil, uid); err == nil {
		t.Fatal("offline internet falls through")
	}
	deleteRules(c)
	if len(ownRules(c)) != 0 {
		t.Fatal("cleanup leaves rules")
	}
}
