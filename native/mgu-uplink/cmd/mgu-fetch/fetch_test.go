package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// certificates valid only from 2030 to 2031: expired or not yet valid on any
// clock but the one the job gives
var (
	validFrom = time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	validTo   = time.Date(2031, 1, 1, 0, 0, 0, 0, time.UTC)
	in2030    = clock{UnixMs: time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()}
)

func pki(t *testing.T) (caPEM string, srv tls.Certificate) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: validFrom, NotAfter: validTo, IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: validFrom, NotAfter: validTo, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})),
		tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

type seenReq struct {
	host, path, auth, ua, method, body string
}

func server(t *testing.T) (port string, ca string, seen func() []seenReq) {
	t.Helper()
	ca, cert := pki(t)
	var mu sync.Mutex
	var log []seenReq
	payload := bytes.Repeat([]byte("x"), 300000)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		log = append(log, seenReq{r.Host, r.URL.Path, r.Header.Get("Authorization"), strings.Join(r.Header.Values("User-Agent"), ","), r.Method, string(b)})
		mu.Unlock()
		switch r.URL.Path {
		case "/payload.bin":
			w.Header().Set("ETag", `"e1"`)
			if r.Header.Get("If-None-Match") == `"e1"` {
				w.WriteHeader(304)
				return
			}
			w.Write(payload)
		case "/redirect":
			http.Redirect(w, r, "https://localhost:"+strings.Split(r.Host, ":")[1]+"/payload.bin", 302)
		case "/limited":
			w.Header().Set("X-Ratelimit-Remaining", "0")
			w.WriteHeader(403)
		case "/post":
			w.Write([]byte("posted " + string(b)))
		default:
			w.WriteHeader(404)
		}
	})
	s := httptest.NewUnstartedServer(h)
	s.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	s.StartTLS()
	t.Cleanup(s.Close)
	_, port, _ = net.SplitHostPort(s.Listener.Addr().String())
	return port, ca, func() []seenReq {
		mu.Lock()
		defer mu.Unlock()
		out := log
		log = nil
		return out
	}
}

func runJob(t *testing.T, j job) (int, []map[string]interface{}) {
	t.Helper()
	var out bytes.Buffer
	code := run(j, &out)
	var evs []map[string]interface{}
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if l == "" {
			continue
		}
		var e map[string]interface{}
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not JSON: %q", l)
		}
		evs = append(evs, e)
	}
	return code, evs
}

func lastEv(evs []map[string]interface{}) map[string]interface{} {
	if len(evs) == 0 {
		return map[string]interface{}{}
	}
	return evs[len(evs)-1]
}

func at(c clock) *clock {
	c.BootNs = bootNow()
	return &c
}

func TestDownloadOnGivenClock(t *testing.T) {
	port, ca, seen := server(t)
	dir := t.TempDir()
	base := job{CA: ca, Clock: at(in2030), Headers: map[string]string{"User-Agent": "t"}}

	j := base
	j.URL, j.Dest, j.MaxBytes, j.Keep = "https://127.0.0.1:"+port+"/payload.bin", filepath.Join(dir, "a"), 300000, []string{"etag"}
	code, evs := runJob(t, j)
	last := lastEv(evs)
	if code != 0 || last["done"] != true || last["bytes"].(float64) != 300000 || last["status"].(float64) != 200 {
		t.Fatalf("download: %d %v", code, evs)
	}
	if h, _ := last["headers"].(map[string]interface{}); h["etag"] != `"e1"` {
		t.Errorf("kept headers: %v", last["headers"])
	}
	if st, err := os.Stat(j.Dest); err != nil || st.Size() != 300000 || st.Mode().Perm() != 0o600 {
		t.Errorf("file: %v %v", st, err)
	}
	for _, e := range evs {
		if _, ok := e["clock"]; ok {
			t.Errorf("a given clock is not read again: %v", e)
		}
	}

	// the same certificates on the unit's own clock fail as fetch.js does
	j.Clock = at(clock{UnixMs: minTime.UnixMilli()})
	code, evs = runJob(t, j)
	if code != 1 || !strings.Contains(lastEv(evs)["error"].(string), "certificate") {
		t.Errorf("certificate outside the clock: %d %v", code, evs)
	}

	j = base
	j.URL, j.Dest, j.Headers = "https://127.0.0.1:"+port+"/payload.bin", filepath.Join(dir, "b"), map[string]string{"If-None-Match": `"e1"`}
	j.Keep = []string{"etag"}
	code, evs = runJob(t, j)
	if code != 0 || lastEv(evs)["notModified"] != true || lastEv(evs)["status"].(float64) != 304 {
		t.Errorf("304: %d %v", code, evs)
	}
	if _, err := os.Stat(j.Dest); err == nil {
		t.Errorf("a 304 writes nothing")
	}
	seen()
}

