package main

// The uplink seam. An uplink's whole job is to produce a kernel Ethernet
// interface with a DHCP server on the far side. Everything after that point is
// shared and identical for every uplink: udhcpc and its hook, the lease, the
// apps-only routing table and uid rules, the firewall, and the files apps read
// (session.go, netcfg.go, firewall.go, state.go). A new uplink implements
// Uplink and adds a case to parseUplink; an uplink that creates interfaces
// also has cleanup (session.go) remove what a killed run of it left.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/vishvananda/netlink"
)

// Uplink is a way for the unit to reach the internet.
type Uplink interface {
	// Open waits until the uplink is present, brings its interface up and
	// returns it. It returns ctx.Err() once ctx is cancelled.
	Open(ctx context.Context) (Link, error)
	String() string
}

// Link is one attachment of an uplink, from Open until it ends.
type Link interface {
	// Ifname is the interface DHCP runs on and the uplink table routes to.
	Ifname() string
	// Done is closed when the attachment ends by itself (device unplugged,
	// interface removed); Err then says why.
	Done() <-chan struct{}
	Err() error
	// Close ends the attachment and leaves the interface as Open found it.
	Close()
	String() string
}

func parseUplink(c config) (Uplink, error) {
	spec := c.Uplink
	switch {
	case spec == "usb":
		return &usbUplink{device: c.USBDevice, record: c.linkFile()}, nil
	case spec == "usbecm":
		return &usbECMUplink{device: c.USBDevice}, nil
	case strings.HasPrefix(spec, "netdev:"):
		name := strings.TrimPrefix(spec, "netdev:")
		if name == "" || len(name) > 15 || strings.ContainsAny(name, "/ \t") {
			return nil, fmt.Errorf("uplink: bad interface name %q", name)
		}
		return &netdevUplink{name: name, record: c.linkFile()}, nil
	}
	return nil, fmt.Errorf("uplink: %q is none of usb, usbecm, netdev:<ifname>", spec)
}

// netdevUplink is an existing kernel Ethernet interface, named: the
// emulator's second NIC, or any interface the unit already has. It uses the
// interface under its own name and never renames it.
type netdevUplink struct {
	name   string
	record string
}

func (u *netdevUplink) String() string { return "netdev:" + u.name }

