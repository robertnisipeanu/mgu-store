'use strict';
/**
 * A server's certificate chain checked as Node checks it, except for the
 * validity dates, for a head unit whose clock may be days off. Node 8 has
 * neither an X509 API nor a way to set the verification time, so the
 * certificates are parsed here and every signature is checked with
 * crypto.createVerify. Node 8; no I/O but nodeRoots().
 *
 *   verifyChain(chain, anchors) -> null | '<why not>'
 *       chain: the DER certificates the server presented, its own first;
 *       anchors: the trusted roots (DER; only self-issued ones count). null when a path runs from the
 *       server's certificate to an anchor in which every signature checks
 *       out, every issuer is a CA allowed to issue at its depth (basic
 *       constraints, path length, key usage), every certificate is fit for a
 *       TLS server (extended key usage; the server's own also key usage and
 *       Netscape cert type) and none below the anchor has a critical
 *       extension left unchecked. notBefore and notAfter are never read. A
 *       path with name constraints is refused, and so is a chain that takes
 *       more than MAX_SIGNATURES signature checks to settle. The host name is
 *       the caller's to check (tls.checkServerIdentity).
 *   pemCerts(text) -> [DER]
 *       the certificates of a PEM text
 *   nodeRoots() -> [DER]
 *       the roots Node trusts by default: the PEM certificates built into
 *       its binary (Node 8 has no API that lists them)
 */
const fs = require('fs');
const crypto = require('crypto');

const MAX_DEPTH = 8;
// a real chain settles in a few; a crafted one could otherwise try every order of its certificates
const MAX_SIGNATURES = 64;

const OID = {
    basicConstraints: '2.5.29.19',
    keyUsage: '2.5.29.15',
    extKeyUsage: '2.5.29.37',
    subjectAltName: '2.5.29.17',
    nameConstraints: '2.5.29.30',
    certificatePolicies: '2.5.29.32',
    nsCertType: '2.16.840.1.113730.1.1',
    serverAuth: '1.3.6.1.5.5.7.3.1'
};

/* Critical extensions this check reads; any other critical one fails it. */
const CHECKED = [OID.basicConstraints, OID.keyUsage, OID.extKeyUsage, OID.subjectAltName, OID.certificatePolicies];

/* Signature algorithm -> the digest createVerify takes (RSA PKCS#1 v1.5 and ECDSA). */
const SIG = {
    '1.2.840.113549.1.1.11': 'RSA-SHA256',
    '1.2.840.113549.1.1.12': 'RSA-SHA384',
    '1.2.840.113549.1.1.13': 'RSA-SHA512',
    '1.2.840.10045.4.3.2': 'sha256',
    '1.2.840.10045.4.3.3': 'sha384',
    '1.2.840.10045.4.3.4': 'sha512'
};

/* Key usage bits (first byte of the BIT STRING). */
const KU_DIGITAL_SIGNATURE = 0x80;
const KU_KEY_ENCIPHERMENT = 0x20;
const KU_KEY_AGREEMENT = 0x08;
const KU_KEY_CERT_SIGN = 0x04;
// Netscape cert type: SSL server
const NS_SSL_SERVER = 0x40;

/* ---- DER ------------------------------------------------------------------ */

/* The element at pos, which must end by limit: { tag, start, body, end }. */
function tlv(buf, pos, limit) {
    if (pos + 2 > limit) {
        throw new Error('truncated');
    }
    const tag = buf[pos];
    if ((tag & 0x1f) === 0x1f) {
        throw new Error('long tag');
    }
    let len = buf[pos + 1];
    let body = pos + 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n === 0 || n > 4 || body + n > limit) {
            throw new Error('bad length');
        }
        len = 0;
        for (let i = 0; i < n; i++) {
            len = len * 256 + buf[body + i];
        }
        body += n;
    }
    if (body + len > limit) {
        throw new Error('truncated');
    }
    return { tag, start: pos, body, end: body + len };
}

/* The elements inside e, in order. */
function children(buf, e) {
    const out = [];
    for (let p = e.body; p < e.end;) {
        const c = tlv(buf, p, e.end);
        out.push(c);
        p = c.end;
    }
    return out;
}

function expect(e, tag, what) {
    if (!e || e.tag !== tag) {
        throw new Error(`bad ${what}`);
    }
    return e;
}

