"""HSFZ (BMW diagnostics over IP) to the ENET gateway, carrying UDS to the head unit."""
import socket, struct, time

import netif

HSFZ_IDENT_PORT = 6811      # UDP gateway identification
HSFZ_DIAG_PORT = 6801       # TCP diagnostics
TESTER = 0xF4               # our tester address
HEAD_UNIT = 0x63            # the head unit's diagnostic address


def discover_gateway(iface, timeout=6):
    """The ENET gateway's address: HSFZ identification (00 00 00 00 00 11) broadcast to :6811,
    the first reply not from ourselves names it. None when nothing answers."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if iface:
        netif.bind_iface(s, iface)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("", HSFZ_IDENT_PORT))
    except OSError:
        pass
    s.settimeout(1.0)
    mine = netif.iface_ipv4(iface)
    t = time.time()
    try:
        while time.time() - t < timeout:
            for dst in ("169.254.255.255", "255.255.255.255"):
                try:
                    s.sendto(bytes([0, 0, 0, 0, 0, 0x11]), (dst, HSFZ_IDENT_PORT))
                except OSError:
                    pass
            try:
                while True:
                    _, a = s.recvfrom(2048)
                    if a[0] != mine:
                        return a[0]
            except socket.timeout:
                pass
    finally:
        s.close()
    return None


class Hsfz:
    """One diagnostic connection to the gateway, addressed to the head unit."""

    def __init__(self, host, port=HSFZ_DIAG_PORT, src=TESTER, tgt=HEAD_UNIT, timeout=10, iface=None):
        self.s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if iface:
            netif.bind_iface(self.s, iface)
        self.s.settimeout(timeout)
        self.s.connect((host, port))
        self.src, self.tgt = src, tgt

    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            c = self.s.recv(n - len(buf))
            if not c:
                raise IOError("ENET gateway closed the connection")
            buf += c
        return buf

    def request(self, uds, wait=25):
        """Send one UDS request; the final response payload (acks and 7F xx 78 skipped)."""
        self.s.sendall(struct.pack(">I", 2 + len(uds)) + struct.pack(">H", 0x0001) + bytes([self.src, self.tgt]) + uds)
        deadline = time.time() + wait
        while time.time() < deadline:
            self.s.settimeout(max(1.0, deadline - time.time()))
            hdr = self._recv(6)
            blen = struct.unpack(">I", hdr[:4])[0]
            ctrl = struct.unpack(">H", hdr[4:6])[0]
            payload = self._recv(blen)[2:]          # strip src, tgt
            if ctrl != 0x0001 or not payload:       # 0x0002 acks, empty frames
                continue
            if len(payload) >= 3 and payload[0] == 0x7F and payload[2] == 0x78:
                continue                            # responsePending
            return payload
        raise IOError("timed out waiting for a final UDS response")

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def expect(resp, sid_hex, what):
    """resp when it starts with sid_hex; raises on a negative or unexpected response."""
    want = bytes.fromhex(sid_hex.replace(" ", ""))
    if resp[:1] == b"\x7f":
        raise RuntimeError(f"{what}: negative response {resp[:3].hex(' ')}")
    if not resp.startswith(want):
        raise RuntimeError(f"{what}: unexpected response {resp[:8].hex(' ')}")
    return resp
