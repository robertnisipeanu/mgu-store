"""The ENET adapter: finding it, its address, and sending from it."""
import socket, subprocess, sys

IP_BOUND_IF = 25            # macOS <netinet/in.h>: bind a socket's egress to an interface


def bind_iface(sock, iface):
    """Send sock's traffic out of iface: link-local addresses are routed only per interface."""
    if sys.platform == "darwin":
        sock.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, socket.if_nametoindex(iface))
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())


def detect_enet_iface():
    """The interface with a 169.254.x.x (link-local) IPv4 address: the ENET adapter, or None."""
    try:
        out = subprocess.check_output(["ifconfig"], text=True)
    except Exception:
        return None
    cur = None
    for line in out.splitlines():
        if line and line[0].isalnum() and ":" in line.split()[0]:
            cur = line.split(":")[0]
        if "inet 169.254." in line and cur:
            return cur
    return None


def iface_ipv4(iface):
    """iface's own IPv4 address, or None."""
    if not iface:
        return None
    try:
        out = subprocess.check_output(["ifconfig", iface], text=True)
        for line in out.splitlines():
            if "inet " in line:
                return line.split("inet ")[1].split()[0]
    except Exception:
        pass
    return None
