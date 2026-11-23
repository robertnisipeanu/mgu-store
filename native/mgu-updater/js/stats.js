'use strict';
/**
 * Anonymous usage statistics (README.md, "Usage statistics"): at most one
 * ping a UTC day to stats_url, after a check that read a network source.
 * One HTTPS POST through the fetch uid, 10 s at most, never tried again;
 * whatever happens to it changes nothing else. Node 8.
 *
 * Only public GitHub sources (their repo said so when read) and what was
 * installed from them, also from a stick's copy of one, are named. A
 * source that needs a sign-in, an https catalog, a folder or another stick
 * is left out, with everything from it.
 *
 * state/stats.json, written only when it changes:
 *   { on, day: "YYYY-MM-DD" | null (the last ping that got
 *     through), month: "YYYY-MM" | null, known: [repo, ...] | null (the
 *     sources that ping named), events: { installed: [{ id, src }],
 *     failed: [{ id, code }] } }
 * Off drops the events and known; nothing is sent while off.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const MAX_EVENTS = 50;
const MAX_APPS = 100;
const MAX_SOURCES = 50;
const MAX_BYTES = 8192;
// connection, then answer: 10 s together
const CONNECT_MS = 5000;
const IDLE_MS = 5000;
const DAY_MS = 86400000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
// "BMW MGU P18_23w44.2-1-3 mgu-high" (iDrive 8: "BMW MGU 23w50.3-1-4 mgu-high"): the build train, and the hardware variant
const TRAIN = /^([A-Z][0-9]{2}[A-Z]?_)?[0-9]{2}w[0-9]{2}(\.[0-9]{1,2})?$/;
const VARIANT = /^mgu-[a-z0-9]{1,16}$/;

// why an install failed, as a fixed code: never the message itself
const FAIL_CODES = ['requires', 'checksum', 'check', 'refused', 'deploy', 'build', 'download', 'other'];
function failCode(message) {
    const m = String(message || '');
    if (/^needs /.test(m)) {
        return 'requires';
    }
    if (/does not match the catalog/.test(m)) {
        return 'checksum';
    }
    if (/ does not run| gives no internet/.test(m)) {
        return 'check';
    }
    if (/nothing changed$|already installed from/.test(m)) {
        return 'refused';
    }
    if (/^install failed|deploy tool missing/.test(m)) {
        return 'deploy';
    }
    if (/build|SDK donor/i.test(m)) {
        return 'build';
    }
    if (/HTTP [0-9]{3}|download|connection|no data for|no internet|GitHub limit|proxy/i.test(m)) {
        return 'download';
    }
    return 'other';
}

const day = (now) => new Date(now).toISOString().slice(0, 10);
const month = (now) => new Date(now).toISOString().slice(0, 7);

/* The I-Step train and hardware variant of the firmware string, each null
 * when it is not there. */
function unitParts(firmware) {
    const words = String(firmware || '').split(/\s+/);
    const train = words.map((w) => w.replace(/-[0-9]+-[0-9]+$/, '')).find((w) => TRAIN.test(w)) || null;
    const variant = words.map((w) => w.toLowerCase()).find((w) => VARIANT.test(w)) || null;
    return { istep: train, hw: variant };
}

/* When the updater was set up on this unit, in ms: the oldest modification
 * time among the entries of its state folder (dir), which its first start
 * makes and its updates keep; null when there is none. Read only. */
function setUpAt(dir) {
    let oldest = null;
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (e) { /* not there yet */ }
    names.forEach((name) => {
        try {
            const t = fs.lstatSync(path.join(dir, name)).mtime.getTime();
            oldest = oldest === null || t < oldest ? t : oldest;
        } catch (e) { /* gone meanwhile */ }
    });
    return oldest;
}

/* Whether the Store is a new install: no ping has got through yet (lastDay
 * null) and the updater was set up within the last day. A unit with a ping
 * through had the Store before it. */
function newInstall(lastDay, setUp, now) {
    return lastDay === null && setUp !== null && now - setUp < DAY_MS;
}

function fresh() {
    return { on: true, day: null, month: null, known: null, events: { installed: [], failed: [] } };
}

class Stats {
    /* file: state/stats.json; write(file, text): an atomic write. */
    constructor(file, write) {
        this.file = file;
        this.write = write;
        this.d = fresh();
        this.written = null;
        try {
            this.written = fs.readFileSync(file, 'utf8');
            const r = JSON.parse(this.written);
            const list = (a, ok) => (Array.isArray(a) ? a.filter(ok).slice(-MAX_EVENTS) : []);
            const ev = r.events || {};
            this.d = {
                on: r.on !== false,
                day: typeof r.day === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(r.day) ? r.day : null,
                month: typeof r.month === 'string' && /^[0-9]{4}-[0-9]{2}$/.test(r.month) ? r.month : null,
                known: Array.isArray(r.known) ? r.known.filter((s) => REPO.test(s)) : null,
                events: {
                    installed: list(ev.installed, (e) => e && ID.test(e.id) && REPO.test(e.src)),
                    failed: list(ev.failed, (e) => e && ID.test(e.id) && FAIL_CODES.indexOf(e.code) >= 0)
                }
            };
        } catch (e) { /* none yet, or unreadable: on, nothing pending */ }
    }

