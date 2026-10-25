#!/usr/bin/env python3
"""
Offline tests of deploy/transport: the connection selection with stand-ins for the ENET
adapter, HSFZ, the debug certificate and the banner probe, and the banner check and the
relay against servers on 127.0.0.1. No car address is contacted.

Prints one "ok <name>" / "not ok <name>" line per check; deploy/test/run.js collects them.
"""
import os, socket, sys, tempfile, threading, time, traceback

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "transport"))
import mgu_connect as mc  # noqa: E402
import hsfz  # noqa: E402

LOOP = "lo0" if sys.platform == "darwin" else "lo"
TMP = tempfile.mkdtemp(prefix="mgu-transport-test-")
failed = 0


def check(name, cond, detail=""):
    global failed
    if cond:
        print(f"ok {name}", flush=True)
    else:
        failed += 1
        print(f"not ok {name}" + (f"\n  # {detail}" if detail else ""), flush=True)


# ---- stand-ins -------------------------------------------------------------------------------
class FakeOp:
    """HSFZ that records every call and answers from a table (hex prefix -> hex reply)."""

    def __init__(self, gateway="169.254.1.1", answers=None):
        self.gateway, self.calls = gateway, []
        self.answers = answers if answers is not None else {}
        op = self

        class H:
            def __init__(self, gw, iface=None):
                op.calls.append(("connect", gw))

            def request(self, uds, wait=25):
                h = uds.hex()
                op.calls.append(("request", h))
                for k, v in op.answers.items():
                    if h.startswith(k):
                        if isinstance(v, Exception):
                            raise v
                        return bytes.fromhex(v)
                return b"\x7f\x00\x11"

            def close(self):
                pass
        self.Hsfz = H
        self.expect = hsfz.expect

    def discover_gateway(self, iface):
        self.calls.append(("discover", iface))
        return self.gateway

    def requests(self):
        return [c[1] for c in self.calls if c[0] == "request"]


class FakeCert:
    def __init__(self):
        self.calls = []

    def leaf_for(self, cn, assets):
        self.calls.append(cn)
        return b"LEAF", b"PMO"


def did(ip):
    return "62172a00" + "".join(f"{int(x):02x}" for x in ip.split("."))


ARMING = {"1003": "5003", "3101a671": "7101a671" + ("cd" * 32).encode().hex(), "3101a0fd": "7101a0fd",
          "3e00": "7e00", "3102a0fd": "7102a0fd"}


def banner_of(answering):
    probes = []

    def banner(ip, port=None, iface=None, timeout=4):
        probes.append((ip, port, iface))
        return "SSH-2.0-fake" if ip in answering else None
    return banner, probes


def deps(op=None, detect=None, answering=(), cert=None):
    banner, probes = banner_of(set(answering))
    d = mc.Deps(detect_iface=lambda: detect, banner=banner, op=op or FakeOp(), cert=cert or FakeCert())
    return d, probes


def cache(name="", legacy=None, state=None):
    root = tempfile.mkdtemp(dir=TMP)
    assets = os.path.join(root, "tool_analysis", "cap_assets")
    os.makedirs(assets)
    if legacy:
        with open(os.path.join(root, "tool_analysis", mc.CACHE_NAME), "w") as f:
            f.write(legacy + "\n")
    st = os.path.join(root, "state")
    if state:
        os.makedirs(st)
        with open(os.path.join(st, mc.CACHE_NAME), "w") as f:
            f.write(state + "\n")
    return mc.Cache(st, assets)


def raises(fn, kind):
    try:
        fn()
    except kind as e:
        return e
    return None


