'use strict';
/**
 * The published catalog (release/README.md) and what it means for this head
 * unit: parse and check a catalog, verify its signature, and compare it
 * with what is installed. Node 8; no I/O.
 */
const crypto = require('crypto');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = ['app', 'tool'];

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}

/* The signature covers JSON.stringify of the catalog without "signature". */
function verifySignature(catalog, publicKeyPem) {
    const sig = catalog.signature;
    if (!sig || sig.alg !== 'ecdsa-p256-sha256' || typeof sig.value !== 'string') {
        return false;
    }
    const body = Object.assign({}, catalog);
    delete body.signature;
    try {
        return crypto.createVerify('SHA256').update(JSON.stringify(body))
            .verify(publicKeyPem, Buffer.from(sig.value, 'base64'));
    } catch (e) {
        return false;
    }
}

/* Parses catalog text; throws with a reason when it is unusable. With a
 * public key, only a catalog it signed is accepted. */
function parse(text, publicKeyPem) {
    let catalog;
    try {
        catalog = JSON.parse(text);
    } catch (e) {
        throw new Error('catalog is not JSON');
    }
    if (!catalog || catalog.schema !== 1 || !Array.isArray(catalog.components)) {
        throw new Error('catalog schema is not 1');
    }
    if (publicKeyPem && !verifySignature(catalog, publicKeyPem)) {
        throw new Error('catalog signature is missing or invalid');
    }
    const seen = new Set();
    catalog.components.forEach((c) => {
        const a = c && c.artifact;
        if (!c || !ID.test(c.id) || KINDS.indexOf(c.kind) < 0 || !SEMVER.test(c.version) ||
            !a || typeof a.name !== 'string' || a.name !== `${c.id}@${c.version}.tgz` ||
            !SHA256.test(a.sha256) || !(a.size > 0)) {
            throw new Error(`catalog entry ${c && c.id} is malformed`);
        }
        if (seen.has(c.id)) {
            throw new Error(`catalog lists ${c.id} twice`);
        }
        seen.add(c.id);
    });
    return catalog;
}

/* One row per catalog component, with what is installed of it.
 * status: installed | update | available | newer (a local build ahead of
 * the catalog). */
function plan(catalog, installed) {
    const have = new Map(installed.map((i) => [i.id, i]));
    return (catalog ? catalog.components : []).map((c) => {
        const i = have.get(c.id);
        let status = 'available';
        if (i) {
            const cmp = compareVersions(i.version, c.version);
            status = cmp === 0 ? 'installed' : cmp < 0 ? 'update' : 'newer';
        }
        return {
            id: c.id,
            kind: c.kind,
            title: c.title || c.id,
            version: c.version,
            installed: i ? i.version : null,
            size: c.artifact.size,
            status
        };
    });
}

module.exports = { parse, plan, compareVersions, verifySignature, SEMVER };
