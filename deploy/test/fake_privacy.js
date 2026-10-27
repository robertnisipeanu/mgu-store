'use strict';
// app-privacy's patch_mainapp.js for the deploy tests: apply and check
// report the patch in effect, with nothing changed. Each file's entry
// names its sha256 and whether it is the stock reference: the content of
// $FAKE_PRIVACY_STOCK_MAIN or $FAKE_PRIVACY_STOCK_APPMANAGEMENT. Without
// --main/--appmanagement, check reports $FAKE_PRIVACY_STATE when set and
// apply exits $FAKE_PRIVACY_APPLY_EXIT when set. Each command is appended
// to $FAKE_PRIVACY_LOG when it is set.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const argv = process.argv.slice(2);
if (env.FAKE_PRIVACY_LOG) {
    fs.appendFileSync(env.FAKE_PRIVACY_LOG, argv[0] + '\n');
}
const sha = (p) => {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    } catch (e) {
        return null;
    }
};
const src = path.join(env.MGU_DEPLOY_MAINAPP || '/usr/lib/oap-mainapp', 'src');
const paths = { main: path.join(src, 'main.js'), appmanagement: path.join(src, 'AppManagement', 'AppManagement.js') };
const stock = { main: env.FAKE_PRIVACY_STOCK_MAIN, appmanagement: env.FAKE_PRIVACY_STOCK_APPMANAGEMENT };
let explicit = false;
for (let i = 1; i < argv.length; i += 1) {
    if ((argv[i] === '--main' || argv[i] === '--appmanagement') && i + 1 < argv.length) {
        paths[argv[i].slice(2)] = argv[i + 1];
        explicit = true;
        i += 1;
    }
}
const files = Object.keys(paths).map((kind) => {
    const s = sha(paths[kind]);
    return { kind, path: paths[kind], sha256: s, reference: !!(s && stock[kind] && s === sha(stock[kind])),
        state: 'patched', patchedBy: null, problems: [] };
});
const state = argv[0] === 'check' && !explicit && env.FAKE_PRIVACY_STATE ? env.FAKE_PRIVACY_STATE : 'patched';
console.log(JSON.stringify({ version: 'fake', command: argv[0], state, changed: false, files, restartNeeded: false }));
if (argv[0] === 'apply' && !explicit && env.FAKE_PRIVACY_APPLY_EXIT) {
    process.exitCode = Number(env.FAKE_PRIVACY_APPLY_EXIT);
}
