package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxRedirects = 5
	idle         = 30 * time.Second
)

type job struct {
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Dest     string            `json:"dest"`
	MaxBytes int64             `json:"maxBytes"`
	DNS      []string          `json:"dns"`
	CA       string            `json:"ca"`
	CAFile   string            `json:"caFile"`
	Method   string            `json:"method"`
	Body     string            `json:"body"`
	Keep     []string          `json:"keep"`
	Clock    *clock            `json:"clock"`
	NTP      []string          `json:"ntp"`
}

type event map[string]interface{}

var outMu sync.Mutex

func emit(w io.Writer, e event) {
	b, _ := json.Marshal(e)
	outMu.Lock()
	w.Write(append(b, '\n'))
	outMu.Unlock()
}

// run makes the download and returns the exit status: 0 done or 304, 1 failed.
func run(j job, w io.Writer) int {
	fail := func(e event) int {
		emit(w, e)
		return 1
	}
	pool, err := roots(j)
	if err != nil {
		return fail(event{"error": err.Error()})
	}
	lookup := lookupVia(j.DNS)
	c := j.Clock
	if !c.usable() {
		got, err := networkClock(j.NTP, lookup)
		if err != nil {
			return fail(event{"error": "no time from the network: " + err.Error()})
		}
		c = &got
		emit(w, event{"clock": got})
	}
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ip, err := lookup(ctx, host)
			if err != nil {
				return nil, err
			}
			d := net.Dialer{Timeout: idle}
			return d.DialContext(ctx, "tcp4", net.JoinHostPort(ip, port))
		},
		TLSClientConfig:       &tls.Config{RootCAs: pool, Time: c.now, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   idle,
		ResponseHeaderTimeout: idle,
		DisableCompression:    true,
		DisableKeepAlives:     true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return get(j, client, w, j.URL, j.Headers, 0)
}

// roots: ca (a self-hosted catalog's own CA), else the bundle in caFile.
func roots(j job) (*x509.CertPool, error) {
	pem := j.CA
	if pem == "" && j.CAFile != "" {
		b, err := os.ReadFile(j.CAFile)
		if err != nil {
			return nil, fmt.Errorf("no CA bundle: %v", err)
		}
		pem = string(b)
	}
	if pem == "" {
		return nil, errors.New("no CA bundle")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(pem)) {
		return nil, errors.New("no certificate in the CA bundle")
	}
	return pool, nil
}

// lookupVia resolves a name to its first IPv4 address through the given
// servers (host or host:port, 53 by default), each tried in turn; with none,
// the system resolver.
func lookupVia(servers []string) func(context.Context, string) (string, error) {
	return func(ctx context.Context, host string) (string, error) {
		if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
			return ip.String(), nil
		}
		resolvers := []*net.Resolver{net.DefaultResolver}
		if len(servers) > 0 {
			resolvers = nil
			for _, s := range servers {
				addr := s
				if _, _, err := net.SplitHostPort(s); err != nil {
					addr = net.JoinHostPort(s, "53")
				}
				resolvers = append(resolvers, &net.Resolver{PreferGo: true,
					Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
						d := net.Dialer{Timeout: 5 * time.Second}
						return d.DialContext(ctx, "udp4", addr)
					}})
			}
		}
		var last error
		for _, r := range resolvers {
			ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			ips, err := r.LookupIP(ctx, "ip4", host)
			cancel()
			if err == nil && len(ips) > 0 {
				return ips[0].String(), nil
			}
			if err == nil {
				err = fmt.Errorf("no address for %s", host)
			}
			last = err
		}
		return "", last
	}
}

// kept: the response headers the job names (lower case), those present.
func kept(j job, res *http.Response) map[string]string {
	out := map[string]string{}
	for _, h := range j.Keep {
		if v := res.Header.Values(h); len(v) == 1 {
			out[h] = v[0]
		}
	}
	return out
}

