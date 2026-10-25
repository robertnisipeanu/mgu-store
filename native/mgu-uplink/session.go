package main

// The service: open the uplink, run DHCP on its interface, and keep routing,
// firewall and lease files in line with the lease and the allowed uids. A
// reconcile every few seconds re-resolves app uids (a reinstall can move an
// app to a new uid) and restores anything another component removed (the
// unit's firewall reloads its ruleset at mode changes).

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/vishvananda/netlink"
)

const reconcileEvery = 5 * time.Second

type service struct {
	cfg     config
	up      Uplink
	self    string
	uids    []int
	byApp   map[string]int
	missing []string
	link    Link
	lease   *Lease
	dhcp    *dhcpClient
	lastErr string
}

type openResult struct {
	link Link
	err  error
}

// lock takes the run directory's lock, so only one instance configures the
// unit at a time.
func lock(c config) (*os.File, error) {
	if err := os.MkdirAll(c.RunDir, 0755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(c.RunDir+"/lock", os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("mgu-uplink is already running (%s/lock is held)", c.RunDir)
	}
	return f, nil
}

func runService(c config, up Uplink) error {
	// Before anything is configured: a stop during start-up still cleans up.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	self, err := hookPath()
	if err != nil {
		return fmt.Errorf("own path: %v", err)
	}
	lk, err := lock(c)
	if err != nil {
		return err
	}
	defer lk.Close()
	cleanup(c)
	conn, events, err := listenHook(c.hookSocket())
	if err != nil {
		return fmt.Errorf("hook socket: %v", err)
	}
	s := &service{cfg: c, up: up, self: self}
	// shutdown before closing the socket: udhcpc reports its release on it.
	defer func() {
		s.shutdown()
		conn.Close()
	}()
	logf("mgu-uplink %s: uplink %s, apps %v, uids %v, table %d, rules %d-%d",
		version, up, c.Apps, c.UIDs, c.Table, c.Pref, c.Pref+rulePrefs-1)
	s.reconcile(true)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	opened := make(chan openResult, 1)
	opening := false
	open := func() {
		opening = true
		go func() {
			l, err := up.Open(ctx)
			opened <- openResult{l, err}
		}()
	}
	open()
	tick := time.NewTicker(reconcileEvery)
	defer tick.Stop()
	var linkDone, dhcpDone <-chan struct{}
	var reopen, restartDHCP <-chan time.Time
	for {
		select {
		case <-sig:
			logf("stopping")
			cancel()
			if opening {
				if r := <-opened; r.link != nil {
					r.link.Close()
				}
			}
			return nil
		case r := <-opened:
			opening = false
			if r.err != nil {
				logf("open %s: %v", up, r.err)
				reopen = time.After(3 * time.Second)
				continue
			}
			s.link = r.link
			linkDone = r.link.Done()
			logf("uplink up: %s", r.link)
			dhcpDone = s.startDHCP()
			if dhcpDone == nil {
				restartDHCP = time.After(5 * time.Second)
			}
		case <-reopen:
			reopen = nil
			open()
		case <-linkDone:
			logf("uplink down: %s: %v", s.link, s.link.Err())
			s.detach()
			linkDone, dhcpDone, restartDHCP = nil, nil, nil
			reopen = time.After(2 * time.Second)
		case <-dhcpDone:
			logf("udhcpc exited: %v; restarting it", s.dhcp.err)
			s.dhcp = nil
			dhcpDone = nil
			s.setLease(nil)
			restartDHCP = time.After(3 * time.Second)
		case <-restartDHCP:
			restartDHCP = nil
			if s.link != nil {
				if dhcpDone = s.startDHCP(); dhcpDone == nil {
					restartDHCP = time.After(5 * time.Second)
				}
			}
		case e, ok := <-events:
			if !ok {
				return fmt.Errorf("hook socket closed")
			}
			s.onHook(e)
		case <-tick.C:
			s.reconcile(false)
		}
	}
}

func (s *service) startDHCP() <-chan struct{} {
	d, err := startDHCP(s.cfg, s.self, s.link.Ifname())
	if err != nil {
		logf("%v", err)
		return nil
	}
	s.dhcp = d
	return d.done
}

func (s *service) onHook(e hookEvent) {
	if s.link == nil {
		return
	}
	switch e.Event {
	case "bound", "renew":
		l, err := e.lease(s.link.Ifname())
		if err != nil {
			logf("udhcpc %s: %v", e.Event, err)
			s.setLease(nil)
			return
		}
		s.setLease(l)
	default:
		if s.lease != nil {
			logf("udhcpc %s: lease gone", e.Event)
		}
		s.setLease(nil)
	}
}

// setLease applies a lease (or its loss) to the interface, the table, the
// rules and the files apps read.
func (s *service) setLease(l *Lease) {
	prev := s.lease
	if l != nil && s.link != nil {
		link, err := netlink.LinkByName(s.link.Ifname())
		if err == nil {
			err = setAddress(link, l)
		}
		if err != nil {
			logf("%v", err)
			l = nil
		}
	}
	if l == nil && prev != nil {
		clearAddress(prev.Interface, prev.IP, prev.Prefix)
	}
	s.lease = l
	s.reconcile(false)
	switch {
	case l != nil && (prev == nil || prev.IP != l.IP || prev.Router != l.Router || strings.Join(prev.DNS, ",") != strings.Join(l.DNS, ",")):
		logf("online: %s/%d via %s, dns %v, lease %ds; uids %v", l.IP, l.Prefix, l.Router, l.DNS, l.LeaseSec, s.uids)
	case l == nil && prev != nil:
		logf("offline")
	}
}

func (s *service) detach() {
	if s.dhcp != nil {
		s.dhcp.stop()
		s.dhcp = nil
	}
	s.setLease(nil)
	if s.link != nil {
		s.link.Close()
		s.link = nil
	}
}

func (s *service) shutdown() {
	s.detach()
	cleanup(s.cfg)
}

// reconcile brings rules, table, firewall, address and files in line with the
// current uids and lease. force reloads the firewall even when present. Each
// distinct error is logged once.
func (s *service) reconcile(force bool) {
	c := s.cfg
	uids, byApp, missing := resolveUIDs(c)
	uidsChanged := fmt.Sprint(uids) != fmt.Sprint(s.uids) || fmt.Sprint(missing) != fmt.Sprint(s.missing)
	if uidsChanged {
		logf("allowed uids %v (apps %v; not installed: %v)", uids, byApp, missing)
	}
	s.uids, s.byApp, s.missing = uids, byApp, missing

	var errs []string
	fail := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	var leaseIP net.IP
	ifindex := 0
	if s.lease != nil && s.link != nil {
		if link, err := netlink.LinkByName(s.link.Ifname()); err == nil {
			ifindex = link.Attrs().Index
			leaseIP = net.ParseIP(s.lease.IP)
			if !hasAddress(link, s.lease.IP) {
				fail(setAddress(link, s.lease))
			}
		}
	}
	_, err := syncRoutes(c, ifindex, s.lease)
	fail(err)
	_, err = syncRules(c, uids, leaseIP)
	fail(err)
	if force || uidsChanged || !firewallPresent(c) {
		fail(applyFirewall(c, s.guarded(), uids))
	} else {
		fail(ensureUnitAccept(c, s.guarded()))
	}
	fail(syncAppState(c, byApp, s.lease))
	msg := strings.Join(errs, "; ")
	if msg != "" && msg != s.lastErr {
		logf("%s", msg)
	}
	s.lastErr = msg
}

// guarded is the interface the firewall guards: the link's, or before the link
// is open, the one the uplink will present.
func (s *service) guarded() string {
	if s.link != nil {
		return s.link.Ifname()
	}
	if n, ok := s.up.(*netdevUplink); ok {
		return n.name
	}
	return Ifname
}

func hasAddress(link netlink.Link, ip string) bool {
	addrs, _ := netlink.AddrList(link, netlink.FAMILY_V4)
	for _, a := range addrs {
		if a.IPNet.IP.String() == ip {
			return true
		}
	}
	return false
}

// cleanup removes everything this tool configures: what a stop leaves behind
// and what a killed instance left.
func cleanup(c config) {
	deleteRules(c)
	flushTable(c)
	deleteFirewall(c)
	if l := readLease(c.leaseFile()); l != nil {
		clearAddress(l.Interface, l.IP, l.Prefix)
	}
	syncAppState(c, nil, nil)
	deleteECMVethPair()
	restoreLinkState(c.linkFile())
	os.Remove(c.hookSocket())
}
