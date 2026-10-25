#!/bin/sh
# USB gadgets as fake phones and sticks for testing mgu-uplink in a Linux VM
# (Ubuntu, linux-modules-extra, usbip tools, dnsmasq, udhcpc, nft). Each
# gadget is bound to dummy_hcd's UDC, which the VM's own USB host side sees
# as a plugged-in device (dummy_hcd is not in Ubuntu's kernels: build it
# from github.com/xairy/raw-gadget dummy_hcd/ and set DUMMY_HCD to the .ko).
# rndis-e0 goes through usbip-vudc and vhci-hcd over loopback instead. The
# gadget's network
# side sits in netns "phone" on bridge br0 (192.168.42.1/24, dnsmasq, NAT
# to the VM's uplink): that is the phone's network. Run as root.
#
#   vm-gadget.sh setup                 modules, phone netns, dnsmasq, usbipd
#   vm-gadget.sh plug ecm|ncm|rndis|rndis-e0|iphone [udc 0-3]
#   vm-gadget.sh unplug [udc]          detach and remove the gadget on that UDC
#   vm-gadget.sh replug [udc]          unplug and plug the same gadget (the fake
#                                      iPhone keeps what it trusts)
#   vm-gadget.sh hostdrivers on|off    allow or keep off the host's cdc_ether, rndis_host,
#                                      cdc_ncm and ipheth (off: mgu-uplink drives the devices)
#
# rndis-e0 presents the RNDIS control interface as Android does (e0/01/03):
# f_rndis always says 02/02/ff, so the usbip stream is passed through
# usbip-rewrite.py, which rewrites that interface descriptor on the way.
# (usbip-vudc is not used for the others: the host's usbfs read timeouts
# become usbip unlinks, which vudc with FunctionFS does not survive.)
# iphone runs the FunctionFS fake (gadget_test.go): build it with
# GOOS=linux go test -c -o fakephone.test and keep it next to this script.

set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
CFG=/sys/kernel/config/usb_gadget
LOG=${LOG:-/tmp/uplink-vm}

hostdrivers() {
    for m in cdc_mbim cdc_ether rndis_host cdc_ncm ipheth cdc_subset; do
        if [ "$1" = off ]; then
            echo "blacklist $m"; echo "install $m /bin/false"; modprobe -r "$m" 2>/dev/null || true
        fi
    done > /etc/modprobe.d/mgu-uplink-test.conf
    [ "$1" = on ] && rm -f /etc/modprobe.d/mgu-uplink-test.conf && modprobe cdc_ether
    true
}

setup() {
    modprobe libcomposite
    lsmod | grep -q '^dummy_hcd' || insmod "${DUMMY_HCD:-/root/raw-gadget/dummy_hcd/dummy_hcd.ko}" num=4 is_high_speed=1
    modprobe usbip-vudc num=4
    modprobe vhci-hcd
    mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config
    hostdrivers off
    # The image's catch-all networkd config would run DHCP on every new
    # interface (the unit's connman leaves veth* alone by its blacklist).
    ln -sf /dev/null /etc/systemd/network/zzzz-dracut-default.network
    networkctl reload 2>/dev/null || true
    ip netns add phone 2>/dev/null || true
    if ! ip link show ph-root >/dev/null 2>&1; then
        ip link add ph-root type veth peer name ph-ns
        ip link set ph-ns netns phone
        ip addr add 10.99.0.1/30 dev ph-root
        ip link set ph-root up
        ip -n phone link set lo up
        ip -n phone addr add 10.99.0.2/30 dev ph-ns
        ip -n phone link set ph-ns up
        ip -n phone route add default via 10.99.0.1
        ip -n phone link add br0 type bridge
        ip -n phone addr add 192.168.42.1/24 dev br0
        ip -n phone link set br0 up
    fi
    sysctl -qw net.ipv4.ip_forward=1
    ip netns exec phone sysctl -qw net.ipv4.ip_forward=1
    out=$(ip route show default | awk '{print $5; exit}')
    iptables -t nat -C POSTROUTING -s 10.99.0.0/30 -o "$out" -j MASQUERADE 2>/dev/null ||
        iptables -t nat -A POSTROUTING -s 10.99.0.0/30 -o "$out" -j MASQUERADE
    ip netns exec phone iptables -t nat -C POSTROUTING -s 192.168.42.0/24 -o ph-ns -j MASQUERADE 2>/dev/null ||
        ip netns exec phone iptables -t nat -A POSTROUTING -s 192.168.42.0/24 -o ph-ns -j MASQUERADE
    if [ ! -f /run/phone-dnsmasq.pid ]; then
        ip netns exec phone dnsmasq --interface=br0 --bind-interfaces --except-interface=lo \
            --dhcp-range=192.168.42.50,192.168.42.150,12h --dhcp-option=6,1.1.1.1 \
            --no-resolv --server=1.1.1.1 --pid-file=/run/phone-dnsmasq.pid \
            --log-dhcp --log-facility="$LOG/dnsmasq.log"
    fi
    mkdir -p /tmp/phone-www && echo "served by the phone's network" > /tmp/phone-www/index.html
    if [ ! -f /run/phone-http.pid ]; then
        ip netns exec phone sh -c 'cd /tmp/phone-www && exec python3 -m http.server 8000 --bind 192.168.42.1' \
            > "$LOG/phone-http.log" 2>&1 &
        echo $! > /run/phone-http.pid
    fi
    pgrep -x usbipd >/dev/null || usbipd --device -D
    echo "setup done"
}

