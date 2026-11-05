package main

// A minimal D-Bus client for the system bus: method calls with typed
// arguments and their decoded replies. It speaks the wire protocol itself
// (SASL EXTERNAL, Hello, calls), so no stock tool runs for it.

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

var systemBusSocket = "/var/run/dbus/system_bus_socket"

const (
	dbusMethodCall   = 1
	dbusNoAutoStart  = 0x2
	dbusMethodReturn = 2
	dbusError        = 3

	dbusFieldPath        = 1
	dbusFieldInterface   = 2
	dbusFieldMember      = 3
	dbusFieldErrorName   = 4
	dbusFieldReplySerial = 5
	dbusFieldDestination = 6
	dbusFieldSignature   = 8
)

var errDBusNoAnswer = errors.New("D-Bus: no answer")

// dbusErrorReply is an error reply: its name, and its message when it has one.
type dbusErrorReply struct{ name, msg string }

func (e *dbusErrorReply) Error() string {
	if e.msg == "" {
		return e.name
	}
	return e.name + ": " + e.msg
}

// dbusErrorName is err's D-Bus error name, "" for any other error.
func dbusErrorName(err error) string {
	var e *dbusErrorReply
	if errors.As(err, &e) {
		return e.name
	}
	return ""
}

// Values: string, objPath, uint32, int32, bool, []byte (ay), dbusVariant,
// dbusProps (a{sv}) to send; replies also decode to the other basic types,
// []any for arrays, []any for structs and map[string]any for dictionaries.
type objPath string

type dbusVariant struct {
	sig string
	val any
}

type dbusProp struct {
	key string
	val dbusVariant
}

// dbusProps is an a{sv} in the order given.
type dbusProps []dbusProp

// dbusCall calls dest's member on path/iface with string arguments over the
// system bus, all within timeout. A reply is nil; an error reply is a
// *dbusErrorReply.
func dbusCall(timeout time.Duration, dest, path, iface, member string, args ...string) error {
	c, err := dialBus(timeout)
	if err != nil {
		return err
	}
	defer c.close()
	vals := make([]any, len(args))
	for i, a := range args {
		vals[i] = a
	}
	_, err = c.call(dest, objPath(path), iface, member, strings.Repeat("s", len(args)), vals...)
	return err
}

// dbusConn is one connection to the system bus. Each call has the
// connection's timeout; any error but an error reply leaves it unusable.
type dbusConn struct {
	c       net.Conn
	r       *bufio.Reader
	timeout time.Duration
	serial  uint32
}

func dialBus(timeout time.Duration) (*dbusConn, error) {
	c, err := net.DialTimeout("unix", systemBusSocket, timeout)
	if err != nil {
		return nil, err
	}
	b := &dbusConn{c: c, r: bufio.NewReader(c), timeout: timeout}
	if err := b.hello(); err != nil {
		c.Close()
		return nil, b.wrap(err)
	}
	return b, nil
}

func (b *dbusConn) close() { b.c.Close() }

func (b *dbusConn) wrap(err error) error {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return errDBusNoAnswer
	}
	return err
}

func (b *dbusConn) hello() error {
	b.c.SetDeadline(time.Now().Add(b.timeout))
	uid := hex.EncodeToString([]byte(strconv.Itoa(os.Getuid())))
	if _, err := io.WriteString(b.c, "\x00AUTH EXTERNAL "+uid+"\r\n"); err != nil {
		return err
	}
	line, err := b.r.ReadString('\n')
	if err != nil {
		return err
	}
	if !strings.HasPrefix(line, "OK ") {
		return fmt.Errorf("D-Bus: authentication refused: %s", strings.TrimSpace(line))
	}
	if _, err := io.WriteString(b.c, "BEGIN\r\n"); err != nil {
		return err
	}
	_, err = b.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "")
	return err
}

// call sends a method call with args encoded as sig and returns the reply's
// values. Signals and replies to other calls are skipped.
func (b *dbusConn) call(dest string, path objPath, iface, member, sig string, args ...any) ([]any, error) {
	b.serial++
	m, err := dbusMessage(b.serial, dest, path, iface, member, sig, args)
	if err != nil {
		return nil, err
	}
	b.c.SetDeadline(time.Now().Add(b.timeout))
	if _, err := b.c.Write(m); err != nil {
		return nil, b.wrap(err)
	}
	for {
		msg, err := dbusRead(b.r)
		if err != nil {
			return nil, b.wrap(err)
		}
		if msg.replyTo != b.serial || msg.typ != dbusMethodReturn && msg.typ != dbusError {
			continue
		}
		if msg.typ == dbusError {
			e := &dbusErrorReply{name: msg.errName}
			if len(msg.body) > 0 {
				e.msg, _ = msg.body[0].(string)
			}
			return nil, e
		}
		return msg.body, nil
	}
}

