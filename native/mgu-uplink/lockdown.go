package main

// Trust between the unit and an iPhone. An iPhone drops every network
// packet from a host it has not paired with (Linux ipheth.c; kernel commit
// bb1b40c7), so before its hotspot carries anything the unit does what
// usbmuxd's preflight does on each plug-in, through lockdownd (port 62078
// over usbmux): QueryType; with a pair record for this phone, StartSession
// and the TLS switch with the record's host certificate; without one, Pair
// with a freshly made certificate chain, which shows "Trust This
// Computer?" on the phone, repeated until the owner taps Trust (and enters
// the passcode), then the session. The pair record is kept in
// <state dir>/pair/<udid>.json (root, 0600), so the prompt appears once
// per phone. The certificate chain follows libimobiledevice and go-ios
// (github.com/danielpaulus/go-ios, MIT): a self-signed root, a host and a
// device certificate (the phone's DevicePublicKey) signed by it, all RSA
// 2048. Tested in iphone_test.go against a fake phone.

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const lockdownLabel = "mgu-uplink"

// lockdownError is lockdownd's "Error" reply.
type lockdownError struct{ request, code string }

func (e *lockdownError) Error() string { return fmt.Sprintf("lockdown %s: %s", e.request, e.code) }

func lockdownCode(err error) string {
	var le *lockdownError
	if errors.As(err, &le) {
		return le.code
	}
	return ""
}

// lockdownClient speaks lockdownd's framing: a 4-byte big-endian length,
// then an XML plist.
type lockdownClient struct {
	conn net.Conn
}

func (l *lockdownClient) call(req map[string]interface{}) (map[string]interface{}, error) {
	req["Label"] = lockdownLabel
	if err := writePlistMessage(l.conn, req); err != nil {
		return nil, err
	}
	l.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer l.conn.SetReadDeadline(time.Time{})
	resp, err := readPlistMessage(l.conn)
	if err != nil {
		return nil, err
	}
	if code, ok := resp["Error"].(string); ok {
		return resp, &lockdownError{fmt.Sprint(req["Request"]), code}
	}
	return resp, nil
}

func writePlistMessage(w io.Writer, v map[string]interface{}) error {
	body, err := plistEncode(v)
	if err != nil {
		return err
	}
	msg := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(msg, uint32(len(body)))
	copy(msg[4:], body)
	_, err = w.Write(msg)
	return err
}

func readPlistMessage(r io.Reader) (map[string]interface{}, error) {
	var lb [4]byte
	if _, err := io.ReadFull(r, lb[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(lb[:])
	if n == 0 || n > 1<<20 {
		return nil, fmt.Errorf("lockdown: message of %d bytes", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	v, err := plistDecode(body)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("lockdown: reply is not a dict")
	}
	return m, nil
}

func (l *lockdownClient) getValue(key string) (interface{}, error) {
	resp, err := l.call(map[string]interface{}{"Request": "GetValue", "Key": key})
	if err != nil {
		return nil, err
	}
	return resp["Value"], nil
}

// pairRecord is what the unit keeps per phone. The certificates and keys
// are PEM.
type pairRecord struct {
	UDID              string `json:"udid"`
	HostID            string `json:"hostID"`
	SystemBUID        string `json:"systemBUID"`
	HostCertificate   []byte `json:"hostCertificate"`
	HostPrivateKey    []byte `json:"hostPrivateKey"`
	RootCertificate   []byte `json:"rootCertificate"`
	RootPrivateKey    []byte `json:"rootPrivateKey"`
	DeviceCertificate []byte `json:"deviceCertificate"`
	DevicePublicKey   []byte `json:"devicePublicKey"`
	EscrowBag         []byte `json:"escrowBag,omitempty"`
}

// pairRequestRecord is the part of the record the phone gets in Pair.
func (r *pairRecord) pairRequestRecord() map[string]interface{} {
	return map[string]interface{}{
		"DeviceCertificate": r.DeviceCertificate,
		"HostCertificate":   r.HostCertificate,
		"RootCertificate":   r.RootCertificate,
		"HostID":            r.HostID,
		"SystemBUID":        r.SystemBUID,
	}
}

var udidRe = regexp.MustCompile(`^[0-9A-Za-z-]{8,64}$`)

func pairRecordPath(dir, udid string) string { return filepath.Join(dir, udid+".json") }

func loadPairRecord(dir, udid string) *pairRecord {
	b, err := os.ReadFile(pairRecordPath(dir, udid))
	if err != nil {
		return nil
	}
	var r pairRecord
	if json.Unmarshal(b, &r) != nil || r.UDID != udid || r.HostID == "" || len(r.HostCertificate) == 0 {
		return nil
	}
	return &r
}

func (r *pairRecord) save(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	os.Chmod(dir, 0700)
	return writeJSON(pairRecordPath(dir, r.UDID), r, 0600)
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return strings.ToUpper(fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]))
}

// parseDevicePublicKey reads the phone's DevicePublicKey: PEM, PKCS#1
// ("RSA PUBLIC KEY") or PKIX.
func parseDevicePublicKey(b []byte) (*rsa.PublicKey, error) {
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, fmt.Errorf("DevicePublicKey: not PEM")
	}
	if k, err := x509.ParsePKCS1PublicKey(blk.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("DevicePublicKey: %v", err)
	}
	rk, ok := k.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("DevicePublicKey: %T, want RSA", k)
	}
	return rk, nil
}

