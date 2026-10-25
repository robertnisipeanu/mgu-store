package main

// usbUplink is a USB network adapter the unit's kernel drives: it appears as
// an Ethernet interface under its driver's name (eth1, ...). Open renames it
// to Ifname, so the rules, firewall and files apps read name the same
// interface on every unit and in the emulator, and Close gives the name back.
//
// The unit's kernel has the asix, ax88179_178a and smsc95xx USB Ethernet
// drivers only. An adapter needing cdc_ether, cdc_ncm or rndis_host (most LTE
// sticks in their default mode) gets no interface there; it is found on
// kernels that have those drivers.

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/vishvananda/netlink"
)

// usbNetDrivers are the USB Ethernet drivers an adapter is taken from when
// usb_device does not name it.
var usbNetDrivers = map[string]bool{
	"asix": true, "ax88179_178a": true, "smsc95xx": true, "smsc75xx": true, "r8152": true,
	"cdc_ether": true, "cdc_ncm": true, "cdc_eem": true, "cdc_subset": true, "rndis_host": true,
}

const sysClassNet = "/sys/class/net"

type usbUplink struct {
	device string // VID:PID, or "" for any adapter on a usbNetDrivers driver
	record string
}

func (u *usbUplink) String() string {
	if u.device != "" {
		return "usb:" + u.device
	}
	return "usb"
}

func (u *usbUplink) Open(ctx context.Context) (Link, error) {
	waiting := false
	for {
		if names := usbNetdevs(sysClassNet, u.device); len(names) > 0 {
			if link, err := netlink.LinkByName(names[0]); err == nil {
				return openLink(link, Ifname, u.record)
			}
		}
		if !waiting {
			logf("waiting for a USB network adapter (%s)", u)
			waiting = true
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// usbNetdevs lists the Ethernet interfaces under sys (/sys/class/net) that
// belong to a USB adapter: the one with VID:PID device, or with device "" any
// on a usbNetDrivers driver. Wireless interfaces never qualify. Ifname, left
// by a killed run, sorts first.
func usbNetdevs(sys, device string) []string {
	entries, _ := os.ReadDir(sys)
	var out []string
	for _, e := range entries {
		dir := filepath.Join(sys, e.Name())
		if t, _ := readSysctl(filepath.Join(dir, "type")); t != "1" { // ARPHRD_ETHER
			continue
		}
		if exists(filepath.Join(dir, "wireless")) || exists(filepath.Join(dir, "phy80211")) {
			continue
		}
		// device is the USB interface; its parent is the USB device.
		intf, err := filepath.EvalSymlinks(filepath.Join(dir, "device"))
		if err != nil {
			continue
		}
		subsys, _ := filepath.EvalSymlinks(filepath.Join(intf, "subsystem"))
		if filepath.Base(subsys) != "usb" {
			continue
		}
		vid, _ := readSysctl(filepath.Join(intf, "..", "idVendor"))
		pid, _ := readSysctl(filepath.Join(intf, "..", "idProduct"))
		drv, _ := filepath.EvalSymlinks(filepath.Join(intf, "driver"))
		if device != "" && strings.ToLower(vid+":"+pid) == device ||
			device == "" && usbNetDrivers[filepath.Base(drv)] {
			out = append(out, e.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i] == Ifname) != (out[j] == Ifname) {
			return out[i] == Ifname
		}
		return out[i] < out[j]
	})
	return out
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
