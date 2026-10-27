package main

// status.json: what the uplink is doing, for the Store and the phone page
// (/run/mgu-uplink/status.json, 0644, present while the service runs):
//
//	{"device": {"kind": "iphone", "name": "Apple Inc. iPhone"} | null,
//	 "state": "searching|connecting|trust-needed|busy|online|error",
//	 "error": null | "Tap Trust on the iPhone" | ...}
//
// searching: no usable device. connecting: a device is being set up or
// waits for its DHCP lease. trust-needed: an iPhone is up but sends nothing,
// so its owner still has to tap Trust (error says what to do). busy: the
// device is held by another driver or process and is left alone. online:
// there is a lease. error: setting the device up failed; it is retried.

import (
	"bytes"
	"os"
	"sync"
)

const (
	stateSearching   = "searching"
	stateConnecting  = "connecting"
	stateTrustNeeded = "trust-needed"
	stateBusy        = "busy"
	stateOnline      = "online"
	stateError       = "error"
)

type statusDevice struct {
	Kind string `json:"kind"` // usb, usbecm, rndis, ncm, iphone, netdev
	Name string `json:"name"`
}

type uplinkStatus struct {
	Device *statusDevice `json:"device"`
	State  string        `json:"state"`
	Error  *string       `json:"error"`
}

// deviceLink is a Link that knows which device it runs on.
type deviceLink interface {
	device() statusDevice
}

var ustat struct {
	sync.Mutex
	path     string
	last     []byte
	note     string // a running link's own remark, e.g. the iPhone's hotspot being off
	trust    bool   // a running iPhone link is waiting for Trust
	trustMsg string
}

// statusInit makes setStatus write to path ("" writes nothing).
func statusInit(path string) {
	ustat.Lock()
	ustat.path, ustat.last, ustat.note, ustat.trust, ustat.trustMsg = path, nil, "", false, ""
	ustat.Unlock()
}

// setStatus writes status.json when it changes. While connecting, a
// link's note stands in for an empty msg.
func setStatus(dev *statusDevice, state, msg string) {
	ustat.Lock()
	defer ustat.Unlock()
	if ustat.path == "" {
		return
	}
	if msg == "" && state == stateConnecting {
		msg = ustat.note
	}
	st := uplinkStatus{Device: dev, State: state}
	if msg != "" {
		st.Error = &msg
	}
	b := marshalJSON(st)
	if bytes.Equal(b, ustat.last) {
		return
	}
	if err := writeJSON(ustat.path, st, 0644); err != nil {
		logf("%s: %v", ustat.path, err)
		return
	}
	ustat.last = b
}

// setLinkNote records a running link's remark ("" clears it).
func setLinkNote(note string) {
	ustat.Lock()
	ustat.note = note
	ustat.Unlock()
}

// setLinkTrust records that a running iPhone link is waiting for Trust.
// publishStatus shows it as trust-needed while there is no lease.
func setLinkTrust(on bool, msg string) {
	ustat.Lock()
	ustat.trust, ustat.trustMsg = on, msg
	ustat.Unlock()
}

// linkTrust reports the current waiting-for-Trust note.
func linkTrust() (bool, string) {
	ustat.Lock()
	defer ustat.Unlock()
	return ustat.trust, ustat.trustMsg
}

func statusClear(path string) {
	statusInit("")
	os.Remove(path)
}