// newPairRecord makes the certificate chain for a phone. The validity
// starts in 2020 so a unit clock that is behind still lies inside it.
func newPairRecord(udid string, devicePublicKey []byte) (*pairRecord, error) {
	devKey, err := parseDevicePublicKey(devicePublicKey)
	if err != nil {
		return nil, err
	}
	rootKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	hostKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	notBefore := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter := time.Now().AddDate(30, 0, 0)
	root := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: notBefore, NotAfter: notAfter,
		BasicConstraintsValid: true, IsCA: true, SignatureAlgorithm: x509.SHA256WithRSA}
	rootDER, err := x509.CreateCertificate(rand.Reader, root, root, &rootKey.PublicKey, rootKey)
	if err != nil {
		return nil, fmt.Errorf("root certificate: %v", err)
	}
	rootCert, _ := x509.ParseCertificate(rootDER)
	leaf := func(serial int64, pub *rsa.PublicKey) ([]byte, error) {
		t := &x509.Certificate{SerialNumber: big.NewInt(serial), NotBefore: notBefore, NotAfter: notAfter,
			BasicConstraintsValid: true, IsCA: false, SignatureAlgorithm: x509.SHA256WithRSA,
			KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment}
		return x509.CreateCertificate(rand.Reader, t, rootCert, pub, rootKey)
	}
	hostDER, err := leaf(2, &hostKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("host certificate: %v", err)
	}
	devDER, err := leaf(3, devKey)
	if err != nil {
		return nil, fmt.Errorf("device certificate: %v", err)
	}
	certPEM := func(der []byte) []byte { return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}) }
	keyPEM := func(k *rsa.PrivateKey) []byte {
		return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
	}
	return &pairRecord{UDID: udid, HostID: newUUID(), SystemBUID: newUUID(),
		HostCertificate: certPEM(hostDER), HostPrivateKey: keyPEM(hostKey),
		RootCertificate: certPEM(rootDER), RootPrivateKey: keyPEM(rootKey),
		DeviceCertificate: certPEM(devDER), DevicePublicKey: devicePublicKey}, nil
}

// startSession opens a lockdown session with the record and switches the
// connection to TLS when the phone asks for it, then ends the session:
// the phone has then accepted this host for this attachment.
func (l *lockdownClient) startSession(r *pairRecord) error {
	resp, err := l.call(map[string]interface{}{"Request": "StartSession", "HostID": r.HostID, "SystemBUID": r.SystemBUID})
	if err != nil {
		return err
	}
	session, _ := resp["SessionID"].(string)
	if ssl, _ := resp["EnableSessionSSL"].(bool); ssl {
		cert, err := tls.X509KeyPair(r.HostCertificate, r.HostPrivateKey)
		if err != nil {
			return fmt.Errorf("host certificate: %v", err)
		}
		tc := tls.Client(l.conn, &tls.Config{Certificates: []tls.Certificate{cert},
			InsecureSkipVerify: true, MinVersion: tls.VersionTLS10})
		l.conn.SetDeadline(time.Now().Add(10 * time.Second))
		err = tc.Handshake()
		l.conn.SetDeadline(time.Time{})
		if err != nil {
			return fmt.Errorf("lockdown TLS: %v", err)
		}
		l.conn = tc
	}
	if session != "" {
		l.call(map[string]interface{}{"Request": "StopSession", "SessionID": session})
	}
	return nil
}