func get(j job, client *http.Client, w io.Writer, raw string, headers map[string]string, hops int) int {
	fail := func(e event) int {
		emit(w, e)
		return 1
	}
	target, err := url.Parse(raw)
	if err != nil {
		return fail(event{"error": "bad URL"})
	}
	if target.Scheme != "https" {
		return fail(event{"error": fmt.Sprintf("refusing %s: URL", target.Scheme)})
	}
	post := hops == 0 && j.Method == "POST"
	method, body := "GET", io.Reader(nil)
	if post {
		method, body = "POST", bytes.NewReader([]byte(j.Body))
	}
	req, err := http.NewRequest(method, target.String(), body)
	if err != nil {
		return fail(event{"error": "bad URL"})
	}
	ua := false
	for k, v := range headers {
		req.Header.Set(k, v)
		ua = ua || strings.EqualFold(k, "User-Agent")
	}
	if !ua {
		req.Header.Set("User-Agent", "") // none, as fetch.js sends none
	}
	host := target.Hostname()
	res, err := client.Do(req)
	if err != nil {
		return fail(event{"error": fmt.Sprintf("%s: %s", host, reason(err))})
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case 301, 302, 303, 307, 308:
		if loc := res.Header.Get("Location"); !post && loc != "" {
			if hops >= maxRedirects {
				return fail(event{"error": "too many redirects"})
			}
			next, err := target.Parse(loc)
			if err != nil {
				return fail(event{"error": "bad redirect"})
			}
			// first-host headers stay behind; only a user agent and a conditional
			// request's validators go along (a release asset's ETag is its storage host's)
			along := map[string]string{}
			for _, h := range []string{"User-Agent", "If-None-Match", "If-Modified-Since"} {
				if v, ok := headers[h]; ok {
					along[h] = v
				}
			}
			res.Body.Close()
			return get(j, client, w, next.String(), along, hops+1)
		}
	case 304:
		emit(w, event{"notModified": true, "status": 304, "headers": kept(j, res)})
		return 0
	}
	if res.StatusCode != 200 {
		e := event{"error": fmt.Sprintf("HTTP %d from %s", res.StatusCode, host), "status": res.StatusCode}
		if res.StatusCode == 429 || (res.StatusCode == 403 &&
			(res.Header.Get("X-Ratelimit-Remaining") == "0" || len(res.Header.Values("Retry-After")) > 0)) {
			e["rateLimited"] = true
		}
		return fail(e)
	}
	var total interface{}
	if n, err := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64); err == nil && n > 0 {
		total = n
		if j.MaxBytes > 0 && n > j.MaxBytes {
			return fail(event{"error": fmt.Sprintf("%d bytes is more than the expected %d", n, j.MaxBytes), "tooBig": true})
		}
	}
	out, err := os.OpenFile(j.Dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(event{"error": fmt.Sprintf("cannot write %s: %s", j.Dest, reason(err))})
	}
	defer out.Close()
	var stalled atomic.Bool
	timer := time.AfterFunc(idle, func() {
		stalled.Store(true)
		res.Body.Close()
	})
	defer timer.Stop()
	buf := make([]byte, 64<<10)
	var n int64
	last := time.Time{}
	for {
		k, rerr := res.Body.Read(buf)
		timer.Reset(idle)
		if k > 0 {
			n += int64(k)
			if j.MaxBytes > 0 && n > j.MaxBytes {
				return fail(event{"error": fmt.Sprintf("more than the expected %d bytes", j.MaxBytes), "tooBig": true})
			}
			if _, err := out.Write(buf[:k]); err != nil {
				return fail(event{"error": fmt.Sprintf("cannot write %s: %s", j.Dest, reason(err))})
			}
			if time.Since(last) > 250*time.Millisecond {
				last = time.Now()
				emit(w, event{"progress": n, "total": total})
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil || stalled.Load() {
			return fail(event{"error": "connection closed mid-download"})
		}
	}
	if err := out.Close(); err != nil {
		return fail(event{"error": fmt.Sprintf("cannot write %s: %s", j.Dest, reason(err))})
	}
	emit(w, event{"done": true, "bytes": n, "status": res.StatusCode, "headers": kept(j, res)})
	return 0
}

// reason: an error's innermost text, the URL and operation left out.
func reason(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		err = pe.Err
	}
	return err.Error()
}
