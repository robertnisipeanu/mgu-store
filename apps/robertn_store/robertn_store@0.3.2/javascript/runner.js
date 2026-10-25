/**
 * store package entry point (package.json "main").
 *
 * Loads the browserify bundle in ./app.js inside a vm context, using a
 * V8 bytecode cache under ../../data when one is available. Bytecode is
 * produced by re-invoking this file as a child process with the
 * outOfProcessCompile argument, so a failed compile cannot take the
 * parent down with it. Stale vsomeip sockets owned by this uid are
 * removed from /tmp before the bundle starts. An optional
 * runnerConfig.json next to this file may override the data and bundle
 * locations. These are the entry-point duties every stock OAP package
 * performs in its main file; the bundle itself carries the app.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');
const vm = require('vm');

let DATA_RELATIVE_PATH = '../../data';
let JS_RELATIVE_PATH = './app.js';

const CONFIG_PATH = path.join(__dirname, 'runnerConfig.json');
if (fs.existsSync(CONFIG_PATH)) {
    const read = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    DATA_RELATIVE_PATH = read.DATA_RELATIVE_PATH || DATA_RELATIVE_PATH;
    JS_RELATIVE_PATH = read.JS_RELATIVE_PATH || JS_RELATIVE_PATH;
}

const JS_ABSOLUTE_PATH = path.join(__dirname, JS_RELATIVE_PATH);
const DATA_ABSOLUTE_PATH = path.join(__dirname, DATA_RELATIVE_PATH);
const BYTECODE_ABSOLUTE_PATH = path.join(DATA_ABSOLUTE_PATH, `${JS_RELATIVE_PATH}.bytecode`);
const CHILD_PROCESS_FLAG = 'outOfProcessCompile';
const DEBUG_FLAG = '--inspect';
const SOCKET_DIR = '/tmp/';

const readFileAsync = util.promisify(fs.readFile);
const readdirAsync = util.promisify(fs.readdir);
const statAsync = util.promisify(fs.stat);
const unlinkAsync = util.promisify(fs.unlink);

function generateByteCodeAsChild() {
    const jsData = fs.readFileSync(JS_ABSOLUTE_PATH, 'utf-8');
    const script = new vm.Script(jsData, { produceCachedData: true });
    try {
        fs.writeFileSync(BYTECODE_ABSOLUTE_PATH, script.cachedData);
    } catch (err) {
        console.error(`bytecode write failed: ${err}`);
        try {
            fs.writeFileSync(BYTECODE_ABSOLUTE_PATH, Buffer.alloc(0));
        } catch (ignored) {
            console.error(`bytecode clear failed: ${ignored}`);
        }
        process.exit(1);
    }
    process.exit(0);
}

let generationAttempted = false;

function generateBytecode() {
    if (generationAttempted) {
        return Promise.reject(new Error('bytecode generation already attempted'));
    }
    generationAttempted = true;
    const childProcess = require('child_process');
    const child = childProcess.fork(
        process.argv[1],
        process.argv.slice(2).concat([CHILD_PROCESS_FLAG]),
        { stdio: 'inherit' });
    return new Promise((resolve, reject) => {
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`bytecode child exited code=${code} signal=${signal}`));
            }
        });
    });
}

function ensureBytecodeLocationExists() {
    const dir = path.dirname(BYTECODE_ABSOLUTE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function runVmScript(script) {
    const context = Object.assign({}, global, {
        require,
        console,
        exports: {},
        module: { exports: {} },
        process,
        __dirname
    });
    context.global = context;
    script.runInNewContext(context);
}

function cleanupAppFiles() {
    const uid = process.getuid();
    return readdirAsync(SOCKET_DIR)
        .then((files) => Promise.all(files.map((file) => {
            if (!file.startsWith('vsomeip-')) {
                return Promise.resolve();
            }
            return statAsync(path.join(SOCKET_DIR, file))
                .then((statObj) => {
                    const fileAge = Math.abs(statObj.birthtimeMs - Date.now());
                    if (statObj.uid !== uid || fileAge < process.uptime() * 1000) {
                        return Promise.resolve();
                    }
                    return unlinkAsync(path.join(SOCKET_DIR, file)).catch((err) =>
                        console.log(`cleanupSomeip: failed to delete ${file}: ${err}`));
                })
                .catch(() => Promise.resolve());
        })))
        .then(() => undefined)
        .catch((err) => console.log(`cleanupSomeip: ${err}`));
}

function runWithoutBytecode(jsData) {
    if (fs.existsSync(BYTECODE_ABSOLUTE_PATH)) {
        fs.unlinkSync(BYTECODE_ABSOLUTE_PATH);
    }
    runVmScript(new vm.Script(jsData, { produceCachedData: false }));
}

async function run() {
    if (process.argv.includes(CHILD_PROCESS_FLAG)) {
        generateByteCodeAsChild();
        return;
    }
    const cleanupPromise = cleanupAppFiles();
    const jsData = await readFileAsync(JS_ABSOLUTE_PATH, 'utf-8');
    try {
        if (!fs.existsSync(BYTECODE_ABSOLUTE_PATH)) {
            ensureBytecodeLocationExists();
            await generateBytecode();
        }
        let script = new vm.Script(jsData, {
            cachedData: await readFileAsync(BYTECODE_ABSOLUTE_PATH),
            produceCachedData: false
        });
        if (script.cachedDataRejected) {
            await generateBytecode();
            script = new vm.Script(jsData, {
                cachedData: await readFileAsync(BYTECODE_ABSOLUTE_PATH),
                produceCachedData: false
            });
            if (script.cachedDataRejected) {
                throw new Error('regenerated bytecode rejected');
            }
        }
        await cleanupPromise;
        runVmScript(script);
    } catch (err) {
        console.error(`bytecode path failed (${err}), running without bytecode`);
        await cleanupPromise;
        runWithoutBytecode(jsData);
    }
}

if (module.parent) {
    module.exports = { run };
} else if (process.execArgv.find((arg) => arg.startsWith(DEBUG_FLAG))) {
    require(JS_ABSOLUTE_PATH);
} else {
    run().catch((err) => {
        console.error(err);
        console.error('Could not start, exit');
        process.exit(1);
    });
}
