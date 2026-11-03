package main

// The Wi-Fi provider's wpa_supplicant (wifi.go): upstream 2.10 with
// wpa/wpa-mgu-sme-connect.patch, built by `make target` and installed next
// to mgu-uplink as wpaBin, a name of our own that the crash handler's
// restart whitelist can list (crashNames). It runs on the Wi-Fi interface
// only, with the saved networks in wpa.conf (update_config: SAVE_CONFIG writes them), and all
// talk goes over its control socket. Any other wpa_supplicant on the unit
// (the stock one CarPlay uses) is never touched.

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxNetworks = 20 // rows of the scan list

const wpaBin = "mgu-wpa" // our wpa_supplicant, next to mgu-uplink

type supplicant struct {
	bin   string // the program
	iface string
	conf  string // saved networks, in a folder only root can read
	ctrl  string // its control socket folder (ctrl_interface)
	local string // our end of the control socket

	mu        sync.Mutex
	cmd       *exec.Cmd
	run       *supplicantRun
	startedAt time.Time
	conn      *net.UnixConn
	setAside  bool // wpa.conf was moved to wpa.conf.bad (takeSetAside)
}

// What wpa_supplicant 2.10 prints when it can't read wpa.conf at the start.
const confUnreadable = "Failed to read or parse configuration"

// setAsideConf moves wpa.conf to wpa.conf.bad, with s.mu held.
func (s *supplicant) setAsideConf() bool {
	if err := os.Rename(s.conf, s.conf+".bad"); err != nil {
		return false
	}
	logf("wifi: wpa_supplicant could not read %s; moved to %s.bad", s.conf, s.conf)
	s.setAside = true
	return true
}

// takeSetAside reports, once, that wpa.conf was set aside.
func (s *supplicant) takeSetAside() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.setAside
	s.setAside = false
	return t
}

// supplicantRun is one started supplicant: err is set before exited closes,
// out holds the end of what it printed.
type supplicantRun struct {
	exited chan struct{}
	err    error
	out    tail
}

// tail keeps the last 4 KiB written to it.
type tail struct {
	mu sync.Mutex
	b  []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > 4096 {
		t.b = t.b[len(t.b)-4096:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}

func (s *supplicant) name() string { return backendMGU }

// ready: running, with its control socket there.
func (s *supplicant) ready() bool {
	return s.isRunning() && exists(filepath.Join(s.ctrl, s.iface))
}

func (s *supplicant) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running()
}

func (s *supplicant) running() bool {
	if s.cmd == nil {
		return false
	}
	select {
	case <-s.run.exited:
		return false
	default:
		return true
	}
}

func (s *supplicant) upFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running() {
		return 0
	}
	return time.Since(s.startedAt)
}

// ensure starts the supplicant unless it runs. One that ended by itself is
// reported as an error once; the next ensure starts it again. One that
// could not read wpa.conf (a file it wrote that it can't read back) has the
// file moved aside to wpa.conf.bad, so the next start has no saved networks
// rather than failing again.
func (s *supplicant) ensure(proc string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running() {
		return nil
	}
	s.closeConn()
	if s.cmd != nil {
		s.cmd = nil
		if strings.Contains(s.run.out.String(), confUnreadable) && s.setAsideConf() {
			return fmt.Errorf("the saved networks could not be read and were set aside (%s.bad)", filepath.Base(s.conf))
		}
		return fmt.Errorf("wpa_supplicant ended (%v)", s.run.err)
	}
	killOwnSupplicants(proc, s.conf)
	if _, err := os.Stat(s.bin); err != nil {
		return fmt.Errorf("wpa_supplicant: %v", err)
	}
	// wpa_supplicant writes the file with the default mode: the folder
	// keeps the passwords root's.
	dir := filepath.Dir(s.conf)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	if _, err := os.Stat(s.conf); os.IsNotExist(err) {
		head := fmt.Sprintf("ctrl_interface=%s\nupdate_config=1\nap_scan=1\n", s.ctrl)
		if err := os.WriteFile(s.conf, []byte(head), 0600); err != nil {
			return err
		}
	}
	os.RemoveAll(s.ctrl) // a killed run's socket would block the start
	cmd := exec.Command(s.bin, "-i", s.iface, "-D", "nl80211", "-c", s.conf)
	run := &supplicantRun{exited: make(chan struct{})}
	cmd.Stdout = io.MultiWriter(os.Stdout, &run.out)
	cmd.Stderr = cmd.Stdout
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start wpa_supplicant: %v", err)
	}
	s.cmd, s.run, s.startedAt = cmd, run, time.Now()
	go func() {
		run.err = cmd.Wait()
		logf("wpa_supplicant on %s ended: %v", s.iface, run.err)
		close(run.exited)
	}()
	logf("wpa_supplicant started on %s", s.iface)
	return nil
}

