#!/usr/bin/env python3
"""
The head unit's sshd, reached from the Mac. deploy/hu starts this for its SSH commands when
no --host is given (deploy/README.md, "Connecting").

  mgu_connect.py open [--wifi] [--hu-ip ADDR] [--iface IF] [--lport 2222]
                      [--arm-debug [--keep-armed]] [--assets DIR] [--state-dir DIR]

Progress goes to stderr. Once ssh can reach root on the unit it prints one line on stdout,

  READY <host> <port> <hu-ip> <via>

and holds the relay (and an armed session) until stdin closes or it is interrupted. Over the
hotspot ssh needs no relay, and it exits after READY. Exit 0 done, 1 the unit did not
answer, 2 bad usage or missing assets.

Default, debug-free: the unit runs a permanent field-mode sshd. Without --arm-debug nothing
here arms, disarms or resets the unit; a unit that does not answer stops it.
  - --wifi, or no ENET adapter: the DIRECT-BMW hotspot, the unit at 172.16.222.97; ssh goes
    there directly.
  - ENET (a 169.254.x adapter): the unit has a link-local address, which macOS routes only
    per interface, so ssh goes to 127.0.0.1:<lport> and a relay forwards to the unit's :22
    from a socket bound to the ENET interface. The unit's address is the first of these
    whose :22 serves an SSH banner: --hu-ip (alone when given); DID 22 17 2A read over HSFZ
    without arming (gateway identification and one ReadDataByIdentifier, no session change,
    no routine) [on-car-unconfirmed]; the last address that answered.

--arm-debug, first-time bootstrap only, over ENET: arms debug mode (RoutineControl
31 01 A0 FD with a leaf certificate minted from the assets), holds the session with
TesterPresent, relays to :22, and disarms (31 02 A0 FD) on exit unless --keep-armed. Arming
invalidates the MyBMW login and personal settings. The debug sshd starts only at boot while
armed: when no banner appears after arming, debug stays armed and it stops with the reboot
instruction.

MGU_CONNECT_FAKES names a Python file run before connecting, with this module as
`mgu_connect`; the deploy tests use it to stand in for the network.
"""
import argparse, collections, os, signal, socket, sys, threading, time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netif  # noqa: E402

WIFI_HU_IP = "172.16.222.97"        # the unit on the DIRECT-BMW hotspot (fixed)
HU_SSH_PORT = 22
DEFAULT_LPORT = 2222
ARM_WAIT_TRIES = 40                 # banner polls through the relay after arming
CACHE_NAME = "last_hu_enet_ip"
DEFAULT_STATE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "mgu-apps")
ARM_ASSETS = ("mgu_ssh_key_rsa.pem", "asset_03.bin", "asset_04.bin")   # debug_cert.ASSETS

BOOTSTRAP_HINT = (
    "Debug mode was NOT armed. Permanent (field-mode) SSH seems disabled on this HU, or the HU is\n"
    "asleep / the IP is wrong. Check the cable, wake the car, or pass --hu-ip <addr> / --wifi (hotspot).\n"
    "Only if this HU has never had permanent SSH enabled: re-run with --arm-debug to bootstrap\n"
    "(arms debug mode, which invalidates the MyBMW login and personal settings; then follow\n"
    "claude-bmw-ecu mgu18/PERSISTENT_SSH_SETUP.md).")

ARM_WARNING = ("[!] --arm-debug: arming debug mode (31 01 A0 FD). This invalidates the MyBMW login and "
               "personal settings; use it only to bootstrap permanent SSH (claude-bmw-ecu mgu18/PERSISTENT_SSH_SETUP.md).")

REBOOT_HINT = (
    "[!] debug is armed, but the HU's :22 serves no SSH banner: the debug sshd starts only at boot\n"
    "while armed. Debug is left ARMED so that a reboot brings sshd up. Reboot the HU now (UDS 11 01\n"
    "to 0x63, or hold the volume/power knob ~25 s), wait until it is back (~1 min), then run the same\n"
    "command with --arm-debug again. Do not disarm in between: that tears sshd down until the next\n"
    "armed boot.")

