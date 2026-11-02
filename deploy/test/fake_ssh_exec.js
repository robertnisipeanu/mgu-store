'use strict';
/**
 * ssh for the mgu-install tests: runs the remote command against a fake
 * root. Each call appends its arguments (JSON) to $FAKE_SSH_LOG. `ssh -V`
 * answers $FAKE_SSH_VERSION. The remote command runs under sh with the
 * environment in $FAKE_SSH_ENV (the fake root's), /var/opt, /proc and
 * /dev/shm/rawcodingdata pointed into that root, /usr/bin/node at this
 * Node, /usr/bin/nsm_control at nsm_control beside the ssh stand-in, the
 * boot id at the root's, and stdin passed through.
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
const remote = args[args.length - 1].split('/dev/shm/rawcodingdata').join(env.MGU_DEPLOY_CODING)
    .split('`/proc').join(`\`${env.MGU_DEPLOY_PROC}`).split('/var/opt').join(env.MGU_DEPLOY_VAR_OPT)
    .split('/usr/bin/node').join(env.FAKE_NODE).split('/usr/bin/nsm_control').join(require('path').join(require('path').dirname(process.env.FAKE_SSH_ENV), 'nsm_control'))
    .split('/proc/sys/kernel/random/boot_id').join(env.MGU_DEPLOY_BOOT_ID);
const r = cp.spawnSync('sh', ['-c', remote], { env, stdio: 'inherit' });
process.exit(r.status === null ? 255 : r.status);