// trustStates are what pairIPhone reports while it waits.
const (
	trustWaiting = "Tap Trust on the iPhone"
	trustLocked  = "Unlock the iPhone"
)

var errTrustDenied = errors.New("the iPhone's owner did not trust this unit")

// pendingRecords keeps the chain offered to a phone while its Trust
// prompt is open, so every Pair repeat offers the same one.
var (
	pendingMu      sync.Mutex
	pendingRecords = map[string]*pairRecord{}
)

// pairIPhone establishes trust with the phone behind m (see the top of
// this file). wait reports the prompt state; pairIPhone polls the phone
// every 2 s until the owner answers, ctx ends or the phone leaves.
func pairIPhone(ctx context.Context, m *usbMux, dir string, wait func(msg string)) (string, error) {
	conn, err := m.Dial(lockdownPort, 5*time.Second)
	if err != nil {
		return "", fmt.Errorf("lockdown: %w", err)
	}
	ld := &lockdownClient{conn: conn}
	defer func() { ld.conn.Close() }()
	resp, err := ld.call(map[string]interface{}{"Request": "QueryType"})
	if err != nil {
		return "", err
	}
	if t, _ := resp["Type"].(string); t != "com.apple.mobile.lockdown" {
		return "", fmt.Errorf("lockdown: QueryType says %q", t)
	}
	v, err := ld.getValue("UniqueDeviceID")
	if err != nil {
		return "", err
	}
	udid, _ := v.(string)
	if !udidRe.MatchString(udid) {
		return "", fmt.Errorf("lockdown: unusable UniqueDeviceID %q", udid)
	}
	if rec := loadPairRecord(dir, udid); rec != nil {
		err := ld.startSession(rec)
		switch lockdownCode(err) {
		case "":
			if err != nil {
				return udid, err
			}
			return udid, nil
		case "InvalidHostID", "InvalidPairRecord":
			logf("iPhone %s no longer trusts this unit (%s); pairing again", udid, lockdownCode(err))
			os.Remove(pairRecordPath(dir, udid))
		default:
			return udid, err
		}
	}
	pk, err := ld.getValue("DevicePublicKey")
	if err != nil {
		return udid, err
	}
	pkb, _ := pk.([]byte)
	pendingMu.Lock()
	rec := pendingRecords[udid]
	if rec == nil || string(rec.DevicePublicKey) != string(pkb) {
		if rec, err = newPairRecord(udid, pkb); err != nil {
			pendingMu.Unlock()
			return udid, err
		}
		pendingRecords[udid] = rec
	}
	pendingMu.Unlock()
	// usbmuxd names itself before asking (UntrustedHostBUID); the answer
	// does not matter.
	ld.call(map[string]interface{}{"Request": "SetValue", "Key": "UntrustedHostBUID", "Value": rec.SystemBUID})
	for {
		resp, err := ld.call(map[string]interface{}{"Request": "Pair", "ProtocolVersion": "2",
			"PairRecord": rec.pairRequestRecord(), "PairingOptions": map[string]interface{}{"ExtendedPairingErrors": true}})
		if err == nil {
			if eb, ok := resp["EscrowBag"].([]byte); ok {
				rec.EscrowBag = eb
			}
			if err := rec.save(dir); err != nil {
				return udid, fmt.Errorf("save pair record: %v", err)
			}
			pendingMu.Lock()
			delete(pendingRecords, udid)
			pendingMu.Unlock()
			logf("iPhone %s trusts this unit", udid)
			return udid, ld.startSession(rec)
		}
		switch lockdownCode(err) {
		case "PairingDialogResponsePending":
			wait(trustWaiting)
		case "PasswordProtected":
			wait(trustLocked)
		case "UserDeniedPairing":
			return udid, errTrustDenied
		default:
			return udid, err
		}
		select {
		case <-ctx.Done():
			return udid, ctx.Err()
		case <-m.Done():
			return udid, fmt.Errorf("iPhone left: %v", m.Err())
		case <-time.After(2 * time.Second):
		}
	}
}
