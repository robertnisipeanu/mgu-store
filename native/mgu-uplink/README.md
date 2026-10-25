# mgu-uplink

Internet for chosen apps through a USB network adapter, and for nothing else
on the head unit.

The service brings up the adapter's interface as `vethuplink` (a name on
connman's interface blacklist, so connman leaves it alone), gets an address
from the adapter by DHCP (the unit's busybox `udhcpc`), and routes only the
configured uids through it:

| What | Where |
|---|---|
| Address | on `vethuplink`, without a prefix route in the main table |
| Routes | table 110: the lease's subnet and a default via its router; `unreachable default` while offline |
| Rules | pref 1100 `uidrange U lookup main suppress_prefixlength 0` (car networks), 1101 `uidrange U lookup 110`, 1102 `from <lease address> lookup 110` |
| Firewall | `table inet mgu_uplink`: only the allowed uids leave through `vethuplink`, nothing connects in, nothing is forwarded; plus one `oifname "vethuplink" accept comment "mgu-uplink"` at the top of the unit's `ip filter output` chain |
| Lease for apps | `/var/opt/public/oap/oap_<uid>/data/uplink.json` per allowed app, `/run/mgu-uplink/lease.json` for everyone: `{interface, ip, prefix, router, dns[], leaseSeconds, updated}`, present only while online |

The unit's default route, main table and resolver are not touched. The unit's
resolver does not reach the internet: allowed processes resolve names through
the lease's `dns` servers. While the uplink is down they get `EHOSTUNREACH`.

A stop (SIGTERM) removes everything above, gives the adapter its own name
back and leaves the unit as before the start. A start first removes whatever
a killed run left, so stop, start and restart can be repeated freely.
`mgu-uplink clean` does the same removal by hand while the service is stopped;
`mgu-uplink status` shows what is in place.

## Uplinks

- `usb` (the default): the first USB Ethernet adapter, or the one with the
  `usb_device` VID:PID. The unit's kernel has the `asix`, `ax88179_178a` and
  `smsc95xx` USB Ethernet drivers only, so an adapter on one of those works
  (for example an AX88179 adapter cabled to an LTE router). In debug mode the
  firmware's own udev hook (`setup-usb-eth.sh`) also runs `udhcpc` and `zcip`
  on every USB Ethernet interface; in field mode it leaves the adapter alone.
- `usbecm`: a CDC-ECM stick the kernel has no driver for (a Huawei HiLink
  stick such as the E3372h, `12d1:14db`/`12d1:14dc`, or the one `usb_device`
  names), driven from user space over usbfs. A stick still presenting its
  install CD-ROM (`12d1:1f01`) is switched into network mode with the
  standard usb_modeswitch Huawei message. The stick's bulk endpoints feed
  one end of a veth pair, `vethuplinkp`; the other end is `vethuplink` with
  the stick's own MAC and its checksum and segmentation offloads off, so
  every frame reaches the stick complete. This is the mechanism of
  mgu-tether (`luigiwidmore/bmw_project` `tools/tether`, RNDIS phones) with
  CDC-ECM framing. Sticks speaking CDC-NCM or RNDIS are not covered by this
  uplink. On the unit, select it with `uplink = usbecm` in the local conf.
- `netdev:<ifname>`: an existing interface, used under its own name. The
  emulator sets `uplink = netdev:vethuplink`, or `usbecm` with a real stick
  passed through.

All three run the same DHCP, routing, firewall and lease files.

## Config

The shipped [`mgu-uplink.conf`](mgu-uplink.conf) holds the defaults and is
replaced by every update. The unit's own settings go in
`/var/opt/mgu-uplink/mgu-uplink.local.conf` (same keys; each one given there
replaces the shipped value, except `uids`, which adds to it), which updates keep:

| Key | Value |
|---|---|
| `apps` | OAP app names, resolved through `oap_12201/security/uids.txt` every 5 s |
| `uids` | numeric uids of non-app processes; the shipped `uids = 12990, 12993` is the updater's fetcher and mgu-tailscale (the one Tailscale node, through which raluca-car and waze-diag reach the tailnet). A local `uids` adds to these, so the unit always keeps both; 0 is refused |
| `uplink` | `usb`, `usbecm` or `netdev:<ifname>` |
| `usb_device` | `VID:PID` of the one USB adapter to use (with `usbecm`: of the stick in network mode) |
| `table`, `rule_pref` | routing table (110) and first rule priority (1100) |

A change takes effect at the next service restart.

## Build, install, update

```sh
make -C native/mgu-uplink target    # build/target/mgu-uplink, static linux/amd64
make -C native/mgu-uplink test      # Linux; on a Mac: test-docker
deploy/hu install mgu-uplink        # build and install over SSH (deploy/README.md)
```

mgu-uplink is a tool component ([`component.json`](component.json)): the
deploy tool installs it, from the Mac, from the offline kit, or from the
updater (the Store's "Internet uplink" row). The version is
`component.json`'s; `mgu-uplink --version` prints it.

| Path | What |
|---|---|
| `/var/opt/mgu-uplink/versions/<version>/` | `mgu-uplink`, `mgu-uplink.conf`, `component.json` |
| `/var/opt/mgu-uplink/current` | the version in use |
| `/var/opt/mgu-uplink/mgu-uplink.local.conf` | the unit's settings |
| `/etc/systemd/system/mgu-uplink.service` | enabled for `multi-user.target` |
| `/etc/recmgr-restartlist.conf` | `mgu-uplink` in `[Whitelist]` and `[WhitelistExitSuccess]` |

Without the recmgr entries the head unit restarts whenever the service stops.
recmgr reads its list at boot, so a first install starts the service at the
next boot, and an update restarts it only once recmgr has loaded the entries;
until then the previous version keeps running. The restart removes what the
old version added and the new one adds it again, so allowed processes are
offline for the few seconds DHCP takes.

## Check it on the unit

The unit's `ip` (busybox) shows neither policy rules nor per-uid routes;
`mgu-uplink status` prints the lease, the rules, table 110, the firewall and
the route to 1.1.1.1 for root and for each allowed uid.

```sh
systemctl status mgu-uplink; journalctl -u mgu-uplink -b
/var/opt/mgu-uplink/mgu-uplink status
nft list table inet mgu_uplink; nft -a list chain ip filter output | grep mgu-uplink
ip route | grep vethuplink    # main table: nothing
```
