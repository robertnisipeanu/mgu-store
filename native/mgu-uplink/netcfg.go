package main

// Apps-only routing. The uplink never gets a route in the main table: its
// address is added with noprefixroute, and its subnet and default routes live
// in their own table (cfg.Table). Policy rules send only the allowed uids there:
//
//	pref P    uidrange U  lookup main suppress_prefixlength 0   car networks and the
//	                                                            unit's specific routes
//	pref P+1  uidrange U  lookup <table>                        everything else: uplink
//	pref P+2  from <lease address> lookup <table>               replies (rp_filter) and
//	                                                            sockets bound to the lease
//
// The table always holds a default: via the uplink's router while there is a
// lease, unreachable otherwise, so an allowed uid never falls through to the
// main table's default route.

import (
	"fmt"
	"net"
	"sort"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

const (
	prefMain   = 0
	prefUplink = 1
	prefSource = 2
	rulePrefs  = 3
	mainTable  = 254
)

// ruleKey identifies a policy rule this tool owns.
type ruleKey struct {
	pref  int
	uid   uint32 // with src == ""
	src   string
	table int
}

func ownRules(c config) []netlink.Rule {
	rules, _ := netlink.RuleList(netlink.FAMILY_V4)
	var out []netlink.Rule
	for _, r := range rules {
		if r.Priority >= c.Pref && r.Priority < c.Pref+rulePrefs {
			out = append(out, r)
		}
	}
	return out
}

func keyOf(r netlink.Rule) ruleKey {
	k := ruleKey{pref: r.Priority, table: r.Table}
	if r.UIDRange != nil && r.UIDRange.Start == r.UIDRange.End {
		k.uid = r.UIDRange.Start
	}
	if r.Src != nil {
		k.src = r.Src.String()
	}
	return k
}

func wantRules(c config, uids []int, leaseIP net.IP) map[ruleKey]*netlink.Rule {
	want := map[ruleKey]*netlink.Rule{}
	for _, uid := range uids {
		for _, p := range []int{prefMain, prefUplink} {
			r := netlink.NewRule()
			r.Family = netlink.FAMILY_V4
			r.Priority = c.Pref + p
			r.UIDRange = netlink.NewRuleUIDRange(uint32(uid), uint32(uid))
			r.Table = c.Table
			if p == prefMain {
				r.Table = mainTable
				r.SuppressPrefixlen = 0
			}
			want[keyOf(*r)] = r
		}
	}
	if leaseIP != nil {
		r := netlink.NewRule()
		r.Family = netlink.FAMILY_V4
		r.Priority = c.Pref + prefSource
		r.Table = c.Table
		r.Src = &net.IPNet{IP: leaseIP.To4(), Mask: net.CIDRMask(32, 32)}
		want[keyOf(*r)] = r
	}
	return want
}

// syncRules makes this tool's policy rules exactly those for uids and the lease
// address, touching only rules that differ. It reports whether it changed any.
func syncRules(c config, uids []int, leaseIP net.IP) (bool, error) {
	want := wantRules(c, uids, leaseIP)
	changed := false
	for _, r := range ownRules(c) {
		k := keyOf(r)
		if _, ok := want[k]; ok && (r.Table != mainTable || r.SuppressPrefixlen == 0) {
			delete(want, k)
			continue
		}
		rr := r
		if err := netlink.RuleDel(&rr); err != nil {
			return changed, fmt.Errorf("delete rule pref %d: %v", r.Priority, err)
		}
		changed = true
	}
	keys := make([]ruleKey, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].pref != keys[j].pref {
			return keys[i].pref < keys[j].pref
		}
		return keys[i].uid < keys[j].uid
	})
	for _, k := range keys {
		if err := netlink.RuleAdd(want[k]); err != nil {
			return changed, fmt.Errorf("add rule pref %d uid %d src %q: %v", k.pref, k.uid, k.src, err)
		}
		changed = true
	}
	return changed, nil
}

func deleteRules(c config) {
	for _, r := range ownRules(c) {
		rr := r
		netlink.RuleDel(&rr)
	}
}

