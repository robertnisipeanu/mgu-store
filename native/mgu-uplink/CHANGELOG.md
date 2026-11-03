# mgu-uplink changelog

## 0.7.4

- Wi-Fi through the car's supplicant (iDrive 7, `wlan0`): while the uplink is online on a device that ranks above Wi-Fi (a phone with `preferred = phone`, an adapter with `usb`) and Wi-Fi is not joined, our networks are switched off in the car's supplicant, which then stops scanning every 5 s for a saved network out of range. Those scans took the shared radio off wireless CarPlay's channel and flooded the journal. They are switched on again as soon as that uplink is offline or gone, and for a `wifi-scan` request. They are only ever in the supplicant's memory, and a start adds them switched on. `wlan1` (our own wpa_supplicant) is unchanged.

## 0.7.3

- Wi-Fi on iDrive 7 units without `wlan1` (Broadcom BCM4359, `bcmdhd`): the unit joins on the car's own `wlan0` through the car's D-Bus wpa_supplicant, beside the car's hotspot and wireless CarPlay, with the same requests, saved networks, DHCP, routing and firewall as on `wlan1`. Our networks live only in the car's supplicant's memory, tagged `id_str="mgu-uplink"`, and are removed when Wi-Fi is switched off, the service stops or the car starts using `wlan0` (a network of its own, its Wi-Fi switched off); a start removes the ones a killed run left. `wlan1`, where there is one, is used as before.
- `status.json`'s `wifi.backend` says what joins: `mgu-wpa` or `car-supplicant`.

## 0.7.2

- Wi-Fi: `wlan1` is taken again when the car blocks its radio or sets it down under our wpa_supplicant (connman switching its Wi-Fi off blocks every WLAN rfkill), or when it is created again (the driver is reloaded around suspend). Before, wpa_supplicant stayed `INTERFACE_DISABLED`, every scan failed with `scan: FAIL` and the state showed `idle` until Wi-Fi was switched off and on. A supplicant that ran 2 min is taken again at once, else after the usual 30 s, doubling, up to 5 in a row. A scan that fails so says why.
- Wi-Fi requests wait for wpa_supplicant's control socket ("Wi-Fi is starting"), not only for the process.

## 0.7.1

- Our wpa_supplicant is installed as `mgu-wpa`, and the tool names `mgu-uplink` and `mgu-wpa` in `crashNames`: with deploy tool 0.6.0 a crash of either does not reboot the head unit.
- Whether the car's D-Bus wpa_supplicant has `wlan1` is asked over the system bus directly, with the same 3 s limit; the uplink runs no `dbus-send`.

## 0.7.0

- Wi-Fi: the unit joins a phone's hotspot or another access point through its own radio (`wlan1`, iDrive 7 and iDrive 8), and the uplink uses it like a plugged-in device, with the same DHCP, routing, uid rules, firewall and lease. Our own wpa_supplicant does the association: upstream 2.10 with a patch for the head unit's driver, built with the tool and shipped beside it. Off until switched on (`wifi = on`, or the `wifi-enable` request); off leaves the radio and the car's own Wi-Fi, hotspot and wireless CarPlay as they are. Switched on, `wlan1` is taken only while the car does not use it (an access point or P2P mode, hostapd, another or the D-Bus wpa_supplicant, connman); otherwise Wi-Fi is `unavailable`, and `wlan1` is given back when the car starts using it (not when a check only fails), and taken again no sooner than 60 s later, doubling. A wpa.conf wpa_supplicant can't read is moved to `wpa.conf.bad`. A failure to take `wlan1` or run wpa_supplicant is tried again after 30 s, doubling, and after 5 in a row not until Wi-Fi is switched on again. Saved networks are kept in `/var/opt/mgu-uplink/wifi/wpa.conf` (root only), each once it was joined with its password. From IterioDev mgu-wifi 1.0.0.
- Order: Wi-Fi first, then the USB adapters and sticks, then the phones. A group can be tried first (`preferred = wifi`, `usb` or `phone`, or the `prefer` request); the other groups are fallbacks. A change takes effect within 5 s.
- Requests on `/run/mgu-uplink/ctl.sock` (root only): `prefer`, `wifi-enable`, `wifi-scan`, `wifi-connect`, `wifi-forget`. The `prefer` and `wifi-enable` choices are kept in `/var/opt/mgu-uplink/mgu-uplink.settings.conf` (`settings_conf`, read after `mgu-uplink.local.conf`); a line in it this version can't take is logged and skipped, and earlier versions do not read it, so a rollback still starts.
- `status.json` adds `preferred` and `wifi` (link state, network, address, signal, the networks in range, the saved ones, scanning, error); `mgu-uplink status` shows them.

## 0.6.0

- iPhone: the unit pairs with the phone the way a computer does (usbmux and lockdown on the phone's usbmux interface). The first time, the phone asks "Trust This Computer?". After Trust and the passcode, the phone is paired and the pairing is kept in `/var/opt/mgu-uplink/pairing/`. Every later connection opens a lockdown session as the paired host, so the phone serves its Personal Hotspot without asking again. A phone that forgot the pairing (lockdown `InvalidHostID`) is paired again. After "Don't Trust" the phone goes back to media and is not asked again until it is plugged in again.
- iPhone: the hotspot interface is brought up as IterioDev's ipheth-tether does it: alternate setting 1 before GET_MACADDR and ENABLE_NCM, up to 10 CARRIER_CHECK polls, and CLEAR_HALT on both bulk endpoints. Frames go out with no zero-length packet. Every receive uses a 64 KiB buffer and a 1 s timeout. An NCM block entry that does not fit the transfer is skipped instead of ending the block.
- iPhone: when a phone trusts the unit and shares its hotspot but sends nothing for 20 s, it is taken again, as if it had been unplugged and plugged back in. The wait doubles with each retake in a row, up to 5 minutes; a link whose usbmux session ended waits as long before the phone is taken again. Data from the phone, or plugging it in again, starts it over at 20 s. An iPhone whose link failed while it is still plugged in goes back to media.
- Any device: the uplink always takes whatever is plugged in (USB Ethernet adapter, LTE stick, Android phone, iPhone), in the existing order when there are several. `uplink = usb|usbecm|rndis|ncm|iphone` and `usb_device` in a unit's `mgu-uplink.local.conf` are ignored and logged at start. `uplink = netdev:<ifname>` still selects an existing interface.
