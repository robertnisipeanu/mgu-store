package main

// Requests: /run/mgu-uplink/ctl.sock, root only (0600). One JSON object per
// line in, one JSON line back, one request per connection. The Store talks
// only to the updater, which relays its requests here; status.json shows
// the results.
//
//	{"op": "prefer", "kind": "phone"}                  the group tried first: wifi, usb, phone ("": none), kept in settings_conf
//	{"op": "wifi-enable", "on": true}                  Wi-Fi on or off, kept in settings_conf
//	{"op": "wifi-5ghz", "on": true}                    joins use 5 GHz too, kept in settings_conf
//	{"op": "usb-phone", "on": false}                   phones over USB taken or left alone, kept in settings_conf
//	{"op": "wifi-scan"}                                scan; status.json's wifi.networks follow
//	{"op": "wifi-connect", "ssid": "…", "psk": "…"}    join; saved once joined (psk "": a saved or an open network)
//	{"op": "wifi-forget", "ssid": "…"}                 forget a saved network
//
//	{"ok": true}  or  {"ok": false, "error": "…"}
//
// A psk goes to the supplicant only (wpa.conf once joined): it is never
// logged, and no reply or status names it.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

const ctlMaxRequest = 4096

type ctlRequest struct {
	Op   string  `json:"op"`
	Kind *string `json:"kind"`
	On   *bool   `json:"on"`
	SSID string  `json:"ssid"`
	PSK  string  `json:"psk"`
}

type ctlReply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func listenCtl(path string, handle func(ctlRequest) error) (net.Listener, error) {
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		ln.Close()
		return nil, err
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			go serveCtl(conn, handle)
		}
	}()
	return ln, nil
}

func serveCtl(conn net.Conn, handle func(ctlRequest) error) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	reply := ctlReply{OK: true}
	line, err := bufio.NewReader(io.LimitReader(conn, ctlMaxRequest)).ReadBytes('\n')
	var r ctlRequest
	if err != nil && (err != io.EOF || len(line) == 0) || json.Unmarshal(line, &r) != nil {
		reply = ctlReply{Error: fmt.Sprintf("bad request: one JSON object of at most %d bytes, then a newline", ctlMaxRequest)}
	} else if err := handle(r); err != nil {
		reply = ctlReply{Error: err.Error()}
	}
	b, _ := json.Marshal(reply)
	conn.Write(append(b, '\n'))
}

var errNoWiFi = errors.New("Wi-Fi needs uplink = auto")

func (s *service) request(r ctlRequest) error {
	w := s.wifi
	switch r.Op {
	case "prefer":
		su, ok := s.up.(*scanUplink)
		switch {
		case r.Kind == nil:
			return errors.New("prefer needs a kind")
		case !ok:
			return errors.New("a preferred uplink needs uplink = auto")
		}
		if err := checkPreferred(*r.Kind); err != nil {
			return err
		}
		s.ctlMu.Lock()
		defer s.ctlMu.Unlock()
		if err := setSetting(s.cfg.Settings, "preferred", *r.Kind); err != nil {
			return err
		}
		su.setPreferred(*r.Kind)
		setStatusPreferred(*r.Kind)
		logf("preferred uplink: %q", *r.Kind)
		return nil
	case "wifi-enable":
		switch {
		case r.On == nil:
			return errors.New("wifi-enable needs on: true or false")
		case w == nil:
			return errNoWiFi
		}
		s.ctlMu.Lock()
		defer s.ctlMu.Unlock()
		if err := setSetting(s.cfg.Settings, "wifi", onOff(*r.On)); err != nil {
			return err
		}
		w.setEnabled(*r.On)
		return nil
	case "wifi-5ghz":
		switch {
		case r.On == nil:
			return errors.New("wifi-5ghz needs on: true or false")
		case w == nil:
			return errNoWiFi
		}
		s.ctlMu.Lock()
		defer s.ctlMu.Unlock()
		if err := setSetting(s.cfg.Settings, "wifi_5ghz", onOff(*r.On)); err != nil {
			return err
		}
		w.setAllow5(*r.On)
		return nil
	case "usb-phone":
		su, ok := s.up.(*scanUplink)
		switch {
		case r.On == nil:
			return errors.New("usb-phone needs on: true or false")
		case !ok:
			return errors.New("phones over USB need uplink = auto")
		}
		s.ctlMu.Lock()
		defer s.ctlMu.Unlock()
		if err := setSetting(s.cfg.Settings, "usb_phone", onOff(*r.On)); err != nil {
			return err
		}
		su.setUSBPhone(*r.On)
		setStatusUSBPhone(r.On)
		logf("phones over USB: %s", onOff(*r.On))
		return nil
	case "wifi-scan", "wifi-connect", "wifi-forget":
		if w == nil {
			return errNoWiFi
		}
		switch r.Op {
		case "wifi-scan":
			return w.scan()
		case "wifi-connect":
			return w.connect(r.SSID, r.PSK)
		}
		return w.forget(r.SSID)
	}
	return fmt.Errorf("unknown op %q", r.Op)
}
