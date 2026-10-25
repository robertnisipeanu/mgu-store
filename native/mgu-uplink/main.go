// mgu-uplink: internet for chosen apps through a USB network adapter, and for
// nothing else on the unit.
//
// The service brings up the adapter's interface, gets an address from the
// adapter by DHCP and routes only the configured uids through it, in a routing
// table and firewall table of its own; the unit's own routes, default route
// and resolver stay as they are. A stop removes everything it added. See
// uplink.go for the uplink seam, netcfg.go for the routing, firewall.go for
// the firewall and state.go for the files apps read.
//
//	mgu-uplink run [-c <config>] [-uplink usb|usbecm|netdev:<ifname>]   the service
//	mgu-uplink status [-c <config>]  lease, rules, uplink table, firewall, routes per uid
//	mgu-uplink clean [-c <config>]   remove what a killed run left behind
//	mgu-uplink --version
//	mgu-uplink bound|renew|deconfig|leasefail|nak   udhcpc's hook, run by the service
package main

import (
	"flag"
	"fmt"
	"os"
)

// version is set at build time from component.json.
var version = "dev"

func logf(format string, a ...interface{}) {
	fmt.Fprintf(os.Stdout, format+"\n", a...)
}

const usage = `usage:
  mgu-uplink run [-c <config>] [-uplink usb|usbecm|netdev:<ifname>]
  mgu-uplink status [-c <config>]
  mgu-uplink clean [-c <config>]
  mgu-uplink --version`

func main() {
	args := os.Args[1:]
	if len(args) == 1 && isHookEvent(args[0]) && os.Getenv(hookEnv) != "" {
		os.Exit(runHook(args[0]))
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	switch args[0] {
	case "--version", "-version", "version":
		fmt.Println(version)
	case "run", "status", "clean":
		os.Exit(command(args[0], args[1:]))
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
}

func command(name string, args []string) int {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	path := fs.String("c", defaultConfig, "config file")
	spec := ""
	if name == "run" {
		fs.StringVar(&spec, "uplink", "", "usb, usbecm or netdev:<ifname>, in place of the config's uplink")
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "%s: unexpected argument %q\n%s\n", name, fs.Arg(0), usage)
		return 2
	}
	c, err := loadConfig(*path)
	if err == nil && spec != "" {
		c.Uplink = spec
		err = c.validate()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "mgu-uplink: %v\n", err)
		return 1
	}
	if name == "status" {
		status(c)
		return 0
	}
	if name == "clean" {
		lk, err := lock(c)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mgu-uplink: %v\n", err)
			return 1
		}
		cleanup(c)
		lk.Close()
		return 0
	}
	up, _ := parseUplink(c)
	if err := runService(c, up); err != nil {
		logf("mgu-uplink: %v", err)
		return 1
	}
	return 0
}