function oid(buf, e) {
    expect(e, 0x06, 'OID');
    const b = buf.slice(e.body, e.end);
    if (!b.length) {
        throw new Error('bad OID');
    }
    const parts = [];
    let v = 0;
    for (let i = 0; i < b.length; i++) {
        v = v * 128 + (b[i] & 0x7f);
        if (!(b[i] & 0x80)) {
            if (!parts.length) {
                parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
            } else {
                parts.push(v);
            }
            v = 0;
        } else if (i === b.length - 1) {
            throw new Error('bad OID');
        }
    }
    return parts.join('.');
}

/* A BIT STRING's bytes, with no unused bits allowed when exact. */
function bits(buf, e, exact) {
    expect(e, 0x03, 'BIT STRING');
    if (e.end === e.body || buf[e.body] > 7 || (exact && buf[e.body] !== 0)) {
        throw new Error('bad BIT STRING');
    }
    return buf.slice(e.body + 1, e.end);
}

/* ---- certificates --------------------------------------------------------- */

/* The parts of a DER certificate this check reads; throws when it is not one. */
function parse(der) {
    const top = expect(tlv(der, 0, der.length), 0x30, 'certificate');
    if (top.end !== der.length) {
        throw new Error('trailing bytes');
    }
    const [tbsE, algE, sigE, extra] = children(der, top);
    if (extra) {
        throw new Error('bad certificate');
    }
    expect(tbsE, 0x30, 'tbsCertificate');
    expect(algE, 0x30, 'signatureAlgorithm');
    const f = children(der, tbsE);
    let i = 0;
    let version = 1;
    if (f[i] && f[i].tag === 0xa0) {
        const v = expect(children(der, f[i])[0], 0x02, 'version');
        version = der[v.end - 1] + 1;
        i++;
    }
    expect(f[i++], 0x02, 'serial number');
    const innerAlg = expect(f[i++], 0x30, 'signature');
    const issuer = expect(f[i++], 0x30, 'issuer');
    expect(f[i++], 0x30, 'validity');
    const subject = expect(f[i++], 0x30, 'subject');
    const spki = expect(f[i++], 0x30, 'subjectPublicKeyInfo');
    const ext = {};
    for (; i < f.length; i++) {
        if (f[i].tag !== 0xa3) {
            continue; // issuer and subject unique ids
        }
        if (version !== 3) {
            throw new Error('extensions in a v1 or v2 certificate');
        }
        children(der, expect(children(der, f[i])[0], 0x30, 'extensions')).forEach((x) => {
            const [idE, a, b] = children(der, expect(x, 0x30, 'extension'));
            const id = oid(der, idE);
            const critical = a && a.tag === 0x01 ? der[a.body] !== 0 : false;
            const value = expect(a && a.tag === 0x01 ? b : a, 0x04, 'extension value');
            if (ext[id]) {
                throw new Error(`extension ${id} twice`);
            }
            ext[id] = { critical, der: der.slice(value.body, value.end) };
        });
    }
    const algBytes = der.slice(algE.start, algE.end);
    if (!algBytes.equals(der.slice(innerAlg.start, innerAlg.end))) {
        throw new Error('signature algorithms differ');
    }
    return {
        der,
        version,
        tbs: der.slice(tbsE.start, tbsE.end),
        sigAlg: oid(der, children(der, algE)[0]),
        sig: bits(der, sigE, true),
        issuer: der.slice(issuer.start, issuer.end),
        subject: der.slice(subject.start, subject.end),
        spki: der.slice(spki.start, spki.end),
        ext,
        bc: basicConstraints(ext[OID.basicConstraints]),
        ku: keyUsage(ext[OID.keyUsage]),
        ns: keyUsage(ext[OID.nsCertType]),
        eku: extKeyUsage(ext[OID.extKeyUsage])
    };
}

/* { ca, pathLen } or null when absent. */
function basicConstraints(x) {
    if (!x) {
        return null;
    }
    const s = expect(tlv(x.der, 0, x.der.length), 0x30, 'basic constraints');
    let ca = false;
    let pathLen;
    children(x.der, s).forEach((c) => {
        if (c.tag === 0x01) {
            ca = x.der[c.body] !== 0;
        } else if (c.tag === 0x02) {
            if (c.end - c.body > 4 || x.der[c.body] & 0x80) {
                throw new Error('bad path length');
            }
            pathLen = x.der.slice(c.body, c.end).reduce((v, b) => v * 256 + b, 0);
        } else {
            throw new Error('bad basic constraints');
        }
    });
    return { ca, pathLen };
}

/* The first byte of a key usage or Netscape cert type, or null when absent. */
function keyUsage(x) {
    if (!x) {
        return null;
    }
    const b = bits(x.der, tlv(x.der, 0, x.der.length), false);
    return b.length ? b[0] : 0;
}