func tableRoutes(c config) []netlink.Route {
	routes, _ := netlink.RouteListFiltered(netlink.FAMILY_V4, &netlink.Route{Table: c.Table}, netlink.RT_FILTER_TABLE)
	return routes
}

func flushTable(c config) {
	for _, r := range tableRoutes(c) {
		rr := r
		netlink.RouteDel(&rr)
	}
}

var anyDst = &net.IPNet{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)}

// wantRoutes is the uplink table's content: unreachable without a lease; the
// lease's subnet and a default via its router with one.
func wantRoutes(c config, ifindex int, l *Lease) []netlink.Route {
	if l == nil || ifindex == 0 {
		return []netlink.Route{{Table: c.Table, Dst: anyDst, Type: unix.RTN_UNREACHABLE}}
	}
	ip := net.ParseIP(l.IP).To4()
	subnet := &net.IPNet{IP: ip.Mask(net.CIDRMask(l.Prefix, 32)), Mask: net.CIDRMask(l.Prefix, 32)}
	return []netlink.Route{
		{Table: c.Table, LinkIndex: ifindex, Dst: subnet, Src: ip, Scope: netlink.SCOPE_LINK, Type: unix.RTN_UNICAST},
		// onlink: the router is on the link by DHCP's word; the kernel would
		// otherwise look for a route to it outside this table.
		{Table: c.Table, LinkIndex: ifindex, Dst: anyDst, Gw: net.ParseIP(l.Router).To4(), Src: ip,
			Flags: int(netlink.FLAG_ONLINK), Type: unix.RTN_UNICAST},
	}
}

func dstString(d *net.IPNet) string {
	if d == nil {
		return anyDst.String()
	}
	return d.String()
}

func sameRoute(a, b netlink.Route) bool {
	return dstString(a.Dst) == dstString(b.Dst) && a.Type == b.Type && a.LinkIndex == b.LinkIndex &&
		a.Gw.Equal(b.Gw) && a.Src.Equal(b.Src)
}

// syncRoutes makes the uplink table hold exactly wantRoutes. It reports
// whether it changed anything.
func syncRoutes(c config, ifindex int, l *Lease) (bool, error) {
	want := wantRoutes(c, ifindex, l)
	have := tableRoutes(c)
	match := len(have) == len(want)
	for i := 0; match && i < len(want); i++ {
		found := false
		for _, h := range have {
			if sameRoute(h, want[i]) {
				found = true
			}
		}
		match = found
	}
	if match {
		return false, nil
	}
	flushTable(c)
	for i := range want {
		if err := netlink.RouteAdd(&want[i]); err != nil {
			return true, fmt.Errorf("route %v in table %d: %v", want[i].Dst, c.Table, err)
		}
	}
	return true, nil
}

// setAddress gives the uplink interface exactly the lease's address, without
// the prefix route the kernel would put in the main table.
func setAddress(link netlink.Link, l *Lease) error {
	addr, err := netlink.ParseAddr(fmt.Sprintf("%s/%d", l.IP, l.Prefix))
	if err != nil {
		return err
	}
	addr.Flags = unix.IFA_F_NOPREFIXROUTE
	existing, _ := netlink.AddrList(link, netlink.FAMILY_V4)
	for _, a := range existing {
		if !a.IPNet.IP.Equal(addr.IPNet.IP) || a.IPNet.String() != addr.IPNet.String() {
			aa := a
			netlink.AddrDel(link, &aa)
		}
	}
	if err := netlink.AddrReplace(link, addr); err != nil {
		return fmt.Errorf("address %s on %s: %v", addr.IPNet, link.Attrs().Name, err)
	}
	return nil
}

func clearAddress(ifname, ip string, prefix int) {
	link, err := netlink.LinkByName(ifname)
	if err != nil {
		return
	}
	addrs, _ := netlink.AddrList(link, netlink.FAMILY_V4)
	for _, a := range addrs {
		if a.IPNet.IP.String() == ip {
			ones, _ := a.IPNet.Mask.Size()
			if prefix == 0 || ones == prefix {
				aa := a
				netlink.AddrDel(link, &aa)
			}
		}
	}
}