Link = collections.namedtuple("Link", "host port hu_ip via")
DEPS = None                         # MGU_CONNECT_FAKES may set stand-ins here


class Refused(Exception):
    """Bad usage or missing assets: nothing was sent (exit 2)."""


class Unreachable(Exception):
    """The unit did not answer (exit 1)."""


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Deps:
    """What the selection touches outside this process; the tests pass stand-ins. `op` (HSFZ)
    and `cert` (the debug certificate, which needs `cryptography`) are imported on first use."""

    def __init__(self, detect_iface=None, banner=None, op=None, cert=None):
        self.detect_iface = detect_iface or netif.detect_enet_iface
        self.banner = banner or ssh_banner
        self._op, self._cert = op, cert

    @property
    def op(self):
        if self._op is None:
            import hsfz
            self._op = hsfz
        return self._op

    @property
    def cert(self):
        if self._cert is None:
            import debug_cert
            self._cert = debug_cert
        return self._cert


# ---- banner and relay ------------------------------------------------------------------------
def ssh_banner(ip, port=None, iface=None, timeout=4):
    """The SSH banner served on ip:port (from a socket bound to iface when given), else None."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if iface:
            netif.bind_iface(s, iface)
        s.settimeout(timeout)
        s.connect((ip, HU_SSH_PORT if port is None else port))
        b = s.recv(64)
        return b.decode("latin1").strip() if b.startswith(b"SSH-") else None
    except OSError:
        return None
    finally:
        s.close()


def wait_ssh(host, port, tries, interval=1.5, timeout=2):
    """Poll host:port until it serves an SSH banner; True when it does."""
    for i in range(tries):
        if ssh_banner(host, port, timeout=timeout):
            return True
        if i < tries - 1:
            time.sleep(interval)
    return False


class Relay:
    """127.0.0.1:<lport> -> ip:port, each upstream socket bound to iface when given."""

    def __init__(self, lport, ip, port=None, iface=None):
        self.ip, self.port, self.iface = ip, HU_SSH_PORT if port is None else port, iface
        self.stop = threading.Event()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.srv.bind(("127.0.0.1", lport))
        except OSError as e:
            self.srv.close()
            raise Unreachable(f"[!] cannot listen on 127.0.0.1:{lport} ({e.strerror}); pass another --lport")
        self.srv.listen(8)
        self.srv.settimeout(0.5)
        self.lport = self.srv.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while not self.stop.is_set():
            try:
                c, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            c.settimeout(None)
            threading.Thread(target=self._handle, args=(c,), daemon=True).start()
        self.srv.close()

    def _handle(self, c):
        u = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if self.iface:
                netif.bind_iface(u, self.iface)
            u.settimeout(10)
            u.connect((self.ip, self.port))
            u.settimeout(None)
        except OSError:
            u.close()
            c.close()
            return
        pair = _Pair(c, u)
        threading.Thread(target=pair.pump, args=(c, u), daemon=True).start()
        threading.Thread(target=pair.pump, args=(u, c), daemon=True).start()

    def close(self):
        self.stop.set()


class _Pair:
    """One relayed connection: an end of stream is passed on as a half-close, an error closes
    both directions, and the sockets close once both directions have ended."""

    def __init__(self, a, b):
        self.socks, self.ended, self.lock = (a, b), 0, threading.Lock()

    def pump(self, a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                b.sendall(d)
            b.shutdown(socket.SHUT_WR)
        except OSError:
            for s in self.socks:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        with self.lock:
            self.ended += 1
            if self.ended == 2:
                for s in self.socks:
                    s.close()


# ---- the last address that answered -------------------------------------------------------
class Cache:
    """The unit's last ENET address that answered: written to <state>/last_hu_enet_ip; read from
    there and from last_hu_enet_ip beside the assets folder (claude-bmw-ecu keeps one in
    mgu18/tool_analysis/)."""

    def __init__(self, state_dir, assets=None):
        self.file = os.path.join(state_dir, CACHE_NAME)
        self.files = [self.file]
        if assets:
            self.files.append(os.path.join(os.path.dirname(os.path.abspath(assets)), CACHE_NAME))

    def load(self):
        out = []
        for f in self.files:
            try:
                with open(f) as fh:
                    ip = fh.read().strip()
            except OSError:
                continue
            if ip and ip not in [x[1] for x in out]:
                out.append((f, ip))
        return out

    def save(self, ip):
        try:
            os.makedirs(os.path.dirname(self.file), exist_ok=True)
            with open(self.file, "w") as fh:
                fh.write(ip + "\n")
        except OSError as e:
            log(f"[.] could not cache the HU IP in {self.file} ({e})")


# ---- selection (debug-free) ---------------------------------------------------------------
def read_hu_ip_unarmed(iface, op):
    """The unit's IPv4 from DID 22 17 2A, sent alone (no 10 03, no 31 01 ..) so debug stays
    disarmed. [on-car-unconfirmed] that the unit answers this DID while debug is disarmed."""
    gw = op.discover_gateway(iface)
    if not gw:
        log("[.] HU IP via DID 172A: no ENET gateway answered HSFZ identification (:6811)")
        return None
    hz = None
    try:
        hz = op.Hsfz(gw, iface=iface)
        r = hz.request(bytes.fromhex("22172A"), wait=8)
    except Exception as e:
        log(f"[.] HU IP via DID 172A: request to gateway {gw} failed ({e})")
        return None
    finally:
        if hz:
            hz.close()
    if r[:1] == b"\x7f":
        log(f"[.] HU IP via DID 172A: negative response {r[:3].hex(' ')} from gateway {gw}")
        return None
    if not r.startswith(b"\x62\x17\x2a") or len(r) < 8:
        log(f"[.] HU IP via DID 172A: unexpected response {r[:8].hex(' ')}")
        return None
    ip = ".".join(str(b) for b in r[4:8])            # 62 17 2A 00 <AA BB CC DD>
    log(f"[.] HU IP via DID 172A (unarmed, gateway {gw}): {ip}")
    return ip


def resolve_enet_hu(iface, hu_ip, cache, deps):
    """The unit's ENET address whose :22 serves SSH over iface, or None."""
    if hu_ip:
        cands = [(hu_ip, "--hu-ip")]
    else:
        cands = []
        ip = read_hu_ip_unarmed(iface, deps.op)
        if ip:
            cands.append((ip, "DID 172A"))
        for f, cached in cache.load():
            if cached != ip:
                cands.append((cached, f"cache {f}"))
        if not cands:
            log("[.] no HU IP candidate (DID 172A unavailable, nothing cached)")
    for ip, src in cands:
        b = deps.banner(ip, HU_SSH_PORT, iface)
        log(f"[.] HU {ip} ({src}) on {iface}: " + (f"sshd up — {b}" if b else "no SSH banner on :22"))
        if b:
            return ip
    return None


