package main

// status prints what the service has in place. The unit's busybox ip shows
// neither policy rules nor per-uid routes, so this is how to check them there.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// statusProbe is the destination whose route status shows per uid.
var statusProbe = net.IPv4(1, 1, 1, 1)

func status(c config) {
	if b, err := os.ReadFile(c.statusFile()); err == nil {
		var st uplinkStatus
		if json.Unmarshal(b, &st) == nil {
			line := "uplink: " + st.State
			if st.Device != nil {
				line += fmt.Sprintf(", %s %s", st.Device.Kind, st.Device.Name)
			}
			if st.Error != nil {
				line += ": " + *st.Error
			}
			fmt.Println(line)
		}
	} else {
		fmt.Println("uplink: service not running")
	}
	if l := readLease(c.leaseFile()); l != nil {
		fmt.Printf("online: %s %s/%d via %s, dns %s, lease %ds from %s\n",
			l.Interface, l.IP, l.Prefix, l.Router, strings.Join(l.DNS, " "), l.LeaseSec, l.Updated)
	} else {
		fmt.Println("offline: no lease")
	}
	fmt.Println("rules:")
	uids := []uint32{0}
	for _, r := range ownRules(c) {
		fmt.Printf("  %s\n", ruleString(r))
		if r.UIDRange != nil && r.Table == c.Table {
			uids = append(uids, r.UIDRange.Start)
		}
	}
	fmt.Printf("table %d:\n", c.Table)
	for _, r := range tableRoutes(c) {
		fmt.Printf("  %s\n", routeString(r))
	}
	fw := "absent"
	if firewallPresent(c) {
		fw = "present"
	}
	fmt.Printf("firewall: table inet %s %s, %d accept rule(s) in ip filter output\n", nftTable, fw, len(unitAcceptHandles(c)))
	fmt.Printf("route to %s:\n", statusProbe)
	for _, uid := range uids {
		u := uid
		routes, err := netlink.RouteGetWithOptions(statusProbe, &netlink.RouteGetOptions{UID: &u})
		switch {
		case err != nil:
			fmt.Printf("  uid %d: %v\n", uid, err)
		case len(routes) > 0:
			fmt.Printf("  uid %d: %s\n", uid, routeString(routes[0]))
		}
	}
}

func ruleString(r netlink.Rule) string {
	s := fmt.Sprintf("%d:", r.Priority)
	if r.UIDRange != nil {
		s += fmt.Sprintf(" uid %d", r.UIDRange.Start)
	}
	if r.Src != nil {
		s += " from " + r.Src.IP.String()
	}
	table := fmt.Sprint(r.Table)
	if r.Table == mainTable {
		table = "main"
	}
	s += " lookup " + table
	if r.SuppressPrefixlen >= 0 {
		s += fmt.Sprintf(" suppress_prefixlength %d", r.SuppressPrefixlen)
	}
	return s
}

func routeString(r netlink.Route) string {
	var b strings.Builder
	if r.Type == unix.RTN_UNREACHABLE {
		b.WriteString("unreachable ")
	}
	if r.Dst == nil || dstString(r.Dst) == anyDst.String() {
		b.WriteString("default")
	} else {
		b.WriteString(r.Dst.String())
	}
	if r.Gw != nil {
		b.WriteString(" via " + r.Gw.String())
	}
	if r.LinkIndex > 0 {
		if l, err := netlink.LinkByIndex(r.LinkIndex); err == nil {
			b.WriteString(" dev " + l.Attrs().Name)
		}
	}
	if r.Src != nil {
		b.WriteString(" src " + r.Src.String())
	}
	return b.String()
}