func TestRedirectDropsToken(t *testing.T) {
	port, ca, seen := server(t)
	dir := t.TempDir()
	j := job{CA: ca, Clock: at(in2030), URL: "https://127.0.0.1:" + port + "/redirect", Dest: filepath.Join(dir, "a"),
		Headers: map[string]string{"User-Agent": "t", "Authorization": "Bearer secret"}}
	code, evs := runJob(t, j)
	if code != 0 || lastEv(evs)["done"] != true {
		t.Fatalf("redirect: %d %v", code, evs)
	}
	s := seen()
	if len(s) != 2 || s[0].auth != "Bearer secret" || s[1].auth != "" || !strings.HasPrefix(s[1].host, "localhost:") || s[1].ua != "t" {
		t.Errorf("requests: %+v", s)
	}
}

func TestRefusals(t *testing.T) {
	port, ca, seen := server(t)
	dir := t.TempDir()
	base := job{CA: ca, Clock: at(in2030)}
	cases := []struct {
		name, url string
		max       int64
		want      string
		extra     string
	}{
		{"too big by length", "/payload.bin", 1000, "the expected 1000", "tooBig"},
		{"rate limit", "/limited", 0, "HTTP 403 from 127.0.0.1", "rateLimited"},
		{"not found", "/nothing", 0, "HTTP 404 from 127.0.0.1", "status"},
	}
	for _, c := range cases {
		j := base
		j.URL, j.Dest, j.MaxBytes = "https://127.0.0.1:"+port+c.url, filepath.Join(dir, c.name), c.max
		code, evs := runJob(t, j)
		e := lastEv(evs)
		if code != 1 || !strings.Contains(e["error"].(string), c.want) || e[c.extra] == nil {
			t.Errorf("%s: %d %v", c.name, code, evs)
		}
	}
	j := base
	j.URL, j.Dest = "http://127.0.0.1:"+port+"/payload.bin", filepath.Join(dir, "plain")
	if code, evs := runJob(t, j); code != 1 || lastEv(evs)["error"] != "refusing http: URL" {
		t.Errorf("plain http: %d %v", code, evs)
	}
	j.URL, j.Dest = "https://127.0.0.1:"+port+"/payload.bin", "/nonexistent-dir/x"
	if code, evs := runJob(t, j); code != 1 || !strings.Contains(lastEv(evs)["error"].(string), "cannot write") {
		t.Errorf("unwritable: %d %v", code, evs)
	}
	j.CA, j.CAFile, j.Dest = "", filepath.Join(dir, "missing.pem"), filepath.Join(dir, "noca")
	if code, evs := runJob(t, j); code != 1 || !strings.Contains(lastEv(evs)["error"].(string), "no CA bundle") {
		t.Errorf("no CA: %d %v", code, evs)
	}
	seen()
}

func TestPostAndCAFile(t *testing.T) {
	port, ca, seen := server(t)
	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.pem")
	os.WriteFile(caFile, []byte(ca), 0o644)
	j := job{CAFile: caFile, Clock: at(in2030), URL: "https://127.0.0.1:" + port + "/post", Dest: filepath.Join(dir, "p"),
		Method: "POST", Body: "a=1", Headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}}
	code, evs := runJob(t, j)
	b, _ := os.ReadFile(j.Dest)
	if code != 0 || string(b) != "posted a=1" {
		t.Fatalf("post: %d %v %q", code, evs, b)
	}
	if s := seen(); len(s) != 1 || s[0].method != "POST" || s[0].ua != "" {
		t.Errorf("post request (no user agent unless given): %+v", s)
	}
}

// ntpServer answers like an NTP server with the time at, shifted by skew.
func ntpServer(t *testing.T, skew time.Duration, mangle func([]byte)) string {
	t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 512)
		for {
			n, addr, err := c.ReadFrom(buf)
			if err != nil {
				return
			}
			if n < 48 {
				continue
			}
			res := ntpAnswer(in2030Time().Add(skew), buf[40:48])
			if mangle != nil {
				mangle(res)
			}
			c.WriteTo(res, addr)
		}
	}()
	return c.LocalAddr().String()
}

func in2030Time() time.Time {
	return time.UnixMilli(in2030.UnixMs)
}