def select(wifi=False, iface=None, hu_ip=None, cache=None, deps=None):
    """The unit's sshd without arming anything: (address, ENET interface, or None for the
    hotspot). Raises Unreachable when no candidate serves an SSH banner."""
    deps = deps or Deps()
    if not wifi and not iface:
        iface = deps.detect_iface()
        if not iface:
            log("[.] no 169.254.x ENET adapter; trying the DIRECT-BMW hotspot")
            wifi = True
    if wifi:
        ip = hu_ip or WIFI_HU_IP
        b = deps.banner(ip, HU_SSH_PORT, None)
        log(f"[.] HU {ip} (Wi-Fi): " + (f"sshd up — {b}" if b else "no SSH banner on :22"))
        if not b:
            raise Unreachable(f"[!] no SSH on {ip}:{HU_SSH_PORT} over Wi-Fi (joined DIRECT-BMW?).\n{BOOTSTRAP_HINT}")
        return ip, None
    try:
        socket.if_nametoindex(iface)
    except OSError:
        raise Refused(f"[!] unknown ENET interface {iface!r}; pass a valid --iface, or --wifi for the DIRECT-BMW hotspot.")
    ip = resolve_enet_hu(iface, hu_ip, cache, deps)
    if not ip:
        raise Unreachable(f"[!] no SSH on the HU over ENET ({iface}).\n{BOOTSTRAP_HINT}")
    cache.save(ip)
    return ip, iface


