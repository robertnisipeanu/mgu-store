'use strict';
/**
 * The first sources.json of a unit set up by the mgu-apps updater (one
 * catalog in updater.local.conf `catalog`, default github:robertnisipeanu/mgu-apps,
 * and its token in /var/opt/mgu-updater/github-token): the built-in source
 * and that catalog's source, both with that token. The credentials are
 * written first and sources.json last, so a start that stops midway runs
 * this again. The old files stay as they are: a version the supervisor
 * returns to (README.md, "Updating itself") still reads them. Node 8.
 */
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const sourcesLib = require('./sources');
const { ID } = require('./catalog');

const OLD_CATALOG = 'github:robertnisipeanu/mgu-apps';
const OLD_TOKEN = '/var/opt/mgu-updater/github-token';

/* The source an old `catalog` value names, or null. */
function oldSource(spec) {
    const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(spec);
    if (gh) {
        const name = gh[1].split('/')[1].toLowerCase();
        return { id: ID.test(name) ? name : 'catalog', type: 'github', repo: gh[1] };
    }
    if (/^https:\/\//.test(spec)) {
        return { id: `s-${crypto.randomBytes(2).toString('hex')}`, type: 'https', url: spec };
    }
    if (/^file:\/\//.test(spec)) {
        return { id: 'local', type: 'file', path: new URL(spec).pathname.replace(/\/catalog\.json$/, '') };
    }
    return null;
}

/* Writes and returns the first source list. conf: the loaded configuration
 * (updater.local.conf's keys included); builtin: the built-in source. */
function migrate(conf, builtin, credentials, log) {
    const localConf = conf.local_conf || '/var/opt/mgu-updater/updater.local.conf';
    const tokenFile = conf.token_file || OLD_TOKEN;
    const list = [builtin];
    if (fs.existsSync(localConf) || fs.existsSync(tokenFile)) {
        let old = null;
        try {
            old = oldSource(conf.catalog || OLD_CATALOG);
        } catch (e) {
            log(`migrate: catalog = ${conf.catalog} is not a source (${e.message})`);
        }
        if (old && !(old.type === 'github' && old.repo === builtin.repo)) {
            if (old.id === builtin.id) {
                old.id = `${old.id}-1`;
            }
            list.push(old);
        }
        let token = '';
        try {
            token = fs.readFileSync(tokenFile, 'utf8').trim();
        } catch (e) { /* none */ }
        if (token) {
            list.filter((s) => s.type === 'github').forEach((s) => credentials.set(s.id, token, { kind: 'github', login: null }));
        }
        log(`migrate: sources ${list.map((s) => s.id).join(', ')} from ${localConf}${token ? `, with the token in ${tokenFile}` : ''}`);
    }
    sourcesLib.save(conf.sources, list);
    return sourcesLib.load(conf.sources);
}

module.exports = { migrate };
