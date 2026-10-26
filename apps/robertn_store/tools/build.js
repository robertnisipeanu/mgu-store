'use strict';
/**
 * Builds the Store's source package and, given a donor, its OAP tgz.
 *
 *   node tools/build.js [--sdk <donor .tgz|.js>]      (or MGU_SDK_DONOR)
 *
 *  1. Writes the RHMI files from tools/gen_rhmi.js.
 *  2. Copies mgu-updater's socket client (native/mgu-updater/js/client.js)
 *     to lib/client.js and mgu-render's (native/mgu-render/js/
 *     mgu_render_client.js) to lib/mgu_render_client.js, modules of the app
 *     (mgu-app.json), so this folder holds every file of the source package.
 *  3. Packs the source package robertn_store@<version>.src.tgz:
 *     mgu-app.json, the modules and the staged tree (tools/oap_link.js). The
 *     catalog publishes it as robertn_store@<version>.tgz with
 *     "build": "unit", and the head unit's deploy tool builds it.
 *  4. With a donor, builds the OAP tgz robertn_store@<version>.tgz from it,
 *     as the unit would: the modules linked against the donor's oap-sdk
 *     modules, the donor package's entry point as package.json's main,
 *     node --check, javascript/build.json, the flat tgz.
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const REPO = path.join(HERE, '..', '..');
const link = require(path.join(REPO, 'tools', 'oap_link.js'));

function donorArg(argv) {
    const i = argv.indexOf('--sdk');
    if (i >= 0) {
        if (!argv[i + 1]) {
            throw new Error('--sdk needs a donor .tgz or .js');
        }
        return path.resolve(argv[i + 1]);
    }
    return process.env.MGU_SDK_DONOR ? path.resolve(process.env.MGU_SDK_DONOR) : null;
}

function sync(fromRel, toRel) {
    const from = path.join(REPO, fromRel);
    const to = path.join(HERE, toRel);
    const data = fs.readFileSync(from);
    if (!fs.existsSync(to) || !fs.readFileSync(to).equals(data)) {
        fs.writeFileSync(to, data);
        console.error(`${toRel} written from ${fromRel}: commit it`);
    }
}

function main() {
    const donor = donorArg(process.argv.slice(2));
    require('./gen_rhmi.js').write();
    sync('native/mgu-updater/js/client.js', 'lib/client.js');
    sync('native/mgu-render/js/mgu_render_client.js', 'lib/mgu_render_client.js');
    const m = link.readManifest(HERE);
    const src = path.join(HERE, `${m.id}@${m.version}.src.tgz`);
    const out = { source: path.basename(src), sourceMembers: link.packSource(HERE, src).length };
    if (donor) {
        const r = link.build(HERE, path.join(HERE, `${m.id}@${m.version}.tgz`),
            { donors: [donor], epoch: process.env.SOURCE_DATE_EPOCH });
        Object.assign(out, { tgz: path.basename(r.file), donor: r.donor, main: r.entry, bundleModules: r.moduleCount,
            bundleBytes: r.bytes });
    }
    console.log(JSON.stringify(out, null, 2));
}

try {
    main();
} catch (e) {
    console.error(`build: ${e.message}`);
    process.exitCode = 1;
}
