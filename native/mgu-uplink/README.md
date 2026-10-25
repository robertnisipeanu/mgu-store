# mgu-uplink

Internet for chosen apps through a USB network adapter, an LTE stick or a
USB-tethered phone, and for nothing else on the head unit.

The service brings up the device's interface as `vethuplink` (a name on
connman's interface blacklist, so connman leaves it alone), gets an address
from the device by DHCP (the unit's busybox `udhcpc`), and routes only the
configured uids through it:

| What | Where |
|---|---|
| Address | on `vethuplink`, without a prefix route in the main table |
| Routes | table 110: the lease's subnet and a default via its router; `unreachable default` while offline |
| Rules | pref 1100 `uidrange U lookup main suppress_prefixlength 0` (car networks), 1101 `uidrange U lookup 110`, 1102 `from <lease address> lookup 110` |
| Firewall | `table inet mgu_uplink`: only the allowed uids leave through `vethuplink`, nothing connects in, nothing is forwarded; plus one `oifname "vethuplink" accept comment "mgu-uplink"` at the top of the unit's `ip filter output` chain |
| Lease for apps | `/var/opt/public/oap/oap_<uid>/data/uplink.json` per allowed app, `/run/mgu-uplink/lease.json` for everyone: `{interface, ip, prefix, router, dns[], leaseSeconds, updated}`, present only while online |
| Device state | `/run/mgu-uplink/status.json`, below |

The unit's default route, main table and resolver are not touched. The unit's
resolver does not reach the internet: allowed processes resolve names through
the lease's `dns` servers. While the uplink is down they get `EHOSTUNREACH`.

A stop (SIGTERM) removes everything above, gives a kernel adapter its own
name back and leaves the unit as before the start. A start first removes whatever
a killed run left, so stop, start and restart can be repeated freely.
`mgu-uplink clean` does the same removal by hand while the service is stopped;
`mgu-uplink status` shows what is in place.

## Uplinks

`uplink = auto` (the default) takes the first usable device, in this order,
and checks again every 2 s:

| Kind | Devices | How |
|---|---|---|
| `usb` | a USB Ethernet adapter the kernel drives (`asix`, `ax88179_178a`, `smsc95xx` on the unit), for example an AX88179 cabled to an LTE router | the kernel's interface, renamed to `vethuplink` and given its name back on stop |
| `usbecm` | a CDC-ECM stick: a Huawei HiLink stick (E3372h, `12d1:14db`/`14dc`), any ECM device in `auto` | usbfs; a stick still presenting its install CD-ROM (`12d1:1f01`) is switched into network mode with the usb_modeswitch Huawei message |
| `rndis` | an Android phone in USB tethering: most phones (AOSP's default); control interface `e0/01/03`, `02/02/ff` or `ef/04/01` | usbfs, RNDIS (rndis.go) |
| `ncm` | an Android phone in USB tethering presenting CDC-NCM: Pixel 6 and later | usbfs, NCM transfer blocks (ncm.go) |
| `iphone` | an iPhone with Personal Hotspot on | usbfs: configuration 4, trust over usbmux and lockdown, the hotspot interface as Linux's `ipheth` drives it (iphone.go, lockdown.go) |
| `netdev:<ifname>` | an existing interface, used under its own name (the emulator's second NIC) | — |

A wired adapter or stick is preferred over a phone: while `auto` runs on a
phone, a stick plugged in takes over within 5 s, and the phone comes back
when the stick is unplugged. An unplugged device ends its link, the
service waits for the next one, and devices can be swapped while it runs.
`auto` only takes a device that no kernel driver or other process holds;
naming the kind (`uplink = rndis`, ...) also lifts a kernel driver off the
function it takes and gives it back on stop. An Apple device is never
taken from a driver or process: it is reported `busy` and left alone.

The usbfs kinds share one relay: the device's bulk endpoints feed one end
of a veth pair, `vethuplinkp`; the other end is `vethuplink` with the MAC
the device assigns to the host and its checksum and segmentation offloads
off, so every frame reaches the device complete. Nothing loads or changes
kernel code (the unit's kernel has none of `cdc_ether`, `cdc_ncm`,
`rndis_host`, `ipheth`). This is the mechanism of mgu-tether
(`luigiwidmore/bmw_project` `tools/tether`), whose RNDIS driver this one
follows and extends: the RNDIS control classes beyond `e0/01/03`, the data
interface from the CDC Union, a pad byte after a message that fills whole
USB packets, the device's maximum transfer size, its KEEPALIVE and status
messages, and HALT on stop.

All of them run the same DHCP, routing, firewall and lease files.

### Phones

Android: plug the phone in and turn on Settings → Network → Hotspot &
tethering → USB tethering (most phones turn it off again when unplugged).

iPhone: turn on Settings → Personal Hotspot and plug the phone in. The
first time, the phone asks "Trust This Computer?": tap Trust and enter the
passcode (an unlocked phone is needed). Until then `status.json` says
`trust-needed` with `"Tap Trust on the iPhone"` (`"Unlock the iPhone"` while
it is locked), and the service asks again every 2 s. An iPhone drops every
packet from a host it has not paired with, so the unit pairs the way
usbmuxd does: a certificate chain made on the unit, the phone's Pair
answer kept in `/var/opt/mgu-uplink/pair/<UDID>.json` (root, 0600), and a
lockdown session with TLS on every plug-in. A trusted phone needs no tap
again until it is told to forget the unit (Settings → General → Transfer
or Reset → Reset Location & Privacy), after which it asks again. A
declined prompt is not repeated until the phone is plugged in again.
iOS's USB Restricted Mode cuts USB data after an hour locked unless
Settings → Face ID & Passcode → Accessories is on.

### status.json

`/run/mgu-uplink/status.json` (0644, present while the service runs), for
the Store and the phone page:

```json
{ "device": { "kind": "iphone", "name": "Apple Inc. iPhone" },
  "state": "trust-needed", "error": "Tap Trust on the iPhone" }
```

| `state` | |
|---|---|
| `searching` | no usable device (`device` null) |
| `connecting` | the device is being set up, or waits for its DHCP lease; `error` may say why (`"Personal Hotspot is off"`) |
| `trust-needed` | an iPhone shows its Trust prompt; `error` says what to do |
| `busy` | another driver or process holds the device; it is left alone |
| `online` | there is a lease |
| `error` | setting the device up failed (`error`); it is tried again after 15 s |

`kind` is one of `usb`, `usbecm`, `rndis`, `ncm`, `iphone`, `netdev`; `name`
is the device's manufacturer and product strings.

## Config

The shipped [`mgu-uplink.conf`](mgu-uplink.conf) holds the defaults and is
replaced by every update. The unit's own settings go in
`/var/opt/mgu-uplink/mgu-uplink.local.conf` (same keys; each one given there
replaces the shipped value, except `uids`, which adds to it), which updates keep:

| Key | Value |
|---|---|
| `apps` | OAP app names, resolved through `oap_12201/security/uids.txt` every 5 s |
| `uids` | numeric uids of non-app processes; the shipped `uids = 12990` is the updater's fetcher. A local `uids` adds to it, so the unit always keeps it; 0 is refused |
| `uplink` | `auto`, `usb`, `usbecm`, `rndis`, `ncm`, `iphone` or `netdev:<ifname>` |
| `usb_device` | `VID:PID` of the one USB device to use (with `usbecm`: of the stick in network mode) |
| `table`, `rule_pref` | routing table (110) and first rule priority (1100) |

Components that need the internet add themselves without touching the
conf: the deploy tool writes `/var/opt/mgu-uplink/uids.d/<component>`
(numeric uids) or `apps.d/<component>` (app names; an empty file stands
for the app named like the file), one per line, on install and removes it
on uninstall. They are read with the 5 s rescan, so an install or removal
takes effect within seconds; entries that are not a uid or an app name are
logged and skipped.

`uplink`, `table` and the other keys take effect at the next service
restart.

## Build, install, update

```sh
make -C native/mgu-uplink target    # build/target/mgu-uplink, static linux/amd64
make -C native/mgu-uplink test      # Linux; on a Mac: test-docker
deploy/hu install mgu-uplink        # build and install over SSH (deploy/README.md)
```

The unit tests cover the framing (RNDIS, NCM blocks with several datagrams
and chained NDPs, ipheth legacy and NCM receive), the descriptor matching,
plists, usbmux, and the whole pairing flow against a fake phone
(fakephone_test.go) with real TLS. [`test/vm-gadget.sh`](test/vm-gadget.sh)
runs the uplinks against USB gadgets in a Linux VM: ECM, NCM and RNDIS
(f_rndis, and as `e0/01/03` through a descriptor-rewriting usbip proxy)
gadgets with a DHCP server and NAT behind them, and a FunctionFS fake
iPhone (gadget_test.go: Apple ids, four configurations, usbmux, lockdown
with the Trust prompt and TLS, the hotspot interface in NCM or legacy
framing) on dummy_hcd. What only a real iPhone can show: that iOS accepts
this pairing and session as it accepts usbmuxd's, the hotspot's framing on
current iOS, and whether the phone needs the zero-length packet after a
frame of a whole number of USB packets that the unit sends.

mgu-uplink is a tool component ([`component.json`](component.json)): the
deploy tool installs it, from the Mac, from the offline kit, or from the
updater (the Store's "Internet uplink" row). The version is
`component.json`'s; `mgu-uplink --version` prints it.

| Path | What |
|---|---|
| `/var/opt/mgu-uplink/versions/<version>/` | `mgu-uplink`, `mgu-uplink.conf`, `component.json` |
| `/var/opt/mgu-uplink/current` | the version in use |
| `/var/opt/mgu-uplink/mgu-uplink.local.conf` | the unit's settings |
| `/var/opt/mgu-uplink/uids.d/`, `apps.d/` | per-component drop-ins (the deploy tool's) |
| `/var/opt/mgu-uplink/pair/` | iPhone pair records (root, 0700) |
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
`mgu-uplink status` prints the device state, the lease, the rules, table
110, the firewall and the route to 1.1.1.1 for root and for each allowed
uid.

```sh
systemctl status mgu-uplink; journalctl -u mgu-uplink -b
/var/opt/mgu-uplink/mgu-uplink status
cat /run/mgu-uplink/status.json
nft list table inet mgu_uplink; nft -a list chain ip filter output | grep mgu-uplink
ip route | grep vethuplink    # main table: nothing
```
