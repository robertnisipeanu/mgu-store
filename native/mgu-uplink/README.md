# mgu-uplink

Internet for chosen apps through a USB network adapter, an LTE stick, a
USB-tethered phone or Wi-Fi, and for nothing else on the head unit.

The service brings up the device's interface as `vethuplink` (Wi-Fi keeps
`wlan1`, below), gets an address from the device by DHCP, and routes only
the configured uids through it:

| What | Where |
|---|---|
| Address | on `vethuplink`, without a prefix route in the main table |
| Routes | table 110: the lease's subnet and a default via its router; `unreachable default` while offline |
| Rules | pref 1100 `uidrange U lookup main suppress_prefixlength 0` (car networks), 1101 `uidrange U lookup 110`, 1102 `from <lease address> lookup 110` |
| Firewall | `table inet mgu_uplink`: only the allowed uids leave through `vethuplink` (and the Wi-Fi interface while Wi-Fi is on), nothing connects in, nothing is forwarded; plus one `oifname "<interface>" accept comment "mgu-uplink"` per interface at the top of the unit's `ip filter output` chain |
| Lease for apps | `/var/opt/public/oap/oap_<uid>/data/uplink.json` per allowed app, `/run/mgu-uplink/lease.json` for everyone: `{interface, ip, prefix, router, dns[], leaseSeconds, updated}`, present only while online |
| Device state | `/run/mgu-uplink/status.json`, below |

The unit's default route, main table and resolver are not touched. The unit's
resolver does not reach the internet: allowed processes resolve names through
the lease's `dns` servers. While the uplink is down they get `EHOSTUNREACH`.

A stop removes everything above and leaves the unit as before the start.
`mgu-uplink clean` does the same removal by hand while the service is stopped;
`mgu-uplink status` shows what is in place.

## Uplinks

The service takes the first usable device, in this order, and checks again
every 2 s:

