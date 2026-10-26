'use strict';
/**
 * Client of the mgu-updater socket, for the Store app and the command line.
 * Needs only `net` and `events` (Node 8, and the OAP app sandbox).
 *
 *   const c = new UpdaterClient('/dev/shm/mgu-updater/updater.sock', { reconnectMs: 2000, secret });
 *   c.on('state', (st) => render(st));        // on connect and on every change
 *   c.on('reply-error', (msg, op) => ...);    // a request the updater refused
 *   c.connect();
 *   c.check();  c.install('doom');  c.reboot();
 *
 * The privileged requests carry the secret (opts.secret, or setSecret()):
 * the Store reads it from its data folder (`updater-secret`), the phone page
 * from /run/mgu-updater/web-secret; without the right one the updater
 * answers "forbidden" (README.md, "The socket").
 *   c.uninstall(id);  c.sourceAdd({ type: 'github', repo, channel });  c.sourceAdd({ type: 'https', url });
 *   c.sourceRemove(id);  c.loginStart();  c.loginCancel();
 *   c.tokenAdd(token, label?);  c.tokenRemove(tokenId);  c.web(true | false);
 *
 * With reconnectMs the client keeps reconnecting after the updater goes
 * away (it restarts when it updates itself) and emits 'down' while it is
 * unreachable; without it, 'error' and 'close' end the session.
 */
const net = require('net');
const EventEmitter = require('events');

class UpdaterClient extends EventEmitter {
    constructor(socketPath, opts) {
        super();
        this.path = socketPath;
        this.reconnectMs = (opts && opts.reconnectMs) || 0;
        this.secret = (opts && opts.secret) || null;
        this.sock = null;
        this.closed = false;
        this.timer = null;
    }

    connect() {
        if (this.closed || this.sock) {
            return;
        }
        let buf = '';
        const sock = net.connect(this.path);
        this.sock = sock;
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    continue;
                }
                if (msg.type === 'state') {
                    this.emit('state', msg);
                } else if (msg.type === 'error') {
                    this.emit('reply-error', msg.error, msg.op);
                }
            }
        });
        sock.on('error', (err) => {
            if (!this.reconnectMs) {
                this.emit('error', err);
            }
        });
        sock.on('close', () => {
            this.sock = null;
            if (this.closed) {
                return;
            }
            if (this.reconnectMs) {
                this.emit('down');
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.connect();
                }, this.reconnectMs);
            } else {
                this.emit('close');
            }
        });
    }

    send(req) {
        if (!this.sock) {
            return false;
        }
        this.sock.write(JSON.stringify(req) + '\n');
        return true;
    }

    check() {
        return this.send({ op: 'check' });
    }

    install(id) {
        return this.send({ op: 'install', id });
    }

    reboot() {
        return this.send({ op: 'reboot' });
    }

    setSecret(secret) {
        this.secret = secret || null;
    }

    privileged(req) {
        return this.send(Object.assign({}, req, { secret: this.secret }));
    }

    uninstall(id) {
        return this.privileged({ op: 'uninstall', id });
    }

    /* { type: 'github', repo: 'owner/repo', channel? } or { type: 'https', url } */
    sourceAdd(source) {
        return this.privileged(Object.assign({}, source, { op: 'source-add' }));
    }

    sourceRemove(id) {
        return this.privileged({ op: 'source-remove', id });
    }

    loginStart() {
        return this.privileged({ op: 'login-start' });
    }

    loginCancel() {
        return this.privileged({ op: 'login-cancel' });
    }

    tokenAdd(token, label) {
        return this.privileged(Object.assign({ op: 'token-add', token }, label ? { label } : {}));
    }

    tokenRemove(id) {
        return this.privileged({ op: 'token-remove', id });
    }

    web(enable) {
        return this.privileged({ op: 'web', enable: !!enable });
    }

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        if (this.sock) {
            this.sock.end();
            this.sock = null;
        }
    }
}

module.exports = { UpdaterClient };
