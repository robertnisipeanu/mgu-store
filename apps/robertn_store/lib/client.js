'use strict';
/**
 * Client of the mgu-updater socket, for the Store app and the command line.
 * Needs only `net` and `events` (Node 8, and the OAP app sandbox).
 *
 *   const c = new UpdaterClient('/dev/shm/mgu-updater/updater.sock', { reconnectMs: 2000 });
 *   c.on('state', (st) => render(st));    // on connect and on every change
 *   c.on('reply-error', (msg) => ...);    // a request the updater refused
 *   c.connect();
 *   c.check();  c.install('doom');  c.reboot();
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
                    this.emit('reply-error', msg.error);
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
