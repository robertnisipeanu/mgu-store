package main

// Kernel-driven USB network adapters: an adapter the kernel has a driver
// for appears as an Ethernet interface under its driver's name (eth1, ...).
// The uplink renames it to Ifname, so the rules, firewall and files apps
// read name the same interface on every unit and in the emulator, and
// gives the name back when it lets go.
//
// The unit's kernel has the asix, ax88179_178a and smsc95xx USB Ethernet
// drivers only. An adapter needing cdc_ether, cdc_ncm or rndis_host (LTE
// sticks, Android phones) gets no interface there; the usbfs uplinks drive
// those (cdc.go).

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// usbNetDrivers are the USB Ethernet drivers an adapter is taken from when
// usb_device does not name it.
var usbNetDrivers = map[string]bool{
	"asix": true, "ax88179_178a": true, "smsc95xx": true, "smsc75xx": true, "r8152": true,
	"cdc_ether": true, "cdc_ncm": true, "cdc_eem": true, "cdc_subset": true, "rndis_host": true,
}

const sysClassNet = "/sys/class/net"

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

// netdevDevice names the USB device behind interface ifname for status.json.
func netdevDevice(sys, ifname string) statusDevice {
	intf, _ := filepath.EvalSymlinks(filepath.Join(sys, ifname, "device"))
	dev := filepath.Dir(intf)
	name := strings.TrimSpace(sysValue(readSysctl(filepath.Join(dev, "manufacturer"))) + " " +
		sysValue(readSysctl(filepath.Join(dev, "product"))))
	if name == "" {
		name = ifname
	}
	return statusDevice{Kind: "usb", Name: name}
}
