'use strict';
/**
 * The updater's tokens (README.md, "Tokens"): GitHub tokens of their own,
 * not of a source. credentials/tokens.json (root, 0600) lists what is known
 * of each:
 *
 *   [{ "id": "3f9a01c2", "kind": "github", "label": "someone",
 *      "login": "someone", "scopes": "repo" | null, "addedAt": 0,
 *      "expiresAt": null, "checkedAt": 0, "rejected": false,
 *      "device": true, "refreshToken": "…", "refreshExpiresAt": 0 }]
 *
 * and credentials/token-<id> (root, 0600) holds each one's text. The deploy
 * tool writes both too (`mgu-deploy.sh updater-token`), so the files are
 * what counts: a token-<id> file is a token whether or not tokens.json names
 * it yet, an entry without its file is none, and tokens.json is read again
 * before every change. scan() notices either changing, including a change
 * made by someone else just before one of the updater's own.
 *
 * Per-source files of earlier versions (credentials/<source id>, with
 * <source id>.json) are converted into tokens, one per distinct text;
 * removeLegacy() removes them once this version is kept. Node 8.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ID } = require('./catalog');
const { writePrivate, mkdirPrivate } = require('./sources');

const TOKEN_ID = /^[0-9a-f]{8}$/;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;
const LIST = 'tokens.json';
// what tokens.json may keep of an entry
const FIELDS = ['label', 'login', 'scopes', 'addedAt', 'expiresAt', 'checkedAt', 'rejected', 'device', 'refreshToken', 'refreshExpiresAt'];

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch (e) {
        return '';
    }
}

function mtime(file) {
    try {
        const st = fs.statSync(file);
        return `${st.mtime.getTime()}:${st.size}`;
    } catch (e) {
        return '-';
    }
}

class Tokens {
    constructor(dir) {
        this.dir = dir;
        this.key = null;
        this.external = false;
        this.list = [];
        this.scan();
    }

    file(id) {
        if (!TOKEN_ID.test(id)) {
            throw new Error(`no token ${id}`);
        }
        return path.join(this.dir, `token-${id}`);
    }

    names() {
        try {
            return fs.readdirSync(this.dir).sort();
        } catch (e) {
            return [];
        }
    }

    /* tokens.json's entries, each a token whose file is there, then the
     * files it does not name yet. */
    read() {
        let doc = [];
        try {
            doc = JSON.parse(fs.readFileSync(path.join(this.dir, LIST), 'utf8'));
        } catch (e) { /* none yet, or unreadable: the files still count */ }
        const files = this.names().map((n) => /^token-([0-9a-f]{8})$/.exec(n)).filter(Boolean).map((m) => m[1]);
        const seen = new Set();
        const out = [];
        (Array.isArray(doc) ? doc : []).forEach((e) => {
            if (e && TOKEN_ID.test(e.id) && files.indexOf(e.id) >= 0 && !seen.has(e.id)) {
                seen.add(e.id);
                const t = { id: e.id, kind: 'github' };
                FIELDS.forEach((k) => {
                    t[k] = e[k] === undefined ? null : e[k];
                });
                out.push(t);
            }
        });
        files.filter((id) => !seen.has(id)).forEach((id) => {
            let addedAt = null;
            try {
                addedAt = fs.statSync(this.file(id)).mtime.getTime();
            } catch (e) { /* gone meanwhile */ }
            const t = { id, kind: 'github' };
            FIELDS.forEach((k) => {
                t[k] = null;
            });
            t.addedAt = addedAt;
            out.push(t);
        });
        return out;
    }

    /* What the files look like now: names, mtimes, sizes. */
    diskKey() {
        return this.names().filter((n) => n === LIST || /^token-[0-9a-f]{8}$/.test(n))
            .map((n) => `${n}@${mtime(path.join(this.dir, n))}`).join('\n');
    }

    /* Reads the list again when tokens.json or the token files changed
     * since the last scan, by someone else; true when they did. */
    scan() {
        const key = this.diskKey();
        if (key === this.key && !this.external) {
            return false;
        }
        this.key = key;
        this.external = false;
        this.list = this.read();
        return true;
    }

    /* Before a change of its own: a change someone else made since the last
     * scan is still reported by the next one. */
    noteExternal() {
        if (this.diskKey() !== this.key) {
            this.external = true;
        }
    }

    /* After a change of its own: the list as it is now, the change not one
     * for scan() to report. */
    settle() {
        this.key = this.diskKey();
        this.list = this.read();
    }

    all() {
        return this.list;
    }

    get(id) {
        return this.list.find((t) => t.id === id) || null;
    }

    text(id) {
        return TOKEN_ID.test(id || '') ? readText(this.file(id)) : '';
    }

    /* The token whose text is text, or null. */
    byText(text) {
        return this.list.find((t) => this.text(t.id) === text) || null;
    }

    save(list) {
        writePrivate(path.join(this.dir, LIST), JSON.stringify(list.map((t) => {
            const e = { id: t.id, kind: 'github' };
            FIELDS.forEach((k) => {
                if (t[k] !== null && t[k] !== undefined) {
                    e[k] = t[k];
                }
            });
            return e;
        }), null, 2) + '\n');
        this.settle();
    }

    /* Stores text as a token, or merges fields into the one with that text
     * already; resolves { id, added }. */
    add(text, fields) {
        if (!TOKEN.test(text || '')) {
            throw new Error('a token is 1 to 1024 printable characters without spaces');
        }
        mkdirPrivate(this.dir);
        fs.chmodSync(this.dir, 0o700);
        this.noteExternal();
        this.list = this.read();
        const have = this.byText(text);
        if (have) {
            this.update(have.id, fields);
            return { id: have.id, added: false };
        }
        let id;
        do {
            id = crypto.randomBytes(4).toString('hex');
        } while (fs.existsSync(this.file(id)));
        writePrivate(this.file(id), `${text}\n`);
        const list = this.read().filter((t) => t.id !== id);
        list.push(Object.assign({ id, kind: 'github' }, { addedAt: Date.now() }, fields));
        this.save(list);
        return { id, added: true };
    }

    /* Merges fields into the entry of id (tokens.json as it is on disk). */
    update(id, fields) {
        this.noteExternal();
        this.merge(id, fields);
    }

    /* A token renewed: the new text under the same id. */
    setText(id, text, fields) {
        this.noteExternal();
        writePrivate(this.file(id), `${text}\n`);
        this.merge(id, fields);
    }

    merge(id, fields) {
        const list = this.read();
        const t = list.find((x) => x.id === id);
        if (t) {
            Object.assign(t, fields);
            this.save(list);
        }
    }

    remove(id) {
        this.noteExternal();
        try {
            fs.unlinkSync(this.file(id));
        } catch (e) { /* gone */ }
        this.save(this.read().filter((t) => t.id !== id));
    }

    /* The per-source files of earlier versions: [{ source, file, text, meta }]. */
    legacy() {
        return this.names().filter((n) => ID.test(n) && n !== LIST && !/^token-/.test(n)).map((n) => {
            let meta = {};
            try {
                meta = JSON.parse(fs.readFileSync(path.join(this.dir, `${n}.json`), 'utf8')) || {};
            } catch (e) { /* none */ }
            return { source: n, file: path.join(this.dir, n), text: readText(path.join(this.dir, n)), meta };
        }).filter((l) => l.text);
    }

    /* Each distinct text of a GitHub source's (or of a source no longer
     * stored) per-source file becomes a token, with what its .json knew;
     * an https source's is left for removeLegacy. Returns { <source id>:
     * <token id> }. */
    convert(stored, log) {
        const out = {};
        this.legacy().forEach((l) => {
            const def = stored.find((s) => s.id === l.source);
            if ((def && def.type !== 'github') || (!def && l.meta.kind && l.meta.kind !== 'github') || !TOKEN.test(l.text)) {
                return;
            }
            const m = l.meta;
            // what this file knows; another file with the same text may know more
            const fields = m.login ? { login: m.login, label: m.login } : {};
            if (m.expiresAt) {
                Object.assign(fields, { expiresAt: m.expiresAt, refreshToken: m.refreshToken || null,
                    refreshExpiresAt: m.refreshExpiresAt || null, device: !!m.refreshToken });
            }
            const r = this.add(l.text, fields);
            out[l.source] = r.id;
            log(`tokens: ${l.source}'s token ${r.added ? 'is' : 'is the same as'} token ${r.id}`);
        });
        return out;
    }

    /* Removes the per-source files once their tokens are stored. */
    removeLegacy(log) {
        this.legacy().forEach((l) => {
            [l.file, `${l.file}.json`].forEach((f) => {
                try {
                    fs.unlinkSync(f);
                } catch (e) { /* none */ }
            });
            log(`tokens: removed ${l.source}'s own token file`);
        });
    }
}

module.exports = { Tokens, TOKEN, TOKEN_ID };
