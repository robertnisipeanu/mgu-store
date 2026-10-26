'use strict';
/**
 * Catalogs (release/README.md) and what they mean for this head unit: parse
 * and check a catalog (schema 1, or 2 with build / requires / optional /
 * uninstallable / mguHmi / mguProvides), and compare the components every source lists with what
 * is installed. A `signature` in a catalog is ignored: trust is HTTPS (and
 * a token that reaches it) to the source the owner added, and every
 * download is checked against the size and sha256 it lists. Node 8; no I/O.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = ['app', 'tool'];
const HMIS = ['ID7', 'ID8'];
const PROVIDES = /^[a-z0-9][a-z0-9-]{0,31}$/;

/* mguHmi: the head units a component is for, ["ID7"], ["ID8"] or both;
 * null when it does not say. */
function hmiList(v) {
    if (v === undefined || v === null) {
        return null;
    }
    if (!Array.isArray(v) || !v.length || v.some((h, i) => HMIS.indexOf(h) < 0 || v.indexOf(h) !== i)) {
        throw new Error('mguHmi must list "ID7" and/or "ID8"');
    }
    return v.slice().sort();
}

/* Whether a component is for the unit: yes, no, or unknown (it does not
 * say, or the unit is not known). */
function compat(hmis, unitHmi) {
    if (!hmis || !unitHmi) {
        return 'unknown';
    }
    return hmis.indexOf(unitHmi) >= 0 ? 'yes' : 'no';
}

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

/* Checks one entry's schema-2 fields (requires, build, optional,
 * uninstallable) and gives them their defaults; throws with a reason. An
 * icon (a PNG: a URL or path its source resolves, with an optional
 * iconSha256) becomes { ref, sha256 }, or null when it is not usable. */
function checkExtras(c) {
    const where = `catalog entry ${c.id}`;
    if (c.build !== undefined && c.build !== null && !(c.build === 'unit' && c.kind === 'app')) {
        throw new Error(`${where}: build must be "unit", for an app`);
    }
    const req = c.requires === undefined || c.requires === null ? {} : c.requires;
    if (typeof req !== 'object' || Array.isArray(req) ||
        Object.keys(req).some((k) => !ID.test(k) || k === c.id || !SEMVER.test(req[k]))) {
        throw new Error(`${where}: requires must map other component ids to x.y.z versions`);
    }
    ['optional', 'uninstallable'].forEach((k) => {
        if (c[k] !== undefined && typeof c[k] !== 'boolean') {
            throw new Error(`${where}: ${k} must be true or false`);
        }
    });
    let hmi;
    try {
        hmi = hmiList(c.mguHmi);
    } catch (e) {
        throw new Error(`${where}: ${e.message}`);
    }
    if (c.mguProvides !== undefined && c.mguProvides !== null && !(c.kind === 'tool' && PROVIDES.test(c.mguProvides))) {
        throw new Error(`${where}: mguProvides is one lower-case name, for a tool`);
    }
    const ref = typeof c.icon === 'string' ? c.icon : c.icon && typeof c.icon.ref === 'string' ? c.icon.ref : null;
    const isha = c.icon && c.icon.sha256 !== undefined ? c.icon.sha256 : c.iconSha256;
    delete c.iconSha256;
    return Object.assign(c, {
        icon: ref && ref.length <= 500 && (isha === undefined || isha === null || SHA256.test(isha)) ? { ref, sha256: isha || null } : null,
        author: typeof c.author === 'string' ? c.author.slice(0, 80) : '',
        mguHmi: hmi,
        mguProvides: c.mguProvides || null,
        service: c.service || null,
        build: c.build || null,
        requires: req,
        optional: !!c.optional,
        uninstallable: !!c.uninstallable,
        title: typeof c.title === 'string' && c.title ? c.title : c.id,
        description: typeof c.description === 'string' ? c.description : ''
    });
}

/* Parses catalog text; throws with a reason when it is unusable. */
function parse(text) {
    let catalog;
    try {
        catalog = JSON.parse(text);
    } catch (e) {
        throw new Error('catalog is not JSON');
    }
    if (!catalog || (catalog.schema !== 1 && catalog.schema !== 2) || !Array.isArray(catalog.components)) {
        throw new Error('catalog schema is not 1 or 2');
    }
    const seen = new Set();
    catalog.components.forEach((c) => {
        const a = c && c.artifact;
        if (!c || !ID.test(c.id) || KINDS.indexOf(c.kind) < 0 || !SEMVER.test(c.version) ||
            !a || typeof a.name !== 'string' || a.name !== `${c.id}@${c.version}.tgz` ||
            !SHA256.test(a.sha256) || !(a.size > 0) || (a.url !== undefined && typeof a.url !== 'string')) {
            throw new Error(`catalog entry ${c && c.id} is malformed`);
        }
        if (seen.has(c.id)) {
            throw new Error(`catalog lists ${c.id} twice`);
        }
        seen.add(c.id);
        checkExtras(c);
    });
    return { commit: typeof catalog.commit === 'string' ? catalog.commit : null, components: catalog.components };
}

/* One row per component, with what is installed of it. entries: the
 * component each id resolves to ({ entry, source }); installed: { id, version }.
 * status: installed | update | available | newer (a local build ahead of
 * the source). An optional component is never an update unless installed:
 * not installed, it is listed as available. */
function plan(entries, installed) {
    const have = new Map(installed.map((i) => [i.id, i]));
    return entries.map((r) => {
        const c = r.entry;
        const i = have.get(c.id);
        let status = 'available';
        if (i) {
            const cmp = compareVersions(i.version, c.version);
            status = cmp === 0 ? 'installed' : cmp < 0 ? 'update' : 'newer';
        }
        return {
            id: c.id,
            kind: c.kind,
            title: (i && i.title) && c.title === c.id ? i.title : c.title,
            version: c.version,
            installed: i ? i.version : null,
            size: c.artifact.size || null,
            status,
            source: r.source,
            build: c.build,
            optional: c.optional,
            uninstallable: c.uninstallable,
            description: c.description || '',
            author: c.author || '',
            mguHmi: c.mguHmi,
            provides: c.mguProvides,
            service: c.service
        };
    });
}

module.exports = { parse, plan, checkExtras, compareVersions, hmiList, compat, SEMVER, ID, SHA256, HMIS };