// dbusMessage is a little-endian method call with args encoded as sig.
func dbusMessage(serial uint32, dest string, path objPath, iface, member, sig string, args []any) ([]byte, error) {
	var body dbusEnc
	rest := sig
	for _, a := range args {
		if rest == "" {
			return nil, errors.New("D-Bus: more arguments than the signature")
		}
		n := sigNext(rest)
		if err := body.value(rest[:n], a); err != nil {
			return nil, err
		}
		rest = rest[n:]
	}
	if rest != "" {
		return nil, errors.New("D-Bus: fewer arguments than the signature")
	}
	// the header fields start at offset 16: an encoder over the whole
	// header keeps their alignment
	h := dbusEnc{b: make([]byte, 16)}
	field := func(code byte, s string, v any) {
		h.pad(8)
		h.b = append(h.b, code)
		h.value("g", s)
		h.value(s, v)
	}
	field(dbusFieldPath, "o", path)
	field(dbusFieldInterface, "s", iface)
	field(dbusFieldMember, "s", member)
	field(dbusFieldDestination, "s", dest)
	if sig != "" {
		field(dbusFieldSignature, "g", sig)
	}
	m := h.b
	var flags byte
	if dest == wpaDBus {
		// a call must never start the car's wpa_supplicant (the firmware
		// has a D-Bus activation file for it)
		flags = dbusNoAutoStart
	}
	copy(m, []byte{'l', dbusMethodCall, flags, 1})
	binary.LittleEndian.PutUint32(m[4:], uint32(len(body.b)))
	binary.LittleEndian.PutUint32(m[8:], serial)
	binary.LittleEndian.PutUint32(m[12:], uint32(len(m)-16))
	m = dbusPad(m, 8)
	return append(m, body.b...), nil
}

func dbusPad(b []byte, n int) []byte {
	for len(b)%n != 0 {
		b = append(b, 0)
	}
	return b
}

// dbusEnc writes little-endian values.
type dbusEnc struct{ b []byte }

func (e *dbusEnc) pad(n int) { e.b = dbusPad(e.b, n) }

func (e *dbusEnc) u32(v uint32) {
	e.pad(4)
	e.b = binary.LittleEndian.AppendUint32(e.b, v)
}

func (e *dbusEnc) str(s string) {
	e.u32(uint32(len(s)))
	e.b = append(append(e.b, s...), 0)
}

func (e *dbusEnc) value(sig string, v any) error {
	bad := fmt.Errorf("D-Bus: can't send %T as %s", v, sig)
	switch sig {
	case "s":
		s, ok := v.(string)
		if !ok {
			return bad
		}
		e.str(s)
	case "o":
		s, ok := v.(objPath)
		if !ok {
			return bad
		}
		e.str(string(s))
	case "g":
		s, ok := v.(string)
		if !ok || len(s) > 255 {
			return bad
		}
		e.b = append(append(append(e.b, byte(len(s))), s...), 0)
	case "u":
		x, ok := v.(uint32)
		if !ok {
			return bad
		}
		e.u32(x)
	case "i":
		x, ok := v.(int32)
		if !ok {
			return bad
		}
		e.u32(uint32(x))
	case "n":
		x, ok := v.(int16)
		if !ok {
			return bad
		}
		e.pad(2)
		e.b = binary.LittleEndian.AppendUint16(e.b, uint16(x))
	case "q":
		x, ok := v.(uint16)
		if !ok {
			return bad
		}
		e.pad(2)
		e.b = binary.LittleEndian.AppendUint16(e.b, x)
	case "b":
		x, ok := v.(bool)
		if !ok {
			return bad
		}
		e.u32(map[bool]uint32{false: 0, true: 1}[x])
	case "v":
		x, ok := v.(dbusVariant)
		if !ok {
			return bad
		}
		if err := e.value("g", x.sig); err != nil {
			return err
		}
		return e.value(x.sig, x.val)
	case "ay":
		x, ok := v.([]byte)
		if !ok {
			return bad
		}
		e.u32(uint32(len(x)))
		e.b = append(e.b, x...)
	case "ao":
		x, ok := v.([]objPath)
		if !ok {
			return bad
		}
		e.u32(0)
		at := len(e.b) - 4
		start := len(e.b)
		for _, p := range x {
			e.str(string(p))
		}
		binary.LittleEndian.PutUint32(e.b[at:], uint32(len(e.b)-start))
	case "a{sv}":
		x, ok := v.(dbusProps)
		if !ok {
			return bad
		}
		e.u32(0)
		at := len(e.b) - 4
		e.pad(8) // the first entry's alignment is not part of the length
		start := len(e.b)
		for _, p := range x {
			e.pad(8)
			e.str(p.key)
			if err := e.value("v", p.val); err != nil {
				return err
			}
		}
		binary.LittleEndian.PutUint32(e.b[at:], uint32(len(e.b)-start))
	default:
		return bad
	}
	return nil
}