func ntpAnswer(at time.Time, nonce []byte) []byte {
	res := make([]byte, 48)
	res[0] = 0x24 // version 4, server
	res[1] = 2
	copy(res[24:32], nonce)
	sec := uint64(at.Unix() + ntpEpoch)
	frac := uint64(at.Nanosecond()) << 32 / 1e9
	binary.BigEndian.PutUint32(res[40:44], uint32(sec))
	binary.BigEndian.PutUint32(res[44:48], uint32(frac))
	return res
}

func TestNetworkClock(t *testing.T) {
	lookup := lookupVia(nil)
	near := func(c clock, want time.Time) bool {
		d := c.now().Sub(want)
		return d > -2*time.Second && d < 2*time.Second
	}
	a, b := ntpServer(t, 0, nil), ntpServer(t, time.Second, nil)
	far := ntpServer(t, 3*time.Hour, nil)
	c, err := networkClock([]string{a, far, b}, lookup)
	if err != nil || !near(c, in2030Time()) {
		t.Errorf("two of three agree: %v %v", c.now(), err)
	}
	if _, err := networkClock([]string{a, far}, lookup); err == nil {
		t.Errorf("two that disagree are no time")
	}
	if c, err := networkClock([]string{a}, lookup); err != nil || !near(c, in2030Time()) {
		t.Errorf("one named, one asked: %v %v", c, err)
	}
	quiet, _ := net.ListenPacket("udp4", "127.0.0.1:0")
	defer quiet.Close()
	if _, err := networkClock([]string{a, quiet.LocalAddr().String()}, lookup); err == nil {
		t.Errorf("one of two silent is no time")
	}
	unsynced := ntpServer(t, 0, func(b []byte) { b[0] |= 0xc0 })
	other := ntpServer(t, 0, func(b []byte) { b[24] ^= 1 })
	if _, err := networkClock([]string{unsynced, other}, lookup); err == nil {
		t.Errorf("an unsynchronised server and an answer to another request are no time")
	}

	// a download asks for the time when the job gives none, and reports it
	port, ca, _ := server(t)
	j := job{CA: ca, NTP: []string{a, b}, URL: "https://127.0.0.1:" + port + "/payload.bin", Dest: filepath.Join(t.TempDir(), "x")}
	code, evs := runJob(t, j)
	if code != 0 || evs[0]["clock"] == nil || lastEv(evs)["done"] != true {
		t.Errorf("download on the network's time: %d %v", code, evs)
	}
	j.NTP = []string{quiet.LocalAddr().String()}
	if code, evs := runJob(t, j); code != 1 || !strings.Contains(lastEv(evs)["error"].(string), "no time from the network") {
		t.Errorf("no time, no download: %d %v", code, evs)
	}
}

func TestParseNTP(t *testing.T) {
	nonce := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	at := time.Date(2040, 3, 1, 12, 0, 0, 500e6, time.UTC) // NTP era 1
	ms, err := parseNTP(ntpAnswer(at, nonce), nonce)
	if err != nil || ms != at.UnixMilli() {
		t.Errorf("era 1: %v %v", time.UnixMilli(ms).UTC(), err)
	}
	if _, err := parseNTP(ntpAnswer(time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), nonce), nonce); err == nil {
		t.Errorf("a time before this tool is refused")
	}
	for name, m := range map[string]func([]byte){
		"client mode": func(b []byte) { b[0] = 0x23 },
		"stratum 0":   func(b []byte) { b[1] = 0 },
		"stratum 16":  func(b []byte) { b[1] = 16 },
		"no time":     func(b []byte) { copy(b[40:48], make([]byte, 8)) },
		"short":       nil,
	} {
		b := ntpAnswer(at, nonce)
		if m != nil {
			m(b)
		} else {
			b = b[:40]
		}
		if _, err := parseNTP(b, nonce); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestClockUsable(t *testing.T) {
	var nilClock *clock
	if nilClock.usable() || (&clock{UnixMs: in2030.UnixMs}).usable() || (&clock{UnixMs: 1, BootNs: 1}).usable() ||
		(&clock{UnixMs: in2030.UnixMs, BootNs: bootNow() + int64(time.Hour)}).usable() || !at(in2030).usable() {
		t.Errorf("usable")
	}
	c := at(in2030)
	time.Sleep(50 * time.Millisecond)
	if d := c.now().Sub(in2030Time()); d < 50*time.Millisecond || d > time.Second {
		t.Errorf("the clock runs on boot time: %v", d)
	}
}
