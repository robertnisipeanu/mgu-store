'use strict';
/* A GitHub catalog's backup transport. Only GitHub supplies the listing,
 * dependencies and expected bytes. A backup catalog supplies download
 * locations, never the identity or metadata shown as belonging to GitHub.
 * Node 8. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const catalog = require('./catalog');

const MAX_AGE = 24 * 60 * 60 * 1000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) {
        throw new Error('backup source needs an HTTPS URL without credentials or a fragment');
    }
    const u = new URL(value);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.hash) {
        throw new Error('backup source needs an HTTPS URL without credentials or a fragment');
    }
    return u.href;
}

function check(s) {
    if (s.backup === undefined || s.backup === null) {
        return null;
    }
    if (s.type !== 'github' || (s.channel && s.channel !== 'releases')) {
        throw new Error('a backup source requires a GitHub releases catalog');
    }
    if (typeof s.backup.fallback !== 'boolean') {
        throw new Error('backup fallback must be true or false');
    }
    return { url: httpsUrl(s.backup.url), fallback: s.backup.fallback };
}

function wrap(s, ctx, official, io) {
    const config = check(s);
    const identity = `github:${s.repo.toLowerCase()}:releases`;
    const file = ctx.backupDir && path.join(ctx.backupDir, `${sha(identity)}.json`);
    const now = ctx.now || Date.now;
    let trusted = null;
    let pending = null;
    const valid = (c) => c && c.schema === 1 && c.identity === identity &&
        typeof c.at === 'number' && now() >= c.at && now() - c.at < MAX_AGE &&
        c.cat && c.cat.mode === 'catalog' && c.cat.channel === 'releases' &&
        Array.isArray(c.cat.components) && c.cat.components.every((e) => e && e.artifact &&
            catalog.SHA256.test(e.artifact.sha256) && Number.isSafeInteger(e.artifact.size) && e.artifact.size > 0);
    const load = () => {
        if (!valid(trusted) && file) {
            try { trusted = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { trusted = null; }
        }
        return valid(trusted) ? trusted : null;
    };
    const remember = (cat) => {
        const record = { schema: 1, identity, at: now(), cat };
        if (!valid(record)) {
            trusted = null;
            if (file) { try { fs.unlinkSync(file); } catch (e) { /* no snapshot */ } }
            throw new Error('backup source requires a GitHub releases catalog with package sizes and SHA-256 digests');
        }
        trusted = record;
        if (file) {
            io.mkdirPrivate(path.dirname(file));
            io.writePrivate(file, JSON.stringify(record));
        }
        return record;
    };
    // A fresh official read is attempted on every Check. An outage can use
    // an unexpired snapshot; it cannot renew the snapshot's timestamp.
    const refresh = () => {
        if (!pending) {
            pending = official.catalog().then(remember, (err) => {
                const kept = load();
                if (!kept) { throw err; }
                return kept;
            }).then((r) => { pending = null; return r; }, (err) => { pending = null; throw err; });
        }
        return pending;
    };
    const snapshot = () => Promise.resolve(load()).then((r) => r || refresh());
    const verified = (b, e, record) => {
        if (!valid(record)) { throw new Error('GitHub verification expired; check for updates before installing'); }
        if (b.length !== e.artifact.size || sha(b) !== e.artifact.sha256) {
            throw new Error('download does not match the GitHub catalog (size or SHA-256)');
        }
        return b;
    };
    const match = (a, b) => a && b && a.id === b.id && a.kind === b.kind && a.version === b.version &&
        a.artifact.name === b.artifact.name && a.artifact.size === b.artifact.size && a.artifact.sha256 === b.artifact.sha256;
    const headers = { 'User-Agent': `mgu-updater/${ctx.version}` };
    return Object.assign({}, official, {
        catalog: () => refresh().then((r) => Object.assign(JSON.parse(JSON.stringify(r.cat)), { verifiedAt: r.at })),
        artifact: (entry, progress) => snapshot().then((r) => {
            const e = r.cat.components.find((c) => c.id === (entry.listedId || entry.id));
            // A queued install must still have the verified version and its
            // dependencies. Refreshing the listing is the owner's next step.
            const own = Object.assign({}, entry, { id: entry.listedId || entry.id });
            if (!match(e, own) || JSON.stringify(e.requires) !== JSON.stringify(entry.requires) || e.build !== entry.build) {
                throw new Error('GitHub catalog changed; check for updates before installing');
            }
            return ctx.net.get(config.url, headers, 'backup catalog.json', 4 << 20).then((b) => {
                const mirror = catalog.parse(b.toString('utf8')).components.find((c) => c.id === e.id);
                if (!match(e, mirror)) {
                    throw new Error('backup source does not match the GitHub version, size and SHA-256');
                }
                const url = httpsUrl(new URL(mirror.artifact.url || mirror.artifact.name, config.url).href);
                return ctx.net.get(url, headers, e.artifact.name, e.artifact.size, progress).then((data) => verified(data, e, r));
            }).catch((err) => {
                if (!config.fallback) { throw err; }
                console.log(`source ${s.id}: backup failed (${err.message}); downloading from GitHub`);
                return official.artifact(e, progress).then((b) => verified(b, e, r));
            });
        }),
        // Icons remain official; a mirror cannot supply a different logo.
        files: () => Promise.reject(new Error('a backup source has no repository tree'))
    });
}

module.exports = { check, wrap, MAX_AGE };