func (u *netdevUplink) Open(ctx context.Context) (Link, error) {
	waiting := false
	for {
		if link, err := netlink.LinkByName(u.name); err == nil {
			return openLink(link, u.name, u.record)
		}
		if !waiting {
			logf("waiting for interface %s", u.name)
			waiting = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// openLink returns a nil Link, not a nil *attachedLink, when attach fails.
func openLink(link netlink.Link, name, record string) (Link, error) {
	l, err := attach(link, name, record)
	if err != nil {
		return nil, err
	}
	return l, nil
}

// linkState is an interface's name, IPv6 setting and admin state as attach
// found it. attach saves it in the run dir, so that a start after a killed
// run puts the interface back (restoreLinkState) before attaching it again.
type linkState struct {
	Index    int    `json:"index"`
	Name     string `json:"name"` // while attached
	OrigName string `json:"origName"`
	IPv6     string `json:"ipv6"`
	WasUp    bool   `json:"wasUp"`
}

// attachedLink is an interface taken over for the uplink, from attach until
// Close.
type attachedLink struct {
	linkState
	record string
	done   chan struct{}
	stop   chan struct{}
	err    error
}

// attach takes link over as the uplink interface under name, renaming it if
// it has another, with IPv6 off and the link up.
func attach(link netlink.Link, name, record string) (*attachedLink, error) {
	a := link.Attrs()
	l := &attachedLink{linkState: linkState{Index: a.Index, Name: name, OrigName: a.Name, WasUp: a.Flags&net.FlagUp != 0},
		record: record, done: make(chan struct{}), stop: make(chan struct{})}
	l.IPv6, _ = readSysctl(ipv6Sysctl(a.Name))
	if a.Name != name {
		if other, err := netlink.LinkByName(name); err == nil && other.Attrs().Index != a.Index {
			return nil, fmt.Errorf("rename %s to %s: another interface has that name", a.Name, name)
		}
	}
	if err := writeJSON(record, l.linkState, 0644); err != nil {
		return nil, fmt.Errorf("%s: %v", record, err)
	}
	fail := func(err error) (*attachedLink, error) {
		l.release()
		return nil, err
	}
	if a.Name != name {
		if err := netlink.LinkSetDown(link); err != nil {
			return fail(fmt.Errorf("set %s down: %v", a.Name, err))
		}
		if err := netlink.LinkSetName(link, name); err != nil {
			return fail(fmt.Errorf("rename %s to %s: %v", a.Name, name, err))
		}
		logf("renamed %s to %s", a.Name, name)
	}
	if err := disableIPv6(name); err != nil {
		return fail(err)
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return fail(fmt.Errorf("set %s up: %v", name, err))
	}
	go l.watch()
	return l, nil
}

func (l *attachedLink) Ifname() string        { return l.Name }
func (l *attachedLink) Done() <-chan struct{} { return l.done }
func (l *attachedLink) Err() error            { return l.err }
func (l *attachedLink) String() string {
	if l.OrigName != l.Name {
		return fmt.Sprintf("interface %s (%s)", l.Name, l.OrigName)
	}
	return "interface " + l.Name
}

// watch ends the link when the interface disappears or is replaced.
func (l *attachedLink) watch() {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-t.C:
			link, err := netlink.LinkByName(l.Name)
			if err != nil || link.Attrs().Index != l.Index {
				l.err = fmt.Errorf("interface %s went away", l.Name)
				close(l.done)
				return
			}
		}
	}
}

func (l *attachedLink) Close() {
	select {
	case <-l.stop:
		return
	default:
		close(l.stop)
	}
	l.release()
}

func (l *attachedLink) release() {
	l.restore()
	os.Remove(l.record)
}

// restore puts back the IPv6 setting, name and admin state attach found, if
// the interface still exists under either name.
func (st linkState) restore() {
	link, err := netlink.LinkByIndex(st.Index)
	if err != nil || link.Attrs().Name != st.Name && link.Attrs().Name != st.OrigName {
		return
	}
	if link.Attrs().Name != st.OrigName {
		netlink.LinkSetDown(link)
		if err := netlink.LinkSetName(link, st.OrigName); err != nil {
			logf("rename %s back to %s: %v", link.Attrs().Name, st.OrigName, err)
		}
	}
	if st.IPv6 != "" {
		writeSysctl(ipv6Sysctl(st.OrigName), st.IPv6)
	}
	if st.WasUp {
		netlink.LinkSetUp(link)
	} else {
		netlink.LinkSetDown(link)
	}
}

// restoreLinkState puts back the interface a killed run left attached.
func restoreLinkState(record string) {
	b, err := os.ReadFile(record)
	if err != nil {
		return
	}
	var st linkState
	if json.Unmarshal(b, &st) == nil && st.Index > 0 && st.OrigName != "" {
		st.restore()
	}
	os.Remove(record)
}

func ipv6Sysctl(ifname string) string { return "/proc/sys/net/ipv6/conf/" + ifname + "/disable_ipv6" }

// disableIPv6 keeps router advertisements from the uplink from installing an
// IPv6 default route for the whole unit; the uplink carries IPv4 only.
func disableIPv6(ifname string) error {
	if _, err := os.Stat(ipv6Sysctl(ifname)); os.IsNotExist(err) {
		return nil // kernel without IPv6
	}
	if err := writeSysctl(ipv6Sysctl(ifname), "1"); err != nil {
		return fmt.Errorf("disable IPv6 on %s: %v", ifname, err)
	}
	return nil
}

func readSysctl(path string) (string, error) {
	b, err := os.ReadFile(path)
	return strings.TrimSpace(string(b)), err
}

func writeSysctl(path, val string) error {
	return os.WriteFile(path, []byte(val+"\n"), 0644)
}
