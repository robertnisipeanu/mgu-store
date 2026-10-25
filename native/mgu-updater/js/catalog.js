'use strict';
/**
 * Catalogs (release/README.md) and what they mean for this head unit: parse
 * and check a catalog (schema 1, or 2 with build / requires / optional /
 * uninstallable), and compare the components every source lists with what
 * is installed. A `signature` in a catalog is ignored: trust is HTTPS (and
 * the source's credential) to the source the owner added, and every
 * download is checked against the size and sha256 it lists. Node 8; no I/O.
 */

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

/* Checks one entry's schema-2 fields (requires, build, optional,
 * uninstallable) and gives them their defaults; throws with a reason. */
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
    return Object.assign(c, {
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
            uninstallable: c.uninstallable
        };
    });
}

module.exports = { parse, plan, checkExtras, compareVersions, SEMVER, ID, SHA256 };