| Kind | Devices | How |
|---|---|---|
| `wifi` | a saved Wi-Fi network in range (a phone's hotspot, an access point), while Wi-Fi is on | the unit's radio, `wlan1`, or without `wlan1` the car's `wlan0` (below) |
| `usb` | a USB Ethernet adapter the kernel drives (`asix`, `ax88179_178a`, `smsc95xx` on the unit), for example an AX88179 cabled to an LTE router | the kernel's interface |
| `usbecm` | a CDC-ECM stick: a Huawei HiLink stick (E3372h, `12d1:14db`/`14dc`) or any other ECM device | usbfs; a stick still presenting its install CD-ROM (`12d1:1f01`) is switched into network mode |
| `rndis` | an Android phone in USB tethering: most phones | usbfs, RNDIS |
| `ncm` | an Android phone in USB tethering presenting CDC-NCM: Pixel 6 and later | usbfs, NCM |
| `iphone` | an iPhone with Personal Hotspot on | usbfs: taken from the car's media daemon and paired (below) |

`uplink = netdev:<ifname>` in the config uses that existing interface
instead, under its own name.

A device earlier in the order is preferred: while the uplink runs on a
phone, a stick plugged in (or Wi-Fi joining) takes over within 5 s, and the
phone comes back when the stick is unplugged. One group can be tried
first (`preferred`, set by the Store through the `prefer` request): `wifi`,
`usb` (`usb` and `usbecm`) or `phone` (`rndis`, `ncm`, `iphone`); the
other groups follow as fallbacks, each kind in the order above. An unplugged
device ends its link, the service waits for the next one, and devices can
be swapped while it runs. A USB device that a kernel driver or another
process holds is left alone, except an iPhone, which the uplink takes from
the media daemon: so an iPhone is taken only while nothing ranked higher,
Wi-Fi to its hotspot included, is there.

### Phones

Android: plug the phone in and turn on Settings → Network → Hotspot &
tethering → USB tethering (most phones turn it off again when unplugged).

iPhone: turn on Settings → Personal Hotspot, plug the phone in and unlock
it. The first time, the phone asks "Trust This Computer?": tap Trust and
enter the passcode. Until then `status.json` says `trust-needed` with
`"Tap Trust on the iPhone and enter its passcode"` (or `"Unlock the
iPhone"`). After that the phone is paired with the unit and does not ask
again.

A phone that has forgotten the unit (Settings → General → Transfer or
Reset iPhone → Reset Location & Privacy) is paired again. The unit's
pairing identity is kept in `/var/opt/mgu-uplink/pairing/host.json` (root
only), which updates keep; deleting it makes the unit a new computer for
every phone. When the owner answers "Don't Trust", the phone goes back to
media and is left alone until it is plugged in again.

While tethering, the iPhone is a network device, so USB media playback from
that phone stops; it resumes when tethering ends. iOS's USB Restricted Mode
cuts USB data after an hour locked unless Settings → Face ID & Passcode →
Accessories is on.

The iPhone takeover follows IterioDev's `ipheth-tether`; the Store does not
install that tether (deploy/README.md, "IterioDev's App Manager").

#### Phones over USB switched off

Taking a phone has a cost: an iPhone taken for its hotspot is no media
device, so USB audio from it stops, and each time it is plugged in while
it does not trust the unit, it asks "Trust This Computer?". It is taken
whether Personal Hotspot is on or not. With phones over USB switched off
(`usb_phone = off`, or the Store through `usb-phone`), the uplink leaves
every phone alone: no Android phone's USB tethering is used, and no iPhone
is taken from the media daemon, switched to configuration 4 or paired, so
the car keeps it for media, iAP2 and wired CarPlay. USB Ethernet
adapters, CDC-ECM sticks and Wi-Fi are used; a stick that presents RNDIS
or NCM counts as a phone and is left alone too. Switched off while the
uplink runs on a phone, that link ends at once as an unplug ends it (an
iPhone goes back to the media daemon) and the uplink goes on with the next
device; switched on again, a phone plugged in is taken at the next scan.

### Wi-Fi

The unit joins a saved Wi-Fi network (a phone's hotspot, an access point)
with its own radio, and the uplink uses it like a plugged-in device. Wi-Fi
is off until switched on (`wifi = on`, or the Store through `wifi-enable`).
Off means only that the uplink does not use Wi-Fi: the radio, and the
car's own Wi-Fi, hotspot and wireless CarPlay, stay as they are.

The radio is `wlan1` on iDrive 7 and iDrive 8, joined by our own
wpa_supplicant (`mgu-wpa`, beside `mgu-uplink`: upstream 2.10 with
[`wpa/wpa-mgu-sme-connect.patch`](wpa/wpa-mgu-sme-connect.patch), which
the unit's driver needs). The uplink takes `wlan1` only while the car does
not use it (as an access point, for P2P, or through its own supplicant or
connman), and gives it back when the car starts using it; Wi-Fi is then
`unavailable`, with the reason. After 5 failures in a row to start, Wi-Fi
is `failed` until it is switched on again or the service restarts.

Saved networks are in `/var/opt/mgu-uplink/wifi/wpa.conf`, in a folder only
root can read; a network is saved once it was joined with the password
given. WPA2 and WPA3 personal (passwords of 8 to 63 printable characters)
and open networks; no enterprise (EAP). A password or a printable-ASCII
network name with a `#` after an odd number of `"` is refused: wpa.conf
can't keep it. A wpa.conf wpa_supplicant can't read is moved to
`wpa.conf.bad`, and Wi-Fi starts without saved networks.

#### Without `wlan1`: the car's `wlan0`

iDrive 7 units with the Broadcom chip (`bcmdhd`) have no `wlan1`. On them
the unit joins on the car's own `wlan0` through the car's wpa_supplicant
(`wifi.backend` `car-supplicant`), while the car's hotspot and wireless
CarPlay keep running. Our networks are added to the car's supplicant only
while Wi-Fi is on and are never written to its configuration. Wi-Fi is
`unavailable` while the car uses `wlan0` itself, or while the car's Wi-Fi
is switched off. WPA2 personal and open networks; WPA3-only networks
can't be joined.

#### The band

Wireless CarPlay and Android Auto use the car's 5 GHz Wi-Fi when they can,
and share the radio with a network the uplink joins on the same band. So
with **Allow 5 GHz** off (`wifi_5ghz = off`, the default; the `wifi-5ghz`
request), a network seen on 2.4 GHz is joined on 2.4 GHz only. A network
seen on 5 GHz only (an iPhone's hotspot with Maximize Compatibility off) is
still joined there (`wifi.fiveOnly`), and one that does not join on
2.4 GHz within 20 s is joined on either band. With Allow 5 GHz on, a
network is joined on either band.

#### During wireless CarPlay and Android Auto

While wireless CarPlay or Android Auto is connected, the car's supplicant
(`wlan0`) scans only off the phone's band. While Wi-Fi is not joined and
that cannot be done (the band is not known, or the supplicant refuses it),
and on `wlan1`, the supplicant's own scans stop (`wifi.paused`: `carplay`,
`android-auto`).
A `wifi-scan` request and a `wifi-connect` still cover every channel, and
a joined network stays joined.

### status.json

`/run/mgu-uplink/status.json` (0644, present while the service runs), for
the Store and the phone page:

```json
{ "device": { "kind": "iphone", "name": "Apple Inc. iPhone" },
  "state": "trust-needed", "error": "Tap Trust on the iPhone and enter its passcode" }
```

with `uplink = auto`, also `wifi`, `usbPhone` (whether phones over USB are
taken), and `preferred` while a group is preferred:

```json
{ "device": { "kind": "wifi", "name": "iPhone - Mario" }, "state": "online", "error": null,
  "preferred": "wifi", "usbPhone": true,
  "wifi": { "enabled": true, "link": "online", "ssid": "iPhone - Mario", "ip": "172.20.10.2", "signal": -45,
    "networks": [ { "ssid": "iPhone - Mario", "signal": -40, "secure": true, "saved": true, "current": true } ],
    "saved": [ "iPhone - Mario" ], "scanning": false, "error": null } }
```

| `wifi.link` | |
|---|---|
| `off` | Wi-Fi is switched off |
| `unavailable` | no Wi-Fi interface, or the car uses it (`error` says which); left alone |
| `failed` | `wlan1` or wpa_supplicant did not start (`error`); tried again later (`error` says when), after 5 failures in a row not until switched on again |
| `idle`, `scanning`, `connecting` | not joined; `ssid` is the network being joined |
| `connected` | joined `ssid`; the uplink uses another device, or waits for DHCP |
| `online` | the uplink has a lease through it (`ip`) |

`networks` is the latest scan (the strongest per name, at most 20,
strongest first), `saved` the saved names, `scanning` true for 8 s after a
scan request or a switch-on, `signal` dBm, `backend` what joins (`mgu-wpa` or
`car-supplicant`) while Wi-Fi is on and there is a radio, `paused`
(`carplay`, `android-auto`) while the supplicant makes no scans of its own
during that wireless session, `freq` the frequency (MHz) of the access
point joined when known, `allow5ghz` the Allow 5 GHz setting and `fiveOnly`
true while joined on 5 GHz, with Allow 5 GHz off, to a network not seen on
2.4 GHz. `error` keeps a failed join ("could not join … (wrong password, or
out of range)") until the next request.

| `state` | |
|---|---|
| `searching` | no usable device (`device` null) |
| `connecting` | the device is being set up, or waits for its DHCP lease; `error` may say why (`"Personal Hotspot is off"`) |
| `trust-needed` | an iPhone waits for its owner to tap Trust and enter the passcode, or to unlock it; `error` says what to do |
| `busy` | another driver or process holds the device, or the owner declined Trust on the iPhone (until it is plugged in again); it is left alone |
| `online` | there is a lease |
| `error` | setting the device up failed (`error`); it is tried again after 15 s |

`kind` is one of `usb`, `usbecm`, `wifi`, `rndis`, `ncm`, `iphone`,
`netdev`; `name` is the device's manufacturer and product strings, for
`wifi` the network's name.

### Requests

`/run/mgu-uplink/ctl.sock` (root only, 0600): one JSON object and a newline
in, one JSON line back, one request per connection. The Store talks to the
updater only, which relays these; `status.json` shows the results.

| Request | |
|---|---|
| `{"op": "prefer", "kind": "phone"}` | the group tried first (`wifi`, `usb`, `phone`; `""` for none); takes effect within 5 s |
| `{"op": "wifi-enable", "on": true}` | Wi-Fi on or off; on also scans at once, as `wifi-scan` does |
| `{"op": "wifi-5ghz", "on": true}` | Allow 5 GHz: joins on either band (The band, above) |
| `{"op": "usb-phone", "on": false}` | phones over USB taken or left alone (Phones over USB switched off, above) |
| `{"op": "wifi-scan"}` | scan now |
| `{"op": "wifi-connect", "ssid": "…", "psk": "…"}` | join a network, with its password; saved once joined. Without `psk`: a saved network, or an open one |
| `{"op": "wifi-forget", "ssid": "…"}` | forget a saved network |

The reply is `{"ok": true}` or `{"ok": false, "error": "…"}`. `prefer`,
`wifi-enable`, `wifi-5ghz` and `usb-phone` are kept in `settings_conf`. A password goes to wpa_supplicant
only: no log line, reply or status names it.

## Config

The shipped [`mgu-uplink.conf`](mgu-uplink.conf) holds the defaults and is
replaced by every update. The unit's own settings go in
`/var/opt/mgu-uplink/mgu-uplink.local.conf` (same keys; each one given there
replaces the shipped value, except `uids`, which adds to it), which updates keep.
What the Store sets through requests goes in
`/var/opt/mgu-uplink/mgu-uplink.settings.conf`, read after the local conf
and kept by updates; only `preferred`, `wifi`, `wifi_5ghz` and `usb_phone`
are read from it.

| Key | Value |
|---|---|
| `apps` | OAP app names, resolved through `oap_12201/security/uids.txt` every 5 s |
| `uids` | numeric uids of non-app processes (the shipped list is empty); a local `uids` adds to the shipped one; 0 is refused |
| `uplink` | `auto`, or `netdev:<ifname>` for an existing interface (no Wi-Fi, no `preferred`) |
| `preferred` | `wifi`, `usb` or `phone`, tried first; empty (shipped) for the order above; any other value is logged and ignored |
| `wifi` | `on` or `off` (shipped) |
| `wifi_5ghz` | `on`: Wi-Fi joins on either band; `off` (shipped): on 2.4 GHz only where a network is seen there |
| `usb_phone` | `on` (shipped): phones over USB are used; `off`: left alone |
| `table`, `rule_pref` | routing table (110) and first rule priority (1100) |

Components that need the internet add themselves without touching the
conf: the deploy tool writes `/var/opt/mgu-uplink/uids.d/<component>`
(numeric uids) or `apps.d/<component>` (app names; an empty file stands
for the app named like the file), one per line, on install and removes it
on uninstall (deploy/README.md, "Internet for selected components"). An
install or removal takes effect within seconds.

`uplink`, `table` and the other keys take effect at the next service
restart; `preferred`, `wifi`, `wifi_5ghz` and `usb_phone` set by a request take effect at once.

## Build, install, update

```sh
make -C native/mgu-uplink target    # build/target/mgu-uplink (static linux/amd64) and build/target/mgu-wpa
make -C native/mgu-uplink test      # Linux; on a Mac: test-docker
deploy/hu install mgu-uplink        # build and install over SSH (deploy/README.md)
```

`build/target/mgu-wpa` is built with Docker (linux/amd64), in
Ubuntu 18.04 ([`wpa/Dockerfile`](wpa/Dockerfile)), against the libraries the
unit has: [`wpa/build.sh`](wpa/build.sh) applies the patch to upstream's
`wpa_supplicant-2.10.tar.gz` and builds with the options in
[`wpa/config`](wpa/config) (nl80211, control socket, WPA2/WPA3 personal; no
EAP, WPS, P2P or D-Bus), and [`wpa/check.sh`](wpa/check.sh) checks that it
loads with the unit's libraries.

mgu-uplink is a tool component ([`component.json`](component.json)): the
deploy tool installs it, over SSH from the owner's computer
(`deploy/mgu-install.js first-install`, unless `--no-uplink`), or from the
Store's "Internet uplink" row. `mgu-uplink --version` prints its version.

| Path | What |
|---|---|
| `/var/opt/mgu-uplink/versions/<version>/` | `mgu-uplink`, `mgu-wpa` (our wpa_supplicant), `mgu-uplink.conf`, `component.json` |
| `/var/opt/mgu-uplink/current` | the version in use |
| `/var/opt/mgu-uplink/mgu-uplink.local.conf` | the unit's settings |
| `/var/opt/mgu-uplink/mgu-uplink.settings.conf` | what the Store set (`preferred`, `wifi`) |
| `/var/opt/mgu-uplink/wifi/wpa.conf` | the saved Wi-Fi networks (folder 0700) |
| `/var/opt/mgu-uplink/uids.d/`, `apps.d/` | per-component drop-ins (the deploy tool's) |
| `/etc/systemd/system/mgu-uplink.service` | enabled for `multi-user.target` |
| `/etc/recmgr-restartlist.conf` | `mgu-uplink` in `[Whitelist]` and `[WhitelistExitSuccess]` |

A first install starts the service at the next boot. An update restarts
it once the head unit has loaded its restart-list entry (until then the
previous version keeps running); allowed processes are then offline for the
few seconds DHCP takes.

## Check it on the unit

The unit's `ip` (busybox) shows neither policy rules nor per-uid routes;
`mgu-uplink status` prints the device state, the preferred kind, Wi-Fi's
state, the lease, the rules, table 110, the firewall and the route to
1.1.1.1 for root and for each allowed uid.

```sh
systemctl status mgu-uplink; journalctl -u mgu-uplink -b
/var/opt/mgu-uplink/mgu-uplink status
cat /run/mgu-uplink/status.json
nft list table inet mgu_uplink; nft -a list chain ip filter output | grep mgu-uplink
ip route | grep -E 'vethuplink|wlan1'    # main table: nothing
```