// sigNext is the length of the first complete type in sig.
func sigNext(sig string) int {
	switch sig[0] {
	case 'a':
		if len(sig) < 2 {
			return 1
		}
		return 1 + sigNext(sig[1:])
	case '(', '{':
		depth := 0
		for i := 0; i < len(sig); i++ {
			switch sig[i] {
			case '(', '{':
				depth++
			case ')', '}':
				if depth--; depth == 0 {
					return i + 1
				}
			}
		}
		return len(sig)
	}
	return 1
}

// dbusDec reads values of one message; offsets count from the message's
// start, so alignment matches.
type dbusDec struct {
	b     []byte
	i     int
	o     binary.ByteOrder
	depth int
}

var errDBusShort = errors.New("D-Bus: bad message")

func (d *dbusDec) align(n int) error {
	d.i = (d.i + n - 1) &^ (n - 1)
	if d.i > len(d.b) {
		return errDBusShort
	}
	return nil
}

func (d *dbusDec) take(n int) ([]byte, error) {
	if n < 0 || d.i+n > len(d.b) {
		return nil, errDBusShort
	}
	v := d.b[d.i : d.i+n]
	d.i += n
	return v, nil
}

func (d *dbusDec) fixed(n int) ([]byte, error) {
	if err := d.align(n); err != nil {
		return nil, err
	}
	return d.take(n)
}