/* The extended key usage OIDs, or null when absent. */
function extKeyUsage(x) {
    if (!x) {
        return null;
    }
    return children(x.der, expect(tlv(x.der, 0, x.der.length), 0x30, 'extended key usage')).map((e) => oid(x.der, e));
}

function publicKeyPem(spki) {
    const b64 = spki.toString('base64').replace(/.{64}/g, '$&\n');
    return `-----BEGIN PUBLIC KEY-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END PUBLIC KEY-----\n`;
}

/* Whether issuer's key signed cert; false once budget.left is spent. */
function signedBy(cert, issuer, budget) {
    const md = SIG[cert.sigAlg];
    if (!md || budget.left-- <= 0) {
        return false;
    }
    try {
        return crypto.createVerify(md).update(cert.tbs).verify(publicKeyPem(issuer.spki), cert.sig);
    } catch (e) {
        return false;
    }
}

/* Why c, below its anchor, is not fit for a TLS server's chain; null if it is. */
function unfit(c) {
    if (c.ext[OID.nameConstraints]) {
        return 'name constraints';
    }
    const unknown = Object.keys(c.ext).find((id) => c.ext[id].critical && CHECKED.indexOf(id) < 0);
    if (unknown) {
        return `critical extension ${unknown}`;
    }
    if (c.eku && c.eku.indexOf(OID.serverAuth) < 0) {
        return 'not for TLS servers';
    }
    return null;
}

/* Whether issuer may sign a certificate with depth intermediates below it
 * (0: it signs the server's own). Anchors are trusted as they are, but for
 * being a CA and its constraints. */
function mayIssue(issuer, depth, anchor) {
    if (issuer.version === 3) {
        if (!issuer.bc || !issuer.bc.ca) {
            return false;
        }
    } else if (!(anchor && issuer.subject.equals(issuer.issuer))) {
        return false;
    }
    if (issuer.bc && issuer.bc.pathLen !== undefined && issuer.bc.pathLen < depth) {
        return false;
    }
    if (issuer.ku !== null && !(issuer.ku & KU_KEY_CERT_SIGN)) {
        return false;
    }
    if (anchor) {
        return !issuer.ext[OID.nameConstraints] && !(issuer.eku && issuer.eku.indexOf(OID.serverAuth) < 0);
    }
    return !unfit(issuer);
}

/* Whether a path runs from cert (depth certificates above the server's) to
 * an anchor through the certificates in pool. */
function reaches(cert, depth, pool, anchors, budget) {
    if (depth > 0 && anchors.some((a) => a.der.equals(cert.der))) {
        return true;
    }
    if (depth >= MAX_DEPTH) {
        return false;
    }
    if (anchors.some((a) => a.subject.equals(cert.issuer) && mayIssue(a, depth, true) && signedBy(cert, a, budget))) {
        return true;
    }
    return pool.some((c, i) => c.subject.equals(cert.issuer) && mayIssue(c, depth, false) && signedBy(cert, c, budget) &&
        reaches(c, depth + 1, pool.filter((_, j) => j !== i), anchors, budget));
}

function verifyChain(chain, anchors) {
    let certs;
    try {
        certs = chain.map(parse);
    } catch (e) {
        return `unreadable certificate (${e.message})`;
    }
    if (!certs.length) {
        return 'no certificate';
    }
    // a trust anchor is a self-issued root, as in OpenSSL's default chain building
    const roots = anchors.map((a) => {
        try {
            return parse(a);
        } catch (e) {
            return null;
        }
    }).filter((a) => a && a.subject.equals(a.issuer));
    const leaf = certs[0];
    const why = unfit(leaf);
    if (why) {
        return `server certificate: ${why}`;
    }
    if (leaf.ku !== null && !(leaf.ku & (KU_DIGITAL_SIGNATURE | KU_KEY_ENCIPHERMENT | KU_KEY_AGREEMENT))) {
        return 'server certificate: key usage';
    }
    if (leaf.ns !== null && !(leaf.ns & NS_SSL_SERVER)) {
        return 'server certificate: Netscape cert type';
    }
    return reaches(leaf, 0, certs.slice(1), roots, { left: MAX_SIGNATURES }) ? null : 'no trusted chain with valid signatures';
}

function pemCerts(text) {
    return (String(text).match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) || [])
        .map((p) => Buffer.from(p.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'));
}

let builtIn = null;

function nodeRoots() {
    if (!builtIn) {
        builtIn = pemCerts(fs.readFileSync(process.execPath, 'latin1'));
    }
    return builtIn;
}

module.exports = { verifyChain, pemCerts, nodeRoots, _parse: parse };