// stop ends the supplicant; the next ensure starts it at once.
func (s *supplicant) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeConn()
	if s.running() {
		s.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-s.run.exited:
		case <-time.After(3 * time.Second):
			s.cmd.Process.Kill()
			<-s.run.exited
		}
	}
	s.cmd = nil
}

func (s *supplicant) closeConn() {
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
		os.Remove(s.local)
	}
}

// request sends one control command and returns its reply. The socket is a
// datagram socket; ours is bound so that the supplicant can answer.
func (s *supplicant) request(cmd string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running() {
		return "", fmt.Errorf("wpa_supplicant is not running")
	}
	if s.conn == nil {
		os.Remove(s.local)
		c, err := net.DialUnix("unixgram", &net.UnixAddr{Name: s.local, Net: "unixgram"},
			&net.UnixAddr{Name: filepath.Join(s.ctrl, s.iface), Net: "unixgram"})
		if err != nil {
			return "", err
		}
		s.conn = c
	}
	s.conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := s.conn.Write([]byte(cmd)); err != nil {
		s.closeConn()
		return "", err
	}
	buf := make([]byte, 16384)
	for {
		n, err := s.conn.Read(buf)
		if err != nil {
			s.closeConn()
			return "", err
		}
		if n > 0 && buf[0] == '<' { // an event; we never ATTACH
			continue
		}
		return string(buf[:n]), nil
	}
}

// ok sends cmd and expects OK. An error names the command only: a psk
// never reaches a message.
func (s *supplicant) ok(cmd string) error {
	r, err := s.request(cmd)
	if err != nil {
		return err
	}
	if strings.TrimSpace(r) != "OK" {
		return fmt.Errorf("wpa_supplicant: %s: %s", strings.Fields(cmd)[0], strings.TrimSpace(r))
	}
	return nil
}

func (s *supplicant) status() map[string]string {
	r, err := s.request("STATUS")
	if err != nil {
		return map[string]string{}
	}
	return parseKV(r)
}

func (s *supplicant) signal() (int, bool) {
	r, err := s.request("SIGNAL_POLL")
	if err != nil {
		return 0, false
	}
	v, err := strconv.Atoi(parseKV(r)["RSSI"])
	return v, err == nil
}

func (s *supplicant) scan() error {
	r, err := s.request("SCAN")
	if err != nil {
		return err
	}
	if t := strings.TrimSpace(r); t != "OK" && t != "FAIL-BUSY" { // busy: it is scanning anyway
		return fmt.Errorf("scan: %s", t)
	}
	return nil
}

func (s *supplicant) saved() map[string]int {
	if r, err := s.request("LIST_NETWORKS"); err == nil {
		return parseSaved(r)
	}
	return map[string]int{}
}

// networks is the newest scan, marked with the saved networks, and the
// saved names.
func (s *supplicant) networks() ([]wifiNetwork, []string) {
	saved := s.saved()
	names := make([]string, 0, len(saved))
	for n := range saved {
		names = append(names, n)
	}
	sort.Strings(names)
	nets := []wifiNetwork{}
	if r, err := s.request("SCAN_RESULTS"); err == nil {
		nets = parseScan(r)
	}
	for i := range nets {
		_, nets[i].Saved = saved[nets[i].SSID]
	}
	return nets, names
}