# ---- local servers ---------------------------------------------------------------------------
def server(greeting=None, echo=False):
    """A TCP server on 127.0.0.1: sends greeting, or echoes, or stays silent. Returns its port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)

    def handle(c):
        try:
            if greeting:
                c.sendall(greeting)
            if echo:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    c.sendall(d)
            else:
                time.sleep(5)
        except OSError:
            pass
        finally:
            c.close()

    def serve():
        while True:
            c, _ = s.accept()
            threading.Thread(target=handle, args=(c,), daemon=True).start()
    threading.Thread(target=serve, daemon=True).start()
    return s.getsockname()[1]


def closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ---- selection -------------------------------------------------------------------------------
def test_selection():
    op = FakeOp()
    d, probes = deps(op, detect=LOOP, answering={mc.WIFI_HU_IP})
    r = mc.select(wifi=True, cache=cache(), deps=d)
    check("select: --wifi is the hotspot address, no ENET lookup", r == (mc.WIFI_HU_IP, None) and
          probes == [(mc.WIFI_HU_IP, 22, None)] and op.calls == [], f"{r} {probes} {op.calls}")

    d, _ = deps(detect=LOOP, answering={mc.WIFI_HU_IP})
    link = mc.Direct(True, None, None, 0, cache(), d).open()
    check("select: --wifi connects directly, no relay", link == mc.Link(mc.WIFI_HU_IP, 22, mc.WIFI_HU_IP, "wifi"), link)

    d, probes = deps(detect=None, answering={mc.WIFI_HU_IP})
    r = mc.select(cache=cache(), deps=d)
    check("select: auto without an ENET adapter takes the hotspot", r == (mc.WIFI_HU_IP, None), r)

    op = FakeOp(answers={"22172a": did("169.254.1.2")})
    c = cache(state="169.254.9.9")
    d, probes = deps(op, detect=LOOP, answering={"169.254.1.2", "169.254.9.9"})
    r = mc.select(cache=c, deps=d)
    check("select: auto with an ENET adapter takes the DID 172A address",
          r == ("169.254.1.2", LOOP) and probes[0] == ("169.254.1.2", 22, LOOP), f"{r} {probes}")
    check("select: the DID read sends 22 17 2A alone (no session change, no routine)",
          op.requests() == ["22172a"], op.calls)
    check("select: the address that answered is cached", c.load()[0][1] == "169.254.1.2", c.load())

    op = FakeOp(gateway=None)
    d, _ = deps(op, detect=LOOP, answering={"169.254.9.9"})
    r = mc.select(cache=cache(state="169.254.9.9"), deps=d)
    check("select: DID failure falls back to the cached address", r == ("169.254.9.9", LOOP), r)

    op = FakeOp(answers={"22172a": "7f2231"})
    d, _ = deps(op, detect=LOOP, answering={"169.254.7.7"})
    c = cache(legacy="169.254.7.7")
    r = mc.select(cache=c, deps=d)
    check("select: reads the cache kept beside the assets folder, writes its own",
          r == ("169.254.7.7", LOOP) and os.path.exists(c.file), f"{r} {c.files}")

    op = FakeOp(answers={"22172a": did("169.254.1.2")})
    d, probes = deps(op, detect=LOOP, answering={"169.254.9.9"})
    r = mc.select(cache=cache(state="169.254.9.9"), deps=d)
    check("select: no banner on the first candidate tries the next",
          r == ("169.254.9.9", LOOP) and [p[0] for p in probes] == ["169.254.1.2", "169.254.9.9"], f"{r} {probes}")

    op, cert = FakeOp(answers={"22172a": did("169.254.1.2")}), FakeCert()
    d, _ = deps(op, detect=LOOP, answering=(), cert=cert)
    e = raises(lambda: mc.select(cache=cache(state="169.254.9.9"), deps=d), mc.Unreachable)
    check("select: no banner anywhere stops with the permanent-SSH-disabled message",
          e is not None and "Permanent (field-mode) SSH seems disabled" in str(e) and "NOT armed" in str(e), e)
    check("select: without --arm-debug nothing arms", op.requests() == ["22172a"] and cert.calls == [],
          f"{op.calls} {cert.calls}")

    d, _ = deps(detect=None, answering=())
    e = raises(lambda: mc.select(wifi=True, cache=cache(), deps=d), mc.Unreachable)
    check("select: a silent hotspot stops with the permanent-SSH-disabled message",
          e is not None and "Permanent (field-mode) SSH seems disabled" in str(e), e)

    op = FakeOp(answers={"22172a": did("169.254.1.2")})
    d, probes = deps(op, detect=LOOP, answering={"169.254.5.5"})
    r = mc.select(hu_ip="169.254.5.5", cache=cache(state="169.254.9.9"), deps=d)
    check("select: --hu-ip is used alone (no DID read, no cache)",
          r == ("169.254.5.5", LOOP) and op.calls == [] and len(probes) == 1, f"{r} {op.calls} {probes}")

    d, _ = deps(detect=None)
    e = raises(lambda: mc.select(iface="no-such-if0", cache=cache(), deps=d), mc.Refused)
    check("select: an unknown --iface is refused", e is not None and "no-such-if0" in str(e), e)


def test_cli_usage():
    marker = os.path.join(TMP, "fakes-loaded")
    fakes = os.path.join(TMP, "fakes.py")
    with open(fakes, "w") as f:
        f.write(f"open({marker!r}, 'w').write('x')\n")
    os.environ["MGU_CONNECT_FAKES"] = fakes
    import contextlib, io
    for args in (["open", "--arm-debug", "--wifi"], ["open", "--arm-debug", "--hu-ip", "1.2.3.4"], ["open", "--keep-armed"]):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            e = raises(lambda: mc.main(args), SystemExit)
        check(f"cli: {' '.join(args[1:])} is a usage error before any network",
              e is not None and e.code == 2 and not os.path.exists(marker), f"{e and e.code} {err.getvalue()}")
    with contextlib.redirect_stderr(io.StringIO()) as err:
        code = mc.main(["open", "--arm-debug", "--assets", os.path.join(TMP, "none")])
    check("cli: --arm-debug without the assets names what is missing, exit 2",
          code == 2 and "asset_04.bin" in err.getvalue(), err.getvalue())
    del os.environ["MGU_CONNECT_FAKES"]


# ---- banner and relay ------------------------------------------------------------------------
def test_banner_relay():
    p = server(b"SSH-2.0-OpenSSH_7.8\r\n")
    check("banner: an SSH-2.0 greeting is accepted", mc.ssh_banner("127.0.0.1", p, timeout=2) == "SSH-2.0-OpenSSH_7.8")
    check("banner: wait_ssh accepts it", mc.wait_ssh("127.0.0.1", p, 2, interval=0.1))
    silent = server()
    t = time.time()
    b = mc.ssh_banner("127.0.0.1", silent, timeout=1)
    el = time.time() - t
    check("banner: a silent socket is rejected within the timeout", b is None and el < 2, f"{b} {el:.2f}s")
    t = time.time()
    ok = mc.wait_ssh("127.0.0.1", silent, 2, interval=0.1, timeout=0.5)
    el = time.time() - t
    check("banner: wait_ssh gives up on a silent socket after its tries", not ok and el < 2.5, f"{ok} {el:.2f}s")
    check("banner: a non-SSH greeting is rejected", mc.ssh_banner("127.0.0.1", server(b"HTTP/1.1 400\r\n"), timeout=2) is None)
    check("banner: a closed port is rejected", mc.ssh_banner("127.0.0.1", closed_port(), timeout=2) is None)
    check("banner: a socket bound to the loopback interface reads it",
          mc.ssh_banner("127.0.0.1", p, iface=LOOP, timeout=2) == "SSH-2.0-OpenSSH_7.8")

    echo = server(echo=True)
    for iface in (None, LOOP):
        r = mc.Relay(0, "127.0.0.1", echo, iface)
        data = os.urandom(200000)
        got = []
        for _ in range(2):
            c = socket.create_connection(("127.0.0.1", r.lport), timeout=5)
            c.sendall(data)
            c.shutdown(socket.SHUT_WR)
            buf = b""
            while True:
                d = c.recv(65536)
                if not d:
                    break
                buf += d
            c.close()
            got.append(buf)
        r.close()
        check(f"relay: forwards bytes both ways between two loopback ports (iface {iface})",
              got == [data, data], [len(g) for g in got])
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen(1)
    e = raises(lambda: mc.Relay(busy.getsockname()[1], "127.0.0.1", echo), mc.Unreachable)
    busy.close()
    check("relay: a local port in use is reported", e is not None and "--lport" in str(e), e)


def test_direct_enet():
    p = server(b"SSH-2.0-unit\r\n")
    saved = mc.HU_SSH_PORT
    mc.HU_SSH_PORT = p
    try:
        op = FakeOp(gateway="127.0.0.1", answers={"22172a": did("127.0.0.1")})
        d = mc.Deps(detect_iface=lambda: LOOP, op=op, cert=FakeCert())
        s = mc.Direct(False, None, None, 0, cache(), d)
        link = s.open()
        through = mc.ssh_banner("127.0.0.1", link.port, timeout=2)
        s.close()
        check("direct ENET: ssh goes to the relay on 127.0.0.1, which reaches the unit's sshd",
              link.host == "127.0.0.1" and link.port != p and link.hu_ip == "127.0.0.1" and
              link.via == f"enet {LOOP}" and through == "SSH-2.0-unit", f"{link} {through}")
    finally:
        mc.HU_SSH_PORT = saved


def test_armed():
    p = server(b"SSH-2.0-debug\r\n")
    saved = mc.HU_SSH_PORT
    mc.HU_SSH_PORT = p
    try:
        op, cert = FakeOp(gateway="127.0.0.1", answers=dict(ARMING, **{"22172a": did("127.0.0.1")})), FakeCert()
        d = mc.Deps(detect_iface=lambda: LOOP, op=op, cert=cert)
        s = mc.Armed(None, 0, "/assets", cache(), False, d, tries=2, interval=0.1)
        link = s.open()
        reqs = [r[:8] for r in op.requests()]
        check("arm: extended session, challenge, A0FD with the minted leaf, then DID 172A",
              reqs[:4] == ["1003", "3101a671", "3101a0fd", "22172a"] and cert.calls == ["CD" * 32] and
              op.requests()[2] == "3101a0fd" + b"LEAFPMO".hex(), f"{reqs} {cert.calls}")
        through = mc.ssh_banner("127.0.0.1", link.port, timeout=2)
        check("arm: relays to the unit's sshd", through == "SSH-2.0-debug" and link.via.endswith("debug armed"), link)
        time.sleep(2.3)
        check("arm: holds the session with TesterPresent", "3e00" in op.requests(), op.requests())
        check("arm: not disarmed while held", "3102a0fd" not in op.requests())
        s.close()
        check("arm: disarms (31 02 A0 FD) on exit", op.requests()[-1] == "3102a0fd", op.requests()[-3:])

        op = FakeOp(gateway="127.0.0.1", answers=dict(ARMING, **{"22172a": did("127.0.0.1")}))
        s = mc.Armed(None, 0, "/assets", cache(), True, mc.Deps(detect_iface=lambda: LOOP, op=op, cert=FakeCert()),
                     tries=2, interval=0.1)
        s.open()
        s.close()
        check("arm: --keep-armed leaves it armed", "3102a0fd" not in op.requests(), op.requests())

        mc.HU_SSH_PORT = closed_port()
        op = FakeOp(gateway="127.0.0.1", answers=dict(ARMING, **{"22172a": did("127.0.0.1")}))
        s = mc.Armed(None, 0, "/assets", cache(), False, mc.Deps(detect_iface=lambda: LOOP, op=op, cert=FakeCert()),
                     tries=2, interval=0.1)
        t = time.time()
        e = raises(s.open, mc.Unreachable)
        check("arm: no banner after arming stops with the reboot instruction, without looping",
              e is not None and "Reboot the HU now" in str(e) and time.time() - t < 10, e)
        check("arm: and leaves debug armed for that reboot", "3102a0fd" not in op.requests(), op.requests())

        op = FakeOp(gateway="127.0.0.1", answers=dict(ARMING, **{"3101a0fd": "7f3133"}))
        s = mc.Armed(None, 0, "/assets", cache(), False, mc.Deps(detect_iface=lambda: LOOP, op=op, cert=FakeCert()))
        e = raises(s.open, RuntimeError)
        check("arm: a refused A0FD sends the disarm and stops",
              e is not None and op.requests()[-1] == "3102a0fd", f"{e} {op.requests()}")

        op = FakeOp(gateway=None)
        e = raises(mc.Armed(None, 0, "/a", cache(), False, mc.Deps(detect_iface=lambda: LOOP, op=op, cert=FakeCert())).open,
                   mc.Unreachable)
        check("arm: no ENET gateway stops before any request", e is not None and op.requests() == [], e)
    finally:
        mc.HU_SSH_PORT = saved


for t in (test_selection, test_cli_usage, test_banner_relay, test_direct_enet, test_armed):
    try:
        t()
    except Exception:
        check(f"{t.__name__} ran to the end", False, traceback.format_exc().replace("\n", "\n  # "))
sys.exit(1 if failed else 0)
