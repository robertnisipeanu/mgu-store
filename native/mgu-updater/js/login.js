'use strict';
/**
 * GitHub sign-in by GitHub's device flow (a GitHub App's user token;
 * README.md, "Signing in to GitHub"). The Store shows the code and the
 * address; the owner enters the code on a phone; the token the flow ends
 * with becomes one of the updater's tokens. Every request goes through the
 * updater's fetcher (fetch.js as the fetch uid). github.com gets the client
 * id with the device code, or with the refresh token when an expired token
 * is renewed; a token goes to the API host only (/user, which also checks a
 * pasted one). Node 8.
 */
const { URL } = require('url');

const GRANT_DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';

function form(fields) {
    return Object.keys(fields).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&');
}

/* opts: { net, clientId, web (https://github.com), api (https://api.github.com),
 *         version, changed(), done(token, meta), log(line) } */
class DeviceLogin {
    constructor(opts) {
        this.o = opts;
        this.current = null;
        this.run = 0;
        this.timer = null;
    }

    headers() {
        return { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `mgu-updater/${this.o.version}` };
    }

    post(path, fields) {
        const url = `${this.o.web.replace(/\/+$/, '')}${path}`;
        return this.o.net.request({ url, headers: this.headers(), name: 'login.json', maxBytes: 65536, method: 'POST', body: form(fields) })
            .then((buf) => JSON.parse(buf.toString('utf8')));
    }

    /* What GitHub says of token (/user): { status: "ok", login, scopes } (a
     * classic token's X-OAuth-Scopes; null for one without, as a
     * fine-grained or GitHub App token), { status: "rejected" } (401), or
     * { status: "unknown" } (no answer). */
    account(token) {
        const url = `${this.o.api.replace(/\/+$/, '')}/user`;
        if (new URL(url).hostname !== 'api.github.com') {
            return Promise.resolve({ status: 'unknown' });
        }
        return this.o.net.request({ url, name: 'user.json', maxBytes: 1 << 20, keep: ['x-oauth-scopes'],
            headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': `mgu-updater/${this.o.version}` } })
            .then((buf) => {
                const login = JSON.parse(buf.toString('utf8')).login;
                const scopes = buf.headers && buf.headers['x-oauth-scopes'];
                return { status: 'ok', login: typeof login === 'string' ? login : null, scopes: typeof scopes === 'string' ? scopes : null };
            }, (err) => ({ status: err.status === 401 ? 'rejected' : 'unknown' }));
    }

    /* What the token's entry keeps of a token answer. */
    static meta(answer, login, now) {
        return {
            login: login || null,
            expiresAt: answer.expires_in ? now + answer.expires_in * 1000 : null,
            refreshToken: answer.refresh_token || null,
            refreshExpiresAt: answer.refresh_token_expires_in ? now + answer.refresh_token_expires_in * 1000 : null
        };
    }

    state() {
        return this.current;
    }

    set(fields) {
        this.current = Object.assign({}, this.current, fields);
        this.o.changed();
    }

    /* Starts a sign-in; returns a reason it cannot. */
    start() {
        if (!this.o.clientId) {
            return 'no GitHub App client id configured (github_client_id)';
        }
        this.cancel();
        const run = ++this.run;
        const live = () => run === this.run;
        this.current = { url: null, code: null, expiresAt: null, status: 'pending', error: null };
        this.o.changed();
        this.o.log('login: requesting a device code');
        this.post('/login/device/code', { client_id: this.o.clientId })
            .then((d) => {
                if (!live()) {
                    return;
                }
                if (!d.device_code || !d.user_code || !d.verification_uri) {
                    throw new Error(d.error_description || d.error || 'GitHub gave no device code');
                }
                const expiresAt = Date.now() + (Number(d.expires_in) || 900) * 1000;
                this.set({ url: d.verification_uri, code: d.user_code, expiresAt });
                this.poll(run, d.device_code, Math.max(1, Number(d.interval) || 5), expiresAt);
            })
            .catch((err) => {
                if (live()) {
                    this.o.log(`login: ${err.message}`);
                    this.set({ status: 'error', error: err.message });
                }
            });
        return null;
    }

    poll(run, deviceCode, interval, expiresAt) {
        const live = () => run === this.run;
        this.timer = setTimeout(() => {
            if (!live()) {
                return;
            }
            if (Date.now() >= expiresAt) {
                this.set({ status: 'expired' });
                return;
            }
            const now = Date.now();
            this.post('/login/oauth/access_token', { client_id: this.o.clientId, device_code: deviceCode, grant_type: GRANT_DEVICE })
                .then((a) => {
                    if (!live()) {
                        return undefined;
                    }
                    if (a.access_token) {
                        return this.account(a.access_token).then((acct) => {
                            if (!live()) {
                                return;
                            }
                            const login = acct.login || null;
                            this.o.done(a.access_token, Object.assign(DeviceLogin.meta(a, login, now), { scopes: acct.scopes || null }));
                            this.o.log(`login: signed in${login ? ` as ${login}` : ''}`);
                            this.set({ status: 'done' });
                        });
                    }
                    if (a.error === 'authorization_pending') {
                        this.poll(run, deviceCode, interval, expiresAt);
                    } else if (a.error === 'slow_down') {
                        this.poll(run, deviceCode, Number(a.interval) || interval + 5, expiresAt);
                    } else if (a.error === 'expired_token') {
                        this.set({ status: 'expired' });
                    } else {
                        throw new Error(a.error === 'access_denied' ? 'sign-in cancelled on GitHub' : a.error_description || a.error || 'no token');
                    }
                    return undefined;
                })
                .catch((err) => {
                    if (!live()) {
                        return;
                    }
                    // a network error between polls: try again until the code expires
                    if (err.status === undefined && !(err instanceof SyntaxError) && !/sign-in|no token|^[a-z_]+$/.test(err.message)) {
                        this.poll(run, deviceCode, interval, expiresAt);
                        return;
                    }
                    this.o.log(`login: ${err.message}`);
                    this.set({ status: 'error', error: err.message });
                });
        }, interval * 1000);
    }

    cancel() {
        this.run += 1;
        clearTimeout(this.timer);
        this.timer = null;
        if (this.current) {
            this.current = null;
            this.o.changed();
        }
    }

    /* A new token for one that has expired, from its refresh token (meta: its
     * entry); resolves with { token, meta }, or null when there is none to use. */
    refresh(meta) {
        if (!meta || !meta.refreshToken || !this.o.clientId ||
            (meta.refreshExpiresAt && meta.refreshExpiresAt <= Date.now())) {
            return Promise.resolve(null);
        }
        const now = Date.now();
        return this.post('/login/oauth/access_token', { client_id: this.o.clientId, grant_type: 'refresh_token', refresh_token: meta.refreshToken })
            .then((a) => (a.access_token ? { token: a.access_token, meta: DeviceLogin.meta(a, meta.login, now) } : null), () => null);
    }
}

module.exports = { DeviceLogin };