// join adds the network (or updates a saved one's password), gives it the
// highest priority and selects it, which keeps the others off until
// joined or reloaded. With a password the supplicant disconnects first, so
// that only an association with that password reaches COMPLETED: selecting
// the network it is joined to would keep the old association. Nothing is
// saved yet: joined saves, reload drops it.
func (s *supplicant) join(ssid, psk string, open bool) error {
	id, have := s.saved()[ssid]
	if !have {
		if psk == "" && !open {
			return fmt.Errorf("%s needs a password", ssid)
		}
		r, err := s.request("ADD_NETWORK")
		if err != nil {
			return err
		}
		if id, err = strconv.Atoi(strings.TrimSpace(r)); err != nil {
			return fmt.Errorf("wpa_supplicant: ADD_NETWORK: %s", strings.TrimSpace(r))
		}
		// hex: any bytes; scan_ssid: hidden and sleeping hotspots answer a directed probe
		for _, c := range []string{
			fmt.Sprintf("SET_NETWORK %d ssid %s", id, hex.EncodeToString([]byte(ssid))),
			fmt.Sprintf("SET_NETWORK %d scan_ssid 1", id),
		} {
			if err := s.ok(c); err != nil {
				return err
			}
		}
	}
	var cmds []string
	switch {
	case psk != "":
		cmds = []string{
			fmt.Sprintf("SET_NETWORK %d key_mgmt WPA-PSK WPA-PSK-SHA256 SAE", id),
			fmt.Sprintf("SET_NETWORK %d ieee80211w 1", id),
			fmt.Sprintf("SET_NETWORK %d psk \"%s\"", id, psk),
			"DISCONNECT",
		}
	case !have:
		cmds = []string{fmt.Sprintf("SET_NETWORK %d key_mgmt NONE", id)}
	}
	// the newest choice first among the saved ones
	cmds = append(cmds, fmt.Sprintf("SET_NETWORK %d priority %d", id, time.Now().Unix()/60),
		fmt.Sprintf("SELECT_NETWORK %d", id))
	for _, c := range cmds {
		if err := s.ok(c); err != nil {
			return err
		}
	}
	return nil
}

// joined keeps what join set up: every saved network on again, all saved.
func (s *supplicant) joined() error {
	if err := s.ok("ENABLE_NETWORK all"); err != nil {
		return err
	}
	return s.ok("SAVE_CONFIG")
}

// reload drops what join set up: the saved networks as saved. When
// RECONFIGURE fails (2.10: mostly a wpa.conf it can't read) the supplicant
// is stopped, so that the next ensure starts it again from the file; a file
// it really can't read is set aside there.
func (s *supplicant) reload() error {
	err := s.ok("RECONFIGURE")
	if err != nil && s.isRunning() {
		s.stop()
	}
	return err
}

// setQuiet does nothing on wlan1: mgu-wpa's radio is not the one wireless
// CarPlay uses, and DISABLE_NETWORK would reach wpa.conf on the next
// SAVE_CONFIG.
func (s *supplicant) setQuiet(bool) {}

func (s *supplicant) forget(ssid string) error {
	id, ok := s.saved()[ssid]
	if !ok {
		return fmt.Errorf("%s is not saved", ssid)
	}
	if err := s.ok(fmt.Sprintf("REMOVE_NETWORK %d", id)); err != nil {
		return err
	}
	return s.ok("SAVE_CONFIG")
}

// ---- control replies ----