class Direct:
    """The default session: select, then relay over ENET."""

    def __init__(self, wifi, iface, hu_ip, lport, cache, deps=None):
        self.args = (wifi, iface, hu_ip)
        self.lport, self.cache, self.deps = lport, cache, deps or Deps()
        self.relay = None

    def open(self):
        wifi, iface, hu_ip = self.args
        ip, iface = select(wifi, iface, hu_ip, self.cache, self.deps)
        if iface is None:
            return Link(ip, HU_SSH_PORT, ip, "wifi")
        self.relay = Relay(self.lport, ip, HU_SSH_PORT, iface)
        if not wait_ssh("127.0.0.1", self.relay.lport, 5):
            self.close()
            raise Unreachable(f"[!] HU {ip}:22 answers on {iface} but not via the relay on 127.0.0.1:{self.relay.lport}")
        return Link("127.0.0.1", self.relay.lport, ip, f"enet {iface}")

    def close(self):
        if self.relay:
            self.relay.close()


# ---- --arm-debug (first-time bootstrap only) -------------------------------------------------
def arm_debug(hz, assets, op, cert):
    """Arms debug mode: extended session, device challenge, leaf certificate, A0FD; the unit's
    address from DID 22 17 2A."""
    hz.request(bytes.fromhex("1003"))
    ch = hz.request(bytes.fromhex("3101A671"))
    cn = "".join(chr(c) for c in ch if chr(c).upper() in "0123456789ABCDEF").upper()[-64:]
    leaf, pmo_cert = cert.leaf_for(cn, assets)
    op.expect(hz.request(bytes.fromhex("3101A0FD") + leaf + pmo_cert), "71 01 A0 FD", "A0FD")
    ipr = op.expect(hz.request(bytes.fromhex("22172A")), "62 17 2A", "DID172A")
    return ".".join(str(b) for b in ipr[4:8])


class Armed:
    """--arm-debug: arm over ENET, hold with TesterPresent, relay to :22; close() disarms
    (31 02 A0 FD) unless keep_armed."""

    def __init__(self, iface, lport, assets, cache, keep_armed, deps=None, tries=ARM_WAIT_TRIES, interval=1.5):
        self.iface, self.lport, self.assets, self.cache = iface, lport, assets, cache
        self.keep_armed, self.deps, self.tries, self.interval = keep_armed, deps or Deps(), tries, interval
        self.hz = self.relay = None
        self.stop = threading.Event()
        self.lock = threading.Lock()          # the keepalive and the disarm share the HSFZ socket

    def open(self):
        log(ARM_WARNING)
        op = self.deps.op
        iface = self.iface or self.deps.detect_iface()
        if not iface:
            raise Unreachable("[!] --arm-debug runs over ENET: no 169.254.x adapter found (cable connected? or pass --iface).")
        gw = op.discover_gateway(iface)
        if not gw:
            raise Unreachable("[!] no ENET gateway answered HSFZ identification (:6811); ENET connected? car awake?")
        self.hz = op.Hsfz(gw, iface=iface)
        try:
            hu = arm_debug(self.hz, self.assets, op, self.deps.cert)
        except BaseException:
            self._disarm()
            self.hz.close()
            raise
        self.cache.save(hu)
        log(f"[+] debug armed; HU {hu}; gateway {gw}; iface {iface}")
        threading.Thread(target=self._keepalive, daemon=True).start()
        try:
            self.relay = Relay(self.lport, hu, HU_SSH_PORT, iface)
        except BaseException:
            self.close()
            raise
        if not wait_ssh("127.0.0.1", self.relay.lport, self.tries, self.interval):
            self.stop.set()
            self.relay.close()
            self.hz.close()
            raise Unreachable(REBOOT_HINT)
        return Link("127.0.0.1", self.relay.lport, hu, f"enet {iface}, debug armed")

    def _keepalive(self):
        while not self.stop.is_set():
            try:
                with self.lock:
                    self.hz.request(bytes.fromhex("3E00"), wait=3)
            except Exception:
                pass
            self.stop.wait(2)

    def _disarm(self):
        with self.lock:
            try:
                self.hz.request(bytes.fromhex("3102A0FD"))
                log("[+] debug disarmed (31 02 A0 FD)")
            except Exception as e:
                log(f"[!] disarm (31 02 A0 FD) failed ({e}); debug may still be armed")

    def close(self):
        self.stop.set()
        if self.relay:
            self.relay.close()
        if self.hz:
            if self.keep_armed:
                log("[.] --keep-armed: debug stays armed")
            else:
                self._disarm()
            self.hz.close()


