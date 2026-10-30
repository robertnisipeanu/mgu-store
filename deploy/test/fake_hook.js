'use strict';
// A tool's activate and deactivate for the deploy tests, run from the
// tool's version folder as `node hook.js <activate|deactivate>`. Appends
// "<command> <version> cwd=<folder under var/opt> current=<current's
// target> unit=<yes|no: fixture-tool.service in place> active=<its state in
// fake_systemctl.sh>" to $FAKE_HOOK_LOG and prints a line on stdout and one
// on stderr. "<command>@<version>" listed in $FAKE_HOOK_SLOW sleeps 5 s
// first; listed in $FAKE_HOOK_FAIL, it exits 3. Its last stdout line is
// {"status", "reboot"}, "reboot" being $FAKE_HOOK_REBOOT when set.
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
console.log('hook ' + me + ' says hello');
console.error('hook ' + me + ' on stderr');
if (listed(env.FAKE_HOOK_FAIL)) {
    console.error('hook ' + me + ' failing as asked');
    process.exit(3);
}
const result = { status: me + ' done' };
if (env.FAKE_HOOK_REBOOT) {
    result.reboot = env.FAKE_HOOK_REBOOT;
}
console.log(JSON.stringify(result));
