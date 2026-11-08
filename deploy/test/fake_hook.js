'use strict';
// A tool's activate, deactivate and check for the deploy tests, run from the
// tool's folder as `node hook.js <activate|deactivate|check>`. Appends
// "<command> <version> cwd=<folder under var/opt> current=<current's
// target> unit=<yes|no: fixture-tool.service in place> active=<its state in
// fake_systemctl.sh>" to $FAKE_HOOK_LOG and prints a line on stdout and one
// on stderr. "<command>@<version>" listed in $FAKE_HOOK_SLOW sleeps 5 s
// first; listed in $FAKE_HOOK_FAIL, it exits 3. Its last stdout line is
// {"status", "reboot", "removeWhenUnused"}, "reboot" being $FAKE_HOOK_REBOOT
// (for the "<command>@<version>" $FAKE_HOOK_REBOOT_ON lists, when set) and a
// deactivate's "removeWhenUnused" the JSON in $FAKE_HOOK_UNUSED when set.
// Files on the root, each a JSON list of [<command>, <path>, ...] for the
// command that runs: $FAKE_HOOK_REPLACE [<command>, <path>] writes <path>
// again as carplay's patcher does (a temp file written with mode 0755,
// renamed over it); $FAKE_HOOK_CHMOD [<command>, <path>, <octal mode>,
// <uid>, <gid>] sets that mode (and owner, when given); $FAKE_HOOK_CREATE
// [<command>, <path>] writes a new file with mode 0600. $FAKE_HOOK_UMASK
// names a file the hook appends "<command> <its umask>" to, and
// $FAKE_HOOK_MARK one it writes.
const fs = require('fs');
const path = require('path');

const env = process.env;
const which = process.argv[2];
const version = JSON.parse(fs.readFileSync('component.json', 'utf8')).version;
const me = which + '@' + version;
const varOpt = fs.realpathSync(env.MGU_DEPLOY_VAR_OPT);
const tool = path.basename(path.dirname(path.dirname(process.cwd())));
const listed = (v) => (v || '').split(',').indexOf(me) >= 0;
let current = null;
try {
    current = fs.readlinkSync(path.join(varOpt, tool, 'current'));
} catch (e) { /* none */ }
let active = 'inactive';
try {
    active = fs.readFileSync(path.join(env.FAKE_UNITS, 'fixture-tool.service.active'), 'utf8').trim();
} catch (e) { /* never started */ }
const unit = fs.existsSync(path.join(env.MGU_DEPLOY_SYSTEMD, 'fixture-tool.service')) ? 'yes' : 'no';
fs.appendFileSync(env.FAKE_HOOK_LOG, which + ' ' + version + ' cwd=' + path.relative(varOpt, fs.realpathSync(process.cwd())) +
    ' current=' + current + ' unit=' + unit + ' active=' + active + '\n');
if (listed(env.FAKE_HOOK_SLOW)) {
    require('child_process').spawnSync('sleep', ['5'], { stdio: 'ignore' });
}
const ours = (v) => JSON.parse(v || '[]').filter((e) => e[0] === which);
if (env.FAKE_HOOK_UMASK) {
    fs.appendFileSync(env.FAKE_HOOK_UMASK, `${which} ${('000' + process.umask().toString(8)).slice(-4)}\n`);
}
ours(env.FAKE_HOOK_REPLACE).forEach(([, p]) => {
    fs.writeFileSync(`${p}.woc-tmp`, fs.readFileSync(p), { mode: 0o755 });
    fs.renameSync(`${p}.woc-tmp`, p);
});
ours(env.FAKE_HOOK_CHMOD).forEach(([, p, m, uid, gid]) => {
    if (uid !== undefined) {
        fs.chownSync(p, uid, gid);
    }
    fs.chmodSync(p, parseInt(m, 8));
});
ours(env.FAKE_HOOK_CREATE).forEach(([, p]) => fs.writeFileSync(p, 'backup\n', { mode: 0o600 }));
if (env.FAKE_HOOK_MARK) {
    fs.writeFileSync(env.FAKE_HOOK_MARK, me);
}
console.log('hook ' + me + ' says hello');
console.error('hook ' + me + ' on stderr');
if (listed(env.FAKE_HOOK_FAIL)) {
    console.error('hook ' + me + ' failing as asked');
    process.exit(3);
}
const result = { status: me + ' done' };
if (env.FAKE_HOOK_REBOOT && (!env.FAKE_HOOK_REBOOT_ON || listed(env.FAKE_HOOK_REBOOT_ON))) {
    result.reboot = env.FAKE_HOOK_REBOOT;
}
if (env.FAKE_HOOK_UNUSED && which === 'deactivate') {
    result.removeWhenUnused = JSON.parse(env.FAKE_HOOK_UNUSED);
}
console.log(JSON.stringify(result));