    get on() {
        return this.d.on;
    }

    state() {
        return { on: this.d.on };
    }

    /* False when the write fails (a full or read-only disk), which must
     * never fail an install. */
    save() {
        const text = JSON.stringify(this.d);
        if (text !== this.written) {
            try {
                this.write(this.file, text);
                this.written = text;
            } catch (e) {
                console.log(`stats: ${e.message}`);
                return false;
            }
        }
        return true;
    }

    /* A setting that cannot be saved is not taken: the switch shows what
     * the next start does. */
    set(on) {
        const was = this.d;
        this.d = Object.assign({}, was, { on }, on ? {} : { events: { installed: [], failed: [] }, known: null });
        if (!this.save()) {
            this.d = was;
            throw new Error('the setting could not be saved');
        }
    }

    add(list, entry, same) {
        if (!this.d.on || list.some(same)) {
            return;
        }
        list.push(entry);
        if (list.length > MAX_EVENTS) {
            list.shift();
        }
        this.save();
    }

    /* id was installed from public repo src (null: not public, not counted). */
    installed(id, src) {
        if (ID.test(id) && REPO.test(src || '')) {
            this.add(this.d.events.installed, { id, src }, (e) => e.id === id && e.src === src);
        }
    }

    /* An install of id from public repo src failed with message. */
    failed(id, src, message) {
        if (ID.test(id) && REPO.test(src || '')) {
            const code = failCode(message);
            this.add(this.d.events.failed, { id, code }, (e) => e.id === id && e.code === code);
        }
    }

    due(now) {
        return this.d.on && this.d.day !== day(now);
    }

    /* The ping. info: { hmi, firmware, versions: { store, updater, deploy,
     * render, uplink }, apps: [{ id, v, src }], sources: [repo] }, public
     * ones only. */
    body(info, now) {
        const sources = (info.sources || []).filter((s) => REPO.test(s)).slice(0, MAX_SOURCES);
        const lower = (l) => l.map((s) => s.toLowerCase());
        const known = this.d.known && lower(this.d.known);
        const have = lower(sources);
        const versions = {};
        Object.keys(info.versions || {}).forEach((k) => {
            const v = info.versions[k];
            if (['store', 'updater', 'deploy', 'render', 'uplink'].indexOf(k) >= 0 && VERSION.test(v || '')) {
                versions[k] = v;
            }
        });
        const parts = unitParts(info.firmware);
        const out = { v: SCHEMA };
        if (info.hmi === 'ID7' || info.hmi === 'ID8') {
            out.hmi = info.hmi;
        }
        if (parts.hw) {
            out.hw = parts.hw;
        }
        if (parts.istep) {
            out.istep = parts.istep;
        }
        Object.assign(out, {
            versions,
            apps: (info.apps || []).filter((a) => ID.test(a.id) && VERSION.test(a.v || '') && REPO.test(a.src || ''))
                .slice(0, MAX_APPS).map((a) => ({ id: a.id, v: a.v, src: a.src })),
            sources,
            events: {
                installed: this.d.events.installed.slice(),
                failed: this.d.events.failed.slice(),
                sources_added: known ? sources.filter((s, i) => known.indexOf(have[i]) < 0) : [],
                sources_removed: known ? this.d.known.filter((s) => have.indexOf(s.toLowerCase()) < 0) : []
            },
            first_this_month: this.d.month !== month(now),
            first_ever: this.d.day === null,
            new_install: newInstall(this.d.day, this.d.day === null ? setUpAt(path.dirname(this.file)) : null, now)
        });
        return out;
    }

    sent(body, now) {
        const sent = body.events;
        const drop = (list, gone) => list.filter((e) => !gone.some((g) => g.id === e.id && (g.src || g.code) === (e.src || e.code)));
        this.d.events = { installed: drop(this.d.events.installed, sent.installed), failed: drop(this.d.events.failed, sent.failed) };
        this.d.day = day(now);
        this.d.month = month(now);
        this.d.known = body.sources.slice();
        this.save();
    }

    /* Sends body to url through net (the updater's Fetcher): resolves true
     * when the server took it (any 2xx), false otherwise; never rejects. */
    static send(net, url, body, version) {
        const text = JSON.stringify(body);
        if (Buffer.byteLength(text) > MAX_BYTES) {
            return Promise.resolve(false);
        }
        // quiet: its failure is not the proxy's state the Store shows
        return net.request({ url, method: 'POST', body: text, name: 'stats.txt', maxBytes: 4096, connectMs: CONNECT_MS, idleMs: IDLE_MS, quiet: true,
            headers: { 'Content-Type': 'application/json', 'User-Agent': `mgu-updater/${version}` } })
            .then(() => true, (err) => !!err && err.status >= 200 && err.status < 300);
    }
}

module.exports = { Stats, failCode, unitParts, newInstall, setUpAt, FAIL_CODES, SCHEMA };
