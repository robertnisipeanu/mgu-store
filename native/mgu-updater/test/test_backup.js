'use strict';
/* Backup transports against fake GitHub/network responses, including a
 * restart, an expired trust cache and queued installs. Node 8+. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const backup = require('../js/backup');
const sources = require('../js/sources');
const catalog = require('../js/catalog');
const { Updater } = require('../js/updater');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-backup-'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const bytes = Buffer.from('official unmodified package');
const entry = { id: 'app', kind: 'app', version: '1.0.0', title: 'Official title', requires: { dependency: '2.0.0' },
    artifact: { name: 'app@1.0.0.tgz', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        url: 'https://github.com/owner/repo/releases/download/app/official.tgz' } };
const doc = { schema: 2, components: [entry] };
const original = Object.assign({ mode: 'catalog', channel: 'releases', public: true }, catalog.parse(JSON.stringify(doc)));
const def = { id: 'repo', type: 'github', repo: 'owner/repo', builtin: true,
    backup: { url: 'https://backup.test/catalog.json', fallback: false } };
let time = 1000000;
let officialReads = 0;
let officialDownloads = 0;
let offline = false;
let cat = clone(original);
let mirror = clone(doc);
let payload = bytes;
let downloadFailure = false;
let expireDuringDownload = false;
const requests = [];
const official = {
    network: true, apiRequests: () => officialReads,
    catalog: () => { officialReads++; return offline ? Promise.reject(new Error('GitHub unavailable')) : Promise.resolve(clone(cat)); },
    artifact: () => { officialDownloads++; return Promise.resolve(bytes); },
    icon: () => Promise.resolve(Buffer.from('official icon'))
};
const ctx = { version: 'test', backupDir: dir, now: () => time, net: { get: (url, headers, name, max) => {
    requests.push({ url, headers, max });
    if (url === def.backup.url) { return Promise.resolve(Buffer.from(JSON.stringify(mirror))); }
    if (expireDuringDownload) { time += backup.MAX_AGE; }
    return downloadFailure ? Promise.reject(new Error('backup unavailable')) : Promise.resolve(payload);
} } };
const reader = (d) => backup.wrap(d || def, ctx, official, sources);
const fails = (p, text) => p.then(() => { throw new Error('expected failure: ' + text); }, (e) => assert(text.test(e.message), e.message));
let checks = 0;
function ok() { checks++; }

(async () => {
    const file = path.join(dir, 'sources.json');
    sources.save(file, [def]);
    assert.deepStrictEqual(sources.load(file), [def]); ok();
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); ok();
    for (const url of ['http://backup.test/catalog.json', 'https://u:p@backup.test/catalog.json', 'https://backup.test/#x',
        'file:///tmp/catalog.json', 'https://backup.test/ bad', 'https://backup.test/\\bad']) {
        assert.throws(() => sources.checkStored(Object.assign({}, def, { backup: { url, fallback: false } }))); ok();
    }
    assert.throws(() => sources.checkStored(Object.assign({}, def, { channel: 'branch:main' }))); ok();
    assert.throws(() => sources.checkStored(Object.assign({}, def, { type: 'https', url: 'https://a.test/catalog.json' }))); ok();
    assert.throws(() => sources.checkStored(Object.assign({}, def, { backup: { url: def.backup.url, fallback: 'yes' } }))); ok();
    mirror.components[0].title = 'Untrusted title';
    mirror.components[0].requires = {};
    mirror.components[0].artifact.url = 'packages/app.tgz';
    let r = reader();
    const got = await r.catalog();
    assert.deepStrictEqual(got, Object.assign({}, original, { verifiedAt: time }));
    assert.strictEqual(requests.length, 0); ok();
    assert.deepStrictEqual(await r.artifact(got.components[0]), bytes);
    assert.strictEqual(requests[1].url, 'https://backup.test/packages/app.tgz');
    assert.strictEqual(requests[1].max, bytes.length);
    assert(requests.every((x) => !x.headers.Authorization)); ok();
    assert.deepStrictEqual(await r.icon(got.components[0]), Buffer.from('official icon')); ok();
    // Never consume metadata from the mirror for labels, versions or dependencies.
    assert.deepStrictEqual(got.components[0].requires, { dependency: '2.0.0' }); ok();
    for (const alter of [
        (e) => { e.version = '1.1.0'; e.artifact.name = 'app@1.1.0.tgz'; },
        (e) => { e.artifact.sha256 = 'a'.repeat(64); },
        (e) => { e.artifact.size++; },
        (e) => { e.kind = 'tool'; },
        (e) => { e.id = 'other'; e.artifact.name = 'other@1.0.0.tgz'; }
    ]) {
        mirror = clone(doc); alter(mirror.components[0]);
        await fails(r.artifact(got.components[0]), /does not match/); ok();
    }
    mirror = clone(doc);
    mirror.components[0].artifact.url = 'https://downloads.test/app.tgz';
    payload = Buffer.alloc(bytes.length, 33);
    await fails(r.artifact(got.components[0]), /does not match/); ok();
    payload = Buffer.from('short');
    await fails(r.artifact(got.components[0]), /does not match/); ok();
    payload = bytes;
    mirror.components[0].artifact.url = 'http://unsafe.test/app.tgz';
    await fails(r.artifact(got.components[0]), /HTTPS/); ok();
    mirror = clone(doc); mirror.components[0].artifact.url = 'app.tgz';
    downloadFailure = true;
    await fails(r.artifact(got.components[0]), /backup unavailable/);
    assert.strictEqual(officialDownloads, 0); ok();
    const withFallback = reader(Object.assign({}, def, { backup: Object.assign({}, def.backup, { fallback: true }) }));
    assert.deepStrictEqual(await withFallback.artifact(got.components[0]), bytes);
    assert.strictEqual(officialDownloads, 1); ok();
    downloadFailure = false; payload = Buffer.from('tampered');
    assert.deepStrictEqual(await withFallback.artifact(got.components[0]), bytes); ok();
    payload = bytes;
    // A restart can use only a snapshot read from this exact GitHub repo.
    offline = true; r = reader();
    assert.deepStrictEqual(await r.catalog(), Object.assign({}, original, { verifiedAt: time }));
    assert.deepStrictEqual(await r.artifact(got.components[0]), bytes); ok();
    const cacheFile = path.join(dir, crypto.createHash('sha256').update('github:owner/repo:releases').digest('hex') + '.json');
    assert.strictEqual(fs.statSync(cacheFile).mode & 0o777, 0o600); ok();
    const savedCache = fs.readFileSync(cacheFile);
    const corrupt = JSON.parse(savedCache); corrupt.cat.components = [null];
    fs.writeFileSync(cacheFile, JSON.stringify(corrupt));
    await fails(reader().artifact(got.components[0]), /GitHub unavailable/); ok();
    fs.writeFileSync(cacheFile, savedCache);
    await fails(reader(Object.assign({}, def, { repo: 'other/repo' })).artifact(got.components[0]), /GitHub unavailable/); ok();
    time += backup.MAX_AGE;
    await fails(r.catalog(), /GitHub unavailable/);
    await fails(r.artifact(got.components[0]), /GitHub unavailable/); ok();
    time = 1;
    await fails(reader().artifact(got.components[0]), /GitHub unavailable/); ok();
    time = 1000000 + backup.MAX_AGE; offline = false;
    cat.components[0].requires.dependency = '3.0.0';
    await fails(r.artifact(got.components[0]), /catalog changed/); ok();
    cat = clone(original); await r.catalog();
    cat.mode = 'releases';
    await fails(r.catalog(), /requires a GitHub releases catalog/); ok();
    cat = clone(original); await r.catalog();
    expireDuringDownload = true;
    await fails(r.artifact(got.components[0]), /expired/); ok();
    expireDuringDownload = false;
    await fails(r.files('commit'), /no repository tree/); ok();
    // Source editing is an identity-preserving operation, including builtin.
    const rt = { def, checking: null, memo: {} };
    let checked = null;
    const u = { stored: [def], src: new Map([[def.id, rt]]), ctx: Object.assign({}, ctx, { githubApi: 'https://api.github.com' }),
        busy: null, queue: [], saveSources(list) { this.stored = list; }, changed() {}, checkSource(id) { checked = id; } };
    assert.strictEqual(Updater.prototype.sourceBackup.call(u, { id: def.id, backup: null }), null);
    assert.strictEqual(checked, def.id);
    assert.strictEqual(rt.def.repo, def.repo); assert.strictEqual(rt.def.builtin, true);
    assert.strictEqual(rt.def.backup, undefined); assert.strictEqual(rt.memo, null); ok();
    u.queue.push({ id: 'app' });
    assert(/wait/.test(Updater.prototype.sourceBackup.call(u, { id: def.id, backup: def.backup }))); ok();
    u.queue = []; rt.checking = Promise.resolve();
    assert(/wait/.test(Updater.prototype.sourceBackup.call(u, { id: def.id, backup: def.backup }))); ok();
    rt.components = []; rt.mode = 'repo'; rt.channel = 'branch:main';
    assert.strictEqual(Updater.prototype.sourceState.call(u, def).backupSupported, false); ok();
    rt.mode = 'catalog'; rt.channel = 'releases';
    assert.strictEqual(Updater.prototype.sourceState.call(u, def).backupSupported, true); ok();
    assert.strictEqual(Updater.prototype.handle.call({ authorized: () => false }, { op: 'source-backup', id: def.id, backup: null }), 'forbidden'); ok();
    console.log(`backup: ${checks} checks passed`);
})().catch((err) => { console.error(err); process.exitCode = 1; }).then(() => {
    fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f))); fs.rmdirSync(dir);
});