func parseKV(r string) map[string]string {
	m := map[string]string{}
	for _, l := range strings.Split(r, "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

// parseSaved reads LIST_NETWORKS: a "network id / ssid / bssid / flags"
// header, then id, ssid, bssid and flags, tab-separated.
func parseSaved(r string) map[string]int {
	m := map[string]int{}
	for i, l := range strings.Split(r, "\n") {
		f := strings.Split(l, "\t")
		if i == 0 || len(f) < 2 {
			continue
		}
		if id, err := strconv.Atoi(f[0]); err == nil {
			m[unescape(f[1])] = id
		}
	}
	return m
}

// parseScan reads SCAN_RESULTS: a "bssid / frequency / signal level /
// flags / ssid" header, then tab-separated rows (bestNetworks).
func parseScan(r string) []wifiNetwork {
	var rows []wifiNetwork
	for i, l := range strings.Split(r, "\n") {
		f := strings.Split(l, "\t")
		if i == 0 || len(f) < 5 {
			continue
		}
		sig, err := strconv.Atoi(f[2])
		if err != nil {
			continue
		}
		rows = append(rows, wifiNetwork{SSID: unescape(f[4]), Signal: sig,
			Secure: strings.Contains(f[3], "WPA") || strings.Contains(f[3], "RSN") || strings.Contains(f[3], "WEP")})
	}
	return bestNetworks(rows)
}

// bestNetworks is one row per name, the strongest; hidden ones left out;
// strongest first; at most maxNetworks.
func bestNetworks(rows []wifiNetwork) []wifiNetwork {
	best := map[string]wifiNetwork{}
	for _, n := range rows {
		if old, ok := best[n.SSID]; n.SSID != "" && (!ok || old.Signal < n.Signal) {
			best[n.SSID] = n
		}
	}
	out := make([]wifiNetwork, 0, len(best))
	for _, n := range best {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Signal != out[j].Signal {
			return out[i].Signal > out[j].Signal
		}
		return out[i].SSID < out[j].SSID
	})
	if len(out) > maxNetworks {
		out = out[:maxNetworks]
	}
	return out
}

// unescape undoes wpa_supplicant's printf_encode of names (\xNN, \\, \",
// \e, \n, \r, \t) in STATUS, LIST_NETWORKS and SCAN_RESULTS.
func unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b bytes.Buffer
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case 'x':
				if i+3 < len(s) {
					if v, err := strconv.ParseUint(s[i+2:i+4], 16, 8); err == nil {
						b.WriteByte(byte(v))
						i += 3
						continue
					}
				}
			case '\\', '"':
				b.WriteByte(s[i+1])
				i++
				continue
			case 'e', 'n', 'r', 't':
				b.WriteByte(map[byte]byte{'e': 033, 'n': '\n', 'r': '\r', 't': '\t'}[s[i+1]])
				i++
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// ---- other processes ----

// supplicants lists the wpa_supplicant processes under proc (/proc), ours
// (wpaBin) among them, that run on iface: pid -> whether its config is conf
// (ours).
func supplicants(proc, iface, conf string) map[int]bool {
	out := map[int]bool{}
	dirs, _ := os.ReadDir(proc)
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(proc, d.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
		if base := filepath.Base(args[0]); !strings.Contains(base, "wpa_supplicant") && base != wpaBin {
			continue
		}
		on, own := false, false
		for i, a := range args {
			on = on || a == "-i"+iface || a == "-i" && i+1 < len(args) && args[i+1] == iface
			own = own || a == conf || a == "-c"+conf
		}
		if on || own {
			out[pid] = own
		}
	}
	return out
}

// killOwnSupplicants ends what a killed run left: wpa_supplicants with our
// config, never another one.
func killOwnSupplicants(proc, conf string) {
	for pid, own := range supplicants(proc, "", conf) {
		if !own {
			continue
		}
		logf("ending a wpa_supplicant a previous run left (pid %d)", pid)
		syscall.Kill(pid, syscall.SIGTERM)
		for i := 0; i < 30 && exists(filepath.Join(proc, strconv.Itoa(pid))); i++ {
			time.Sleep(100 * time.Millisecond)
		}
	}
}