# ---- command line ---------------------------------------------------------------------------
def missing_assets(assets, names):
    return [n for n in names if not os.path.isfile(os.path.join(assets, n))]


def _interrupt(*_):
    raise KeyboardInterrupt


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mgu_connect.py")
    ap.add_argument("command", choices=["open"])
    ap.add_argument("--wifi", action="store_true",
                    help="the DIRECT-BMW hotspot, 172.16.222.97 (also when no ENET adapter is present)")
    ap.add_argument("--hu-ip", dest="hu_ip", default=None, help="the HU's address (skips DID 172A and the cache)")
    ap.add_argument("--iface", default=None, help="ENET interface (default: the 169.254.x adapter)")
    ap.add_argument("--lport", type=int, default=DEFAULT_LPORT, help="local relay port (ENET)")
    ap.add_argument("--arm-debug", dest="arm_debug", action="store_true",
                    help="BOOTSTRAP ONLY: arm debug mode over ENET (invalidates MyBMW login / personal settings)")
    ap.add_argument("--keep-armed", dest="keep_armed", action="store_true",
                    help="with --arm-debug: leave debug armed on exit")
    ap.add_argument("--assets", default=None, help="the folder with mgu_ssh_key_rsa.pem, asset_03.bin, asset_04.bin")
    ap.add_argument("--state-dir", dest="state_dir", default=DEFAULT_STATE_DIR)
    a = ap.parse_args(argv)
    if a.arm_debug and (a.wifi or a.hu_ip):
        ap.error("--arm-debug runs over ENET and reads the HU IP itself; drop --wifi/--hu-ip")
    if a.keep_armed and not a.arm_debug:
        ap.error("--keep-armed applies to --arm-debug only")
    fakes = os.environ.get("MGU_CONNECT_FAKES")
    if fakes:
        with open(fakes) as f:
            exec(compile(f.read(), fakes, "exec"), {"mgu_connect": sys.modules[__name__], "__file__": fakes})
    cache = Cache(a.state_dir, a.assets)
    if a.arm_debug:
        gone = missing_assets(a.assets, ARM_ASSETS) if a.assets else list(ARM_ASSETS)
        if gone:
            log(f"[!] --arm-debug needs {', '.join(ARM_ASSETS)} in the assets folder; missing in "
                f"{a.assets or '(no --assets given)'}: {', '.join(gone)}")
            return 2
        session = Armed(a.iface, a.lport, a.assets, cache, a.keep_armed, DEPS)
    else:
        session = Direct(a.wifi, a.iface, a.hu_ip, a.lport, cache, DEPS)
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        link = session.open()
    except Refused as e:
        log(str(e))
        return 2
    except Unreachable as e:
        log(str(e))
        return 1
    except ImportError as e:
        log(f"[!] {e}; --arm-debug needs the Python package `cryptography` (pip3 install cryptography)")
        return 2
    except KeyboardInterrupt:
        return 1
    except Exception as e:
        log(f"[!] {e}")
        return 1
    print(f"READY {link.host} {link.port} {link.hu_ip} {link.via}", flush=True)
    if link.via == "wifi":
        return 0
    try:
        sys.stdin.buffer.read()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        session.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