func (d *dbusDec) value(sig string) (any, error) {
	if sig == "" {
		return nil, errDBusShort
	}
	switch sig[0] {
	case 'y':
		b, err := d.take(1)
		if err != nil {
			return nil, err
		}
		return b[0], nil
	case 'b', 'u', 'i', 'h':
		b, err := d.fixed(4)
		if err != nil {
			return nil, err
		}
		v := d.o.Uint32(b)
		switch sig[0] {
		case 'b':
			return v != 0, nil
		case 'i':
			return int32(v), nil
		}
		return v, nil
	case 'n', 'q':
		b, err := d.fixed(2)
		if err != nil {
			return nil, err
		}
		if sig[0] == 'n' {
			return int16(d.o.Uint16(b)), nil
		}
		return d.o.Uint16(b), nil
	case 'x', 't', 'd':
		b, err := d.fixed(8)
		if err != nil {
			return nil, err
		}
		v := d.o.Uint64(b)
		switch sig[0] {
		case 'x':
			return int64(v), nil
		case 'd':
			return math.Float64frombits(v), nil
		}
		return v, nil
	case 's', 'o':
		s, i, err := dbusReadString(d.b, d.i, d.o)
		if err != nil {
			return nil, err
		}
		d.i = i
		if sig[0] == 'o' {
			return objPath(s), nil
		}
		return s, nil
	case 'g':
		b, err := d.take(1)
		if err != nil {
			return nil, err
		}
		s, err := d.take(int(b[0]) + 1)
		if err != nil {
			return nil, err
		}
		return string(s[:len(s)-1]), nil
	case 'v':
		if d.depth > 32 {
			return nil, errDBusShort
		}
		s, err := d.value("g")
		if err != nil {
			return nil, err
		}
		sig := s.(string)
		if sig == "" || sigNext(sig) != len(sig) {
			return nil, errDBusShort
		}
		d.depth++
		v, err := d.value(sig)
		d.depth--
		return dbusVariant{sig: sig, val: v}, err
	case '(':
		if err := d.align(8); err != nil {
			return nil, err
		}
		var out []any
		for inner := sig[1 : len(sig)-1]; inner != ""; {
			n := sigNext(inner)
			v, err := d.value(inner[:n])
			if err != nil {
				return nil, err
			}
			out = append(out, v)
			inner = inner[n:]
		}
		return out, nil
	case 'a':
		b, err := d.fixed(4)
		if err != nil {
			return nil, err
		}
		n := int(d.o.Uint32(b))
		el := sig[1:]
		if strings.IndexByte("{(xtd", el[0]) >= 0 {
			if err := d.align(8); err != nil {
				return nil, err
			}
		} else if strings.IndexByte("nq", el[0]) >= 0 {
			if err := d.align(2); err != nil {
				return nil, err
			}
		} else if el[0] != 'y' && el[0] != 'g' && el[0] != 'v' {
			if err := d.align(4); err != nil {
				return nil, err
			}
		}
		end := d.i + n
		if n < 0 || end > len(d.b) {
			return nil, errDBusShort
		}
		if el == "y" {
			v, _ := d.take(n)
			return append([]byte(nil), v...), nil
		}
		if el[0] == '{' {
			m := map[string]any{}
			for d.i < end {
				if err := d.align(8); err != nil {
					return nil, err
				}
				k, err := d.value(el[1:2])
				if err != nil {
					return nil, err
				}
				v, err := d.value(el[2 : len(el)-1])
				if err != nil {
					return nil, err
				}
				m[fmt.Sprint(k)] = v
			}
			return m, nil
		}
		out := []any{}
		for d.i < end {
			v, err := d.value(el)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	}
	return nil, fmt.Errorf("D-Bus: type %q", sig[0])
}

type dbusMsg struct {
	typ     byte
	flags   byte
	serial  uint32
	replyTo uint32
	path    objPath
	iface   string
	member  string
	errName string
	body    []any
}

// dbusRead reads one message: its type and serial, the serial it replies
// to, its path, interface and member, an error's name and the body's
// values.
func dbusRead(r io.Reader) (dbusMsg, error) {
	h := make([]byte, 16)
	if _, err := io.ReadFull(r, h); err != nil {
		return dbusMsg{}, err
	}
	var o binary.ByteOrder = binary.LittleEndian
	switch h[0] {
	case 'l':
	case 'B':
		o = binary.BigEndian
	default:
		return dbusMsg{}, errors.New("D-Bus: bad message")
	}
	bodyLen, fieldsLen := o.Uint32(h[4:]), o.Uint32(h[12:])
	if bodyLen > 1<<24 || fieldsLen > 1<<16 {
		return dbusMsg{}, errors.New("D-Bus: message too long")
	}
	fieldsEnd := 16 + int(fieldsLen)
	bodyAt := (fieldsEnd + 7) &^ 7
	m := make([]byte, bodyAt+int(bodyLen))
	copy(m, h)
	if _, err := io.ReadFull(r, m[16:]); err != nil {
		return dbusMsg{}, err
	}
	msg := dbusMsg{typ: h[1], flags: h[2], serial: o.Uint32(h[8:])}
	var sig string
	d := &dbusDec{b: m[:fieldsEnd], i: 16, o: o}
	for d.i < fieldsEnd {
		if err := d.align(8); err != nil || d.i >= fieldsEnd {
			break
		}
		code, err := d.take(1)
		if err != nil {
			return msg, err
		}
		v, err := d.value("v")
		if err != nil {
			return msg, errors.New("D-Bus: bad header field")
		}
		switch x := v.(dbusVariant).val.(type) {
		case objPath:
			msg.path = x
		case string:
			switch code[0] {
			case dbusFieldErrorName:
				msg.errName = x
			case dbusFieldSignature:
				sig = x
			case dbusFieldInterface:
				msg.iface = x
			case dbusFieldMember:
				msg.member = x
			}
		case uint32:
			if code[0] == dbusFieldReplySerial {
				msg.replyTo = x
			}
		}
	}
	d = &dbusDec{b: m, i: bodyAt, o: o}
	for rest := sig; rest != ""; {
		n := sigNext(rest)
		v, err := d.value(rest[:n])
		if err != nil {
			return msg, err
		}
		msg.body = append(msg.body, v)
		rest = rest[n:]
	}
	return msg, nil
}

func dbusReadString(b []byte, i int, o binary.ByteOrder) (string, int, error) {
	i = (i + 3) &^ 3
	if i+4 > len(b) {
		return "", 0, errors.New("D-Bus: bad string")
	}
	n := int(o.Uint32(b[i:]))
	i += 4
	if n < 0 || i+n+1 > len(b) || b[i+n] != 0 {
		return "", 0, errors.New("D-Bus: bad string")
	}
	return string(b[i : i+n]), i + n + 1, nil
}
