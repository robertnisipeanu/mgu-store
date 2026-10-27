# Stand-ins for the network under deploy/transport/mgu_connect.py (MGU_CONNECT_FAKES), for the
# deploy/hu tests. The unit is an SSH banner server on 127.0.0.1; the hotspot address is
# 127.0.0.1; HSFZ is a recorder that answers like the unit. Every line goes to
# $FAKE_TRANSPORT_LOG: "loaded", "hu-port <port>", "request <hex>".
#   FAKE_ENET=1     an ENET adapter (the loopback interface) is present
#   FAKE_SILENT=1   the unit serves no banner
import os, socket, sys, threading

LOG = os.environ["FAKE_TRANSPORT_LOG"]


def note(line):
    with open(LOG, "a") as f:
        f.write(line + "\n")


note("loaded")
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.bind(("127.0.0.1", 0))
port = srv.getsockname()[1]
if os.environ.get("FAKE_SILENT") == "1":
    srv.close()                     # nothing listens on the unit's port
else:
    srv.listen(8)

    def serve():
        while True:
            c, _ = srv.accept()
            c.sendall(b"SSH-2.0-OpenSSH_7.8 fake\r\n")
            c.close()
    threading.Thread(target=serve, daemon=True).start()
note(f"hu-port {port}")


class FakeHsfz:
    ANSWERS = {"1003": "5003", "3101a671": "7101a671" + ("ab" * 32).encode().hex(), "3101a0fd": "7101a0fd",
               "22172a": "62172a007f000001", "3e00": "7e00", "3102a0fd": "7102a0fd"}

    def __init__(self, gw, iface=None):
        pass

    def request(self, uds, wait=25):
        h = uds.hex()
        note(f"request {h[:8]}")
        for k, v in self.ANSWERS.items():
            if h.startswith(k):
                return bytes.fromhex(v)
        return b"\x7f\x00\x11"

    def close(self):
        pass


class FakeOp:
    Hsfz = FakeHsfz

    @staticmethod
    def discover_gateway(iface):
        note(f"discover {iface}")
        return "127.0.0.1"

    @staticmethod
    def expect(resp, sid_hex, what):
        if not resp.startswith(bytes.fromhex(sid_hex.replace(" ", ""))):
            raise RuntimeError(f"{what}: {resp.hex()}")
        return resp


class FakeCert:
    @staticmethod
    def leaf_for(cn, assets):
        note(f"leaf {cn}")
        return b"LEAF", b"PMO"


loop = "lo0" if sys.platform == "darwin" else "lo"
mgu_connect.WIFI_HU_IP = "127.0.0.1"           # noqa: F821  (given by mgu_connect.py)
mgu_connect.HU_SSH_PORT = port                 # noqa: F821
mgu_connect.DEPS = mgu_connect.Deps(           # noqa: F821
    detect_iface=lambda: loop if os.environ.get("FAKE_ENET") == "1" else None,
    op=FakeOp, cert=FakeCert)
