package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// The time an answer may give: from this tool's own date for 50 years.
var (
	minTime = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	maxTime = minTime.AddDate(50, 0, 0)
)

var defaultNTP = []string{"time.cloudflare.com", "time.google.com", "time.apple.com", "pool.ntp.org"}

const (
	ntpWait  = 4 * time.Second
	ntpAgree = 5 * time.Second
	// seconds from 1900 (NTP) to 1970 (Unix)
	ntpEpoch = 2208988800
)

// clock: the time was unixMs at CLOCK_BOOTTIME bootNs, a clock that no one
// sets and that runs on through suspend.
type clock struct {
	UnixMs int64 `json:"unixMs"`
	BootNs int64 `json:"bootNs"`
}

func bootNow() int64 {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts); err != nil {
		return 0
	}
	return ts.Nano()
}

func inRange(ms int64) bool {
	return ms >= minTime.UnixMilli() && ms <= maxTime.UnixMilli()
}

// usable: a clock read since this start of the unit, within range.
func (c *clock) usable() bool {
	return c != nil && inRange(c.UnixMs) && c.BootNs > 0 && c.BootNs <= bootNow()
}

func (c *clock) now() time.Time {
	return time.UnixMilli(c.UnixMs + (bootNow()-c.BootNs)/1e6)
}

// networkClock asks every server at once and takes the median of the
// answers that agree within ntpAgree: at least two of them, or every
// server when fewer than two are named.
func networkClock(servers []string, lookup func(context.Context, string) (string, error)) (clock, error) {
	if len(servers) == 0 {
		servers = defaultNTP
	}
	type answer struct {
		base int64 // the time at boot time 0, in ms
		err  error
	}
	ch := make(chan answer, len(servers))
	for _, s := range servers {
		go func(s string) {
			base, err := sntp(s, lookup)
			if err != nil {
				err = fmt.Errorf("%s: %v", s, err)
			}
			ch <- answer{base, err}
		}(s)
	}
	var bases []int64
	var errs []string
	for range servers {
		a := <-ch
		if a.err != nil {
			errs = append(errs, a.err.Error())
		} else {
			bases = append(bases, a.base)
		}
	}
	need := 2
	if len(servers) < need {
		need = len(servers)
	}
	sort.Slice(bases, func(a, b int) bool { return bases[a] < bases[b] })
	// the largest run of answers within ntpAgree of each other
	best, from := 0, 0
	for i := range bases {
		j := i
		for j < len(bases) && bases[j]-bases[i] <= ntpAgree.Milliseconds() {
			j++
		}
		if j-i > best {
			best, from = j-i, i
		}
	}
	if best < need {
		if len(errs) == 0 {
			errs = append(errs, "the servers do not agree")
		}
		return clock{}, fmt.Errorf("%d of %d servers answered alike (%s)", best, len(servers), strings.Join(errs, "; "))
	}
	base := bases[from+best/2]
	boot := bootNow()
	return clock{UnixMs: base + boot/1e6, BootNs: boot}, nil
}

// sntp asks one server (host or host:port) for the time (RFC 4330) and
// returns it as the time at boot time 0, in ms.
func sntp(server string, lookup func(context.Context, string) (string, error)) (int64, error) {
	host, port := server, "123"
	if h, p, err := net.SplitHostPort(server); err == nil {
		host, port = h, p
	}
	ctx, cancel := context.WithTimeout(context.Background(), ntpWait*2)
	defer cancel()
	ip, err := lookup(ctx, host)
	if err != nil {
		return 0, err
	}
	conn, err := net.DialTimeout("udp4", net.JoinHostPort(ip, port), ntpWait)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(ntpWait))
	req := make([]byte, 48)
	req[0] = 0x23 // no leap warning, version 4, client
	if _, err := rand.Read(req[40:48]); err != nil {
		return 0, err
	}
	t1 := bootNow()
	if _, err := conn.Write(req); err != nil {
		return 0, err
	}
	res := make([]byte, 512)
	for {
		n, err := conn.Read(res)
		if err != nil {
			return 0, err
		}
		t4 := bootNow()
		ms, err := parseNTP(res[:n], req[40:48])
		if err != nil {
			continue // not our answer: wait for it until the deadline
		}
		// the answer's time is taken as halfway through the round trip
		return ms + (t4-t1)/2/1e6 - t4/1e6, nil
	}
}

// parseNTP reads a server's answer to the request that carried nonce as its
// transmit time: its transmit time in Unix ms.
func parseNTP(b, nonce []byte) (int64, error) {
	if len(b) < 48 {
		return 0, errors.New("short answer")
	}
	if b[0]&7 != 4 {
		return 0, errors.New("not a server's answer")
	}
	if b[0]>>6 == 3 {
		return 0, errors.New("server not synchronised")
	}
	if b[1] == 0 || b[1] > 15 {
		return 0, errors.New("bad stratum")
	}
	if !bytes.Equal(b[24:32], nonce) {
		return 0, errors.New("answer to another request")
	}
	sec := int64(binary.BigEndian.Uint32(b[40:44]))
	frac := int64(binary.BigEndian.Uint32(b[44:48]))
	if sec == 0 {
		return 0, errors.New("no time in the answer")
	}
	// era 1 (from 2036) has the top bit clear
	if sec&0x80000000 == 0 {
		sec += 1 << 32
	}
	ms := (sec-ntpEpoch)*1000 + frac*1000>>32
	if !inRange(ms) {
		return 0, fmt.Errorf("time out of range: %s", time.UnixMilli(ms).UTC().Format(time.RFC3339))
	}
	return ms, nil
}
