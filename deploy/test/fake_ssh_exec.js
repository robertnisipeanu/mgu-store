'use strict';
/**
 * ssh for the mgu-install tests: runs the remote command against a fake
 * root. Each call appends its arguments (JSON) to $FAKE_SSH_LOG. `ssh -V`
 * answers $FAKE_SSH_VERSION. The remote command runs under sh with the
 * environment in $FAKE_SSH_ENV (the fake root's), /var/opt and
 * /usr/bin/node pointed into that root and at this Node, and stdin passed
 * through.
 */
const fs = require('fs');
const cp = require('child_process');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === '-V') {
    process.stderr.write(`${process.env.FAKE_SSH_VERSION || 'OpenSSH_9.6p1, LibreSSL 3.3.6'}\n`);
    process.exit(0);
}
const env = JSON.parse(fs.readFileSync(process.env.FAKE_SSH_ENV, 'utf8'));
const remote = args[args.length - 1].split('/var/opt').join(env.MGU_DEPLOY_VAR_OPT)
    .split('/usr/bin/node').join(env.FAKE_NODE);
const r = cp.spawnSync('sh', ['-c', remote], { env, stdio: 'inherit' });
process.exit(r.status === null ? 255 : r.status);