# phone_netdev puts the gadget's network interface on the phone bridge.
phone_netdev() {
    ifname=$(cat "$1/ifname") name=gph$udc
    ip link set "$ifname" down
    ip link set "$ifname" name $name
    ip link set $name netns phone
    ip -n phone link set $name master br0
    ip -n phone link set $name up
    echo $name > "$2/phone-ifname"
}

plug() {
    kind=$1 udc=${2:-0}
    g=$CFG/g$udc
    [ -d "$g" ] && { echo "UDC $udc already has a gadget"; exit 1; }
    mkdir -p "$g" /run/mgu-gadget/$udc
    st=/run/mgu-gadget/$udc
    echo "$kind" > $st/kind
    cd "$g"
    echo 0x1d6b > idVendor; echo 0x0104 > idProduct; echo 0x0200 > bcdUSB
    mkdir -p strings/0x409
    echo "mgu-test" > strings/0x409/manufacturer
    echo "fake $kind" > strings/0x409/product
    echo "000$udc" > strings/0x409/serialnumber
    case $kind in
    ecm|ncm|rndis|rndis-e0)
        f=${kind%-e0}
        mkdir configs/c.1 functions/$f.usb$udc
        echo "02:22:33:44:55:6$udc" > functions/$f.usb$udc/host_addr
        echo "02:22:33:44:55:0$udc" > functions/$f.usb$udc/dev_addr
        ln -s functions/$f.usb$udc configs/c.1/
        ;;
    iphone)
        echo 0x05ac > idVendor; echo 0x12a8 > idProduct
        echo "Apple Inc." > strings/0x409/manufacturer; echo "iPhone" > strings/0x409/product
        mounts=
        for c in 1 2 3 4; do
            name=ptp$c; [ $c = 4 ] && name=iphone
            mkdir configs/c.$c functions/ffs.$name$udc
            ln -s functions/ffs.$name$udc configs/c.$c/
            mkdir -p /dev/ffs-$name$udc
            mount -t functionfs $name$udc /dev/ffs-$name$udc
            mounts="$mounts${mounts:+,}/dev/ffs-$name$udc"
        done
        ip tuntap del iph$udc mode tap 2>/dev/null || true
        MGU_FAKEPHONE_FFS=$mounts MGU_FAKEPHONE_TAP=iph$udc MGU_FAKEPHONE_RX=${RX:-ncm} \
        MGU_FAKEPHONE_PROMPTS=${PROMPTS:-3} \
            "$HERE/fakephone.test" -test.run TestGadgetFakePhone -test.v -test.timeout 0 \
            > "$LOG/fakephone$udc.log" 2>&1 &
        echo $! > $st/fake.pid
        for i in $(seq 50); do ip link show iph$udc >/dev/null 2>&1 && break; sleep 0.1; done
        sleep 1
        ip link set iph$udc netns phone
        ip -n phone link set iph$udc master br0
        ip -n phone link set iph$udc up
        echo iph$udc > $st/phone-ifname
        ;;
    *) echo "unknown kind $kind"; exit 2 ;;
    esac
    if [ "$kind" = rndis-e0 ]; then echo usbip-vudc.$udc > UDC; else echo dummy_udc.$udc > UDC; fi
    sleep 0.5
    # The function's interface has its name once the gadget is bound.
    for f in functions/ecm.* functions/ncm.* functions/rndis.*; do
        [ -d "$f" ] && phone_netdev "$f" "$st"
    done
    if [ "$kind" = rndis-e0 ]; then
        port=$((3250 + udc))
        python3 "$HERE/usbip-rewrite.py" $port > "$LOG/rewrite$udc.log" 2>&1 &
        echo $! > $st/rewrite.pid
        sleep 0.5
        usbip --tcp-port $port attach -r 127.0.0.1 -d usbip-vudc.$udc
    fi
    echo "plugged $kind on UDC $udc"
}

unplug() {
    udc=${1:-0}
    st=/run/mgu-gadget/$udc g=$CFG/g$udc
    [ -d "$g" ] || { echo "nothing on UDC $udc"; return 0; }
    port=$(usbip port 2>/dev/null | awk -v b="usbip-vudc.$udc" '/^Port/ {p=$2} index($0, b) {sub(":", "", p); print p+0; exit}')
    [ -n "$port" ] && usbip detach -p "$port" || true
    sleep 0.5
    echo "" > "$g/UDC" 2>/dev/null || true
    [ -f $st/fake.pid ] && kill "$(cat $st/fake.pid)" 2>/dev/null || true
    [ -f $st/rewrite.pid ] && kill "$(cat $st/rewrite.pid)" 2>/dev/null || true
    for c in "$g"/configs/c.*; do
        [ -d "$c" ] || continue
        for l in "$c"/*.*; do [ -L "$l" ] && rm "$l"; done
        rmdir "$c/strings/0x409" 2>/dev/null || true
        rmdir "$c"
    done
    for m in /dev/ffs-*$udc; do [ -d "$m" ] && umount "$m" 2>/dev/null; rmdir "$m" 2>/dev/null || true; done
    for f in "$g"/functions/*; do [ -d "$f" ] && rmdir "$f"; done
    rmdir "$g/strings/0x409" "$g"
    rm -rf $st
    echo "unplugged UDC $udc"
}

replug() {
    udc=${1:-0}
    echo "" > $CFG/g$udc/UDC
    sleep 2
    echo dummy_udc.$udc > $CFG/g$udc/UDC
    echo "replugged UDC $udc"
}

case ${1:-} in
setup) setup ;;
replug) shift; replug "$@" ;;
plug) shift; plug "$@" ;;
unplug) shift; unplug "$@" ;;
hostdrivers) hostdrivers "$2" ;;
*) sed -n '2,29p' "$0"; exit 2 ;;
esac
