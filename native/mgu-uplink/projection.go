package main

// Wireless CarPlay and Android Auto sessions, for the Wi-Fi provider's
// automatic scans (wifi.go): a client scan takes the radio off the channel
// the phone uses. A session is the phone projecting over the car's Wi-Fi:
//
//   - the projection daemon has a TCP connection ESTABLISHED to an address
//     that is not a loopback one (/proc/net/tcp, tcp6): carplay runs as uid
//     13002 (carplay.service, User=cia_13002), aapd as uid 13006
//     (aapd.service, User=cia_13006), and
//   - a P2P group interface (p2p-*: the car's wireless CarPlay and Android
//     Auto groups) received data within projectionQuiet (/proc/net/dev).
//
// Wired CarPlay (USB) has the connection without P2P traffic, and a P2P
// group with no phone receives nothing (its own multicast is sent, not
// received). The groups that received data are the phone's: their
// frequency gives its band.

import (
	"bufio"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	uidCarPlay     = 13002
	uidAndroidAuto = 13006

	projCarPlay     = "carplay"
	projAndroidAuto = "android-auto"
)

// Replaced by tests.
var (
	projectionQuiet = 30 * time.Second // a P2P group that received nothing this long is not the phone's
	projectionGap   = 10 * time.Second // a look this long after the last one starts the counts again
)

type projection struct {
	rx    map[string]uint64    // each P2P interface's received bytes at the last look
	heard map[string]time.Time // when each last received
	last  time.Time            // the last look
}

// projSession is a wireless projection session: kind carplay or
// android-auto ("" none), and the P2P interfaces the phone is on.
type projSession struct {
	kind   string
	ifaces []string
}

func newProjection() *projection {
	return &projection{rx: map[string]uint64{}, heard: map[string]time.Time{}}
}

func projectionName(kind string) string {
	if kind == projAndroidAuto {
		return "Android Auto"
	}
	return "CarPlay"
}

// look reads proc (/proc) once: the session now. The first look after a
// gap (Wi-Fi off, unavailable or waiting to try again) only takes the
// counts: what they grew by meanwhile is no sign of a phone now.
func (p *projection) look(proc string, now time.Time) projSession {
	rx := p2pReceived(filepath.Join(proc, "net", "dev"))
	if now.Sub(p.last) > projectionGap {
		p.rx, p.heard = map[string]uint64{}, map[string]time.Time{}
	}
	p.last = now
	for name, n := range rx {
		if old, ok := p.rx[name]; ok && n > old {
			p.heard[name] = now
		}
	}
	for name := range p.heard {
		if _, ok := rx[name]; !ok {
			delete(p.heard, name)
		}
	}
	p.rx = rx
	var s projSession
	for name, at := range p.heard {
		if now.Sub(at) < projectionQuiet {
			s.ifaces = append(s.ifaces, name)
		}
	}
	if len(s.ifaces) == 0 {
		return projSession{}
	}
	sort.Strings(s.ifaces)
	uids := tcpPeers(filepath.Join(proc, "net", "tcp"), filepath.Join(proc, "net", "tcp6"))
	switch {
	case uids[uidCarPlay]:
		s.kind = projCarPlay
	case uids[uidAndroidAuto]:
		s.kind = projAndroidAuto
	default:
		return projSession{}
	}
	return s
}

// p2pReceived reads /proc/net/dev: the received bytes of each p2p-*
// interface.
func p2pReceived(path string) map[string]uint64 {
	out := map[string]uint64{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		name, rest, ok := strings.Cut(l, ":")
		name = strings.TrimSpace(name)
		if !ok || !strings.HasPrefix(name, "p2p-") {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			out[name] = n
		}
	}
	return out
}

// tcpPeers reads /proc/net/tcp and tcp6: the uids with a connection
// ESTABLISHED to an address that is not a loopback or unspecified one.
func tcpPeers(paths ...string) map[int]bool {
	out := map[int]bool{}
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
			x := strings.Fields(sc.Text())
			if len(x) < 8 || x[3] != "01" {
				continue
			}
			addr, _, _ := strings.Cut(x[2], ":")
			ip := procIP(addr)
			if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
				continue
			}
			if uid, err := strconv.Atoi(x[7]); err == nil {
				out[uid] = true
			}
		}
		f.Close()
	}
	return out
}

// procIP decodes an address of /proc/net/tcp (4 bytes) or tcp6 (16): each
// 32-bit word in the host's order, little-endian on the unit.
func procIP(s string) net.IP {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 4 && len(b) != 16 {
		return nil
	}
	for i := 0; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	return net.IP(b)
}

// band of a frequency in MHz: 2 (2.4 GHz), 5 (5 GHz), 0 another or none.
func band(freq int) int {
	switch {
	case freq >= 2400 && freq < 2500:
		return 2
	case freq >= 4900 && freq < 5900:
		return 5
	}
	return 0
}

func bandName(b int) string {
	if b == 2 {
		return "2.4 GHz"
	}
	return "5 GHz"
}

// The channels automatic scans keep to when the phone is on the other
// band: 2.4 GHz channels 1 to 13, and the 5 GHz channels 36 to 165.
var (
	freqs24 = []int{2412, 2417, 2422, 2427, 2432, 2437, 2442, 2447, 2452, 2457, 2462, 2467, 2472}
	freqs5  = []int{5180, 5200, 5220, 5240, 5260, 5280, 5300, 5320, 5500, 5520, 5540, 5560, 5580, 5600,
		5620, 5640, 5660, 5680, 5700, 5720, 5745, 5765, 5785, 5805, 5825}
)

// otherBand is the channels of the band the phone is not on (b: 2 or 5).
func otherBand(b int) []int {
	switch b {
	case 2:
		return freqs5
	case 5:
		return freqs24
	}
	return nil
}

// freqList is a frequency list as wpa_supplicant takes it: "2412 2417 …".
func freqList(freqs []int) string {
	s := make([]string, len(freqs))
	for i, f := range freqs {
		s[i] = strconv.Itoa(f)
	}
	return strings.Join(s, " ")
}
