package main

// DHCP: the unit's busybox udhcpc, with this binary as its hook script. udhcpc
// configures nothing itself; the hook only forwards each event to the running
// service over a unix datagram socket, and the service applies it. So one
// process owns every route, rule and file.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	hookEnv    = "MGU_UPLINK_HOOK"
	udhcpcPath = "/sbin/udhcpc"
)

// hookEvent is one udhcpc callback.
type hookEvent struct {
	Event  string   `json:"event"` // bound, renew, deconfig, leasefail, nak
	IP     string   `json:"ip"`
	Prefix int      `json:"prefix"`
	Router string   `json:"router"`
	DNS    []string `json:"dns"`
	Lease  int      `json:"lease"`
}

func isHookEvent(s string) bool {
	switch s {
	case "bound", "renew", "deconfig", "leasefail", "nak":
		return true
	}
	return false
}

// eventFromEnv reads udhcpc's environment for one callback.
func eventFromEnv(event string, getenv func(string) string) hookEvent {
	e := hookEvent{Event: event, IP: getenv("ip")}
	if m := net.ParseIP(getenv("subnet")).To4(); m != nil {
		e.Prefix, _ = net.IPMask(m).Size()
	} else if p, err := strconv.Atoi(getenv("mask")); err == nil {
		e.Prefix = p
	}
	if r := strings.Fields(getenv("router")); len(r) > 0 {
		e.Router = r[0]
	}
	e.DNS = strings.Fields(getenv("dns"))
	e.Lease, _ = strconv.Atoi(getenv("lease"))
	return e
}

// lease turns a bound/renew event into a lease, or explains why it can't.
func (e hookEvent) lease(ifname string) (*Lease, error) {
	ip := net.ParseIP(e.IP).To4()
	if ip == nil || e.Prefix < 1 || e.Prefix > 30 {
		return nil, fmt.Errorf("lease without a usable address (%q/%d)", e.IP, e.Prefix)
	}
	gw := net.ParseIP(e.Router).To4()
	if gw == nil {
		return nil, fmt.Errorf("lease %s without a router", e.IP)
	}
	var dns []string
	for _, d := range e.DNS {
		if net.ParseIP(d).To4() != nil {
			dns = append(dns, d)
		}
	}
	return &Lease{Interface: ifname, IP: ip.String(), Prefix: e.Prefix, Router: gw.String(),
		DNS: dns, LeaseSec: e.Lease, Updated: time.Now().UTC().Format(time.RFC3339)}, nil
}

// hookPath is the binary udhcpc runs as its hook: the path the service was
// started by (current/mgu-uplink), which an update keeps valid, rather than
// the version folder it resolves to, which a later update may remove. A hook
// of one version may so serve the service of another: the event JSON is
// their whole interface.
func hookPath() (string, error) {
	if filepath.IsAbs(os.Args[0]) {
		return os.Args[0], nil
	}
	return os.Executable()
}

// runHook is the udhcpc side: send the event to the service.
func runHook(event string) int {
	sock := os.Getenv(hookEnv)
	b, _ := json.Marshal(eventFromEnv(event, os.Getenv))
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err == nil {
		_, err = c.Write(b)
		c.Close()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "mgu-uplink hook %s: %v\n", event, err)
		return 1
	}
	return 0
}

// listenHook opens the service side of the hook socket and delivers events.
func listenHook(path string) (*net.UnixConn, <-chan hookEvent, error) {
	os.Remove(path)
	conn, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		conn.Close()
		return nil, nil, err
	}
	ch := make(chan hookEvent, 16)
	go func() {
		defer close(ch)
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			var e hookEvent
			if json.Unmarshal(buf[:n], &e) == nil && isHookEvent(e.Event) {
				ch <- e
			}
		}
	}()
	return conn, ch, nil
}

// dhcpClient is one udhcpc process. done is closed when it has exited; err is
// then its exit status.
type dhcpClient struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error
}

func startDHCP(c config, self, ifname string) (*dhcpClient, error) {
	// -f foreground, -R release the lease on exit, -t/-T discover 5 times 3 s
	// apart, -A wait 5 s after a failed round before the next.
	cmd := exec.Command(udhcpcPath, "-f", "-R", "-i", ifname, "-s", self, "-t", "5", "-T", "3", "-A", "5")
	cmd.Env = append(os.Environ(), hookEnv+"="+c.hookSocket())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stdout
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %v", udhcpcPath, err)
	}
	d := &dhcpClient{cmd: cmd, done: make(chan struct{})}
	go func() {
		d.err = cmd.Wait()
		close(d.done)
	}()
	return d, nil
}

// stop releases the lease and ends udhcpc.
func (d *dhcpClient) stop() {
	select {
	case <-d.done:
		return
	default:
	}
	d.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-d.done:
	case <-time.After(3 * time.Second):
		d.cmd.Process.Kill()
		<-d.done
	}
}
