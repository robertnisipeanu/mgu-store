"""The leaf certificate that arms the head unit's debug mode (RoutineControl 31 01 A0 FD).

Subject CN = the unit's device id (from the 31 01 A6 71 challenge), public key = the SSH
enrollment key, issued and signed (SHA256withRSA) by the PMO intermediate CA. The unit checks
the chain to its pinned debug-token CA and CN == its device id. The key and certificate
material comes from the assets folder; it is never kept in this repository.

Needs the `cryptography` package.
"""
import base64, hashlib, os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ENROLL_KEY = "mgu_ssh_key_rsa.pem"  # its public key goes in the leaf; root's SSH key
PMO_CERT = "asset_03.bin"           # PMO intermediate CA certificate (PEM)
PMO_KEY = "asset_04.bin"            # PMO intermediate CA private key (PEM)
ASSETS = (ENROLL_KEY, PMO_CERT, PMO_KEY)


# ---- DER ----------------------------------------------------------------------------------
def _len(n):
    if n < 128:
        return bytes([n])
    b = []
    while n:
        b.append(n & 0xFF)
        n >>= 8
    b.reverse()
    return bytes([0x80 | len(b)]) + bytes(b)


def TLV(tag, content): return bytes([tag]) + _len(len(content)) + content
def SEQ(*items): return TLV(0x30, b"".join(items))
def SET(item): return TLV(0x31, item)
def OID(hexstr): return TLV(0x06, bytes.fromhex(hexstr.replace(" ", "")))
def NULL(): return TLV(0x05, b"")
def BITSTR(content): return TLV(0x03, b"\x00" + content)
def OCT(content): return TLV(0x04, content)
def UTCTime(s): return TLV(0x17, s.encode("ascii"))
def CTX(n, content): return TLV(0xA0 | n, content)    # [n] EXPLICIT
def CTXP(n, content): return TLV(0x80 | n, content)   # [n] primitive


def INT(raw):
    """Big-endian magnitude -> DER INTEGER."""
    if not raw:
        raw = b"\x00"
    i = 0
    while i < len(raw) - 1 and raw[i] == 0:
        i += 1
    raw = raw[i:]
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return TLV(0x02, raw)


OID_RSA = "2A 86 48 86 F7 0D 01 01 01"          # rsaEncryption
OID_SHA256RSA = "2A 86 48 86 F7 0D 01 01 0B"    # sha256WithRSAEncryption


def _attr(oid, tag, val): return SET(SEQ(OID(oid), TLV(tag, val.encode("utf-8"))))


def _name_issuer():
    return SEQ(_attr("55 04 06", 0x13, "DE"), _attr("55 04 08", 0x13, "Bavaria"),
               _attr("55 04 07", 0x13, "Vehicle"), _attr("55 04 0A", 0x13, "BMW AG"),
               _attr("55 04 0B", 0x13, "Head Unit"),
               _attr("55 04 03", 0x13, "PMOIntermediateCA UID=3939fa9a-c199-450a-9d6b-5e2341ad3641"))


def _name_subject(cn):
    return SEQ(_attr("55 04 06", 0x13, "DE"), _attr("55 04 08", 0x0C, "Bavaria"),
               _attr("55 04 07", 0x0C, "Vehicle"), _attr("55 04 0A", 0x0C, "BMW AG"),
               _attr("55 04 0B", 0x0C, "Head Unit"), _attr("55 04 03", 0x0C, cn))


def _ext(oid, critical, value):
    return SEQ(OID(oid), TLV(0x01, b"\xff"), OCT(value)) if critical else SEQ(OID(oid), OCT(value))


def _rsa_pub_seq(pub):
    """SEQ { INTEGER modulus, INTEGER exponent }"""
    nums = pub.public_numbers()
    nb = nums.n.to_bytes((nums.n.bit_length() + 7) // 8, "big")
    eb = nums.e.to_bytes((nums.e.bit_length() + 7) // 8, "big")
    return SEQ(INT(nb), INT(eb))


def mint_leaf(device_cn, enroll_pub, pmo_priv):
    """The leaf certificate as PEM with CRLF line ends, the form the unit accepts."""
    pub_seq = _rsa_pub_seq(enroll_pub)
    ski = hashlib.sha1(pub_seq).digest()
    aki = hashlib.sha1(_rsa_pub_seq(pmo_priv.public_key())).digest()
    sigalg = SEQ(OID(OID_SHA256RSA), NULL())
    spki = SEQ(SEQ(OID(OID_RSA), NULL()), BITSTR(pub_seq))
    exts = SEQ(
        _ext("55 1D 13", False, SEQ()),                                         # basicConstraints CA:FALSE
        _ext("55 1D 0F", True, bytes.fromhex("030205E0")),                      # keyUsage
        _ext("55 1D 25", False, SEQ(OID("2B 06 01 05 05 07 03 02"))),           # EKU clientAuth
        _ext("60 86 48 01 86 F8 42 01 01", False, bytes.fromhex("03020780")),   # netscape cert-type
        _ext("55 1D 0E", False, OCT(ski)),                                      # subjectKeyIdentifier
        _ext("55 1D 23", False, SEQ(CTXP(0, aki))),                             # authorityKeyIdentifier
    )
    tbs = SEQ(CTX(0, INT(b"\x02")), INT(bytes([1, 169])), sigalg, _name_issuer(),
              SEQ(UTCTime("700101000100Z"), UTCTime("380930235900Z")),
              _name_subject(device_cn), spki, CTX(3, exts))
    sig = pmo_priv.sign(tbs, padding.PKCS1v15(), hashes.SHA256())
    b = base64.b64encode(SEQ(tbs, sigalg, BITSTR(sig))).decode()
    pem = ("-----BEGIN CERTIFICATE-----\r\n" + "\r\n".join(b[i:i + 64] for i in range(0, len(b), 64)) +
           "\r\n-----END CERTIFICATE-----\r\n")
    return pem.encode("ascii")


def leaf_for(device_cn, assets):
    """(leaf PEM, PMO certificate PEM) for device_cn, from the assets folder."""
    def read(name):
        with open(os.path.join(assets, name), "rb") as f:
            return f.read()
    enroll = serialization.load_pem_private_key(read(ENROLL_KEY), None)
    pmo_key = serialization.load_pem_private_key(read(PMO_KEY), None)
    return mint_leaf(device_cn, enroll.public_key(), pmo_key), read(PMO_CERT)
