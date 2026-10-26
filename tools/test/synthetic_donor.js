'use strict';
/**
 * A made-up donor for the linker and deploy tests: a browserify bundle
 * (browserify's own prelude, MIT) whose modules stand in for the oap-sdk
 * under the paths and require names the real one has. No SDK code.
 *
 *   const donor = require('<repo>/tools/test/synthetic_donor.js');
 *   donor.bundle()            the bundle text
 *   donor.tgz(file, opts)     an OAP package holding it as javascript/app.js
 *                             (opts.version: the oap-sdk version its package.json names;
 *                             opts.main: its package.json main, javascript/entry.js holding ENTRY)
 *   donor.ENTRY               a stand-in entry point: runs the bundle runnerConfig.json names
 */
const fs = require('fs');
const { tgz } = require('../oap_pack.js');

const PRELUDE = '(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;' +
    'if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module \'"+i+"\'");throw a.code="MODULE_NOT_FOUND",a}' +
    'var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}' +
    'return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()';

/* 1: the donor app's own entry; 2-4: the core; 5: reached only through a
 * relative require; 6: in no closure. */
const MODULES = [
    [1, 'const OnlineApp=require("oap-sdk/src/core/OnlineApp.js");const logging=require("oap-sdk/src/logging/logging");' +
        'const b=require("oap-sdk/src/someip/someipBuilders.js");',
    '{"oap-sdk/src/core/OnlineApp.js":2,"oap-sdk/src/logging/logging":3,"oap-sdk/src/someip/someipBuilders.js":4}'],
    [2, '"use strict";const logging_1=require("../logging/logging");const err=require("../errors/SDKError");' +
        'class OnlineApp{constructor(name){this.name=name;this.log=logging_1.getLogger()}}' +
        'exports.OnlineApp=OnlineApp;exports.SDKError=err.SDKError;',
    '{"../logging/logging":3,"../errors/SDKError":5}'],
    [3, '"use strict";const path=require("path");exports.getLogger=function(){return{info:function(){}}};exports.sep=path.sep;',
        '{"path":undefined}'],
    [4, '"use strict";const events=require("events");exports.someipBuilders={emitter:function(){return new events.EventEmitter()}};',
        '{"events":undefined}'],
    [5, '"use strict";class SDKError extends Error{}exports.SDKError=SDKError;', '{}'],
    [6, '"use strict";exports.unused=true;', '{}']
];

function bundle() {
    return `${PRELUDE}({${MODULES.map((m) => `${m[0]}:[function(require,module,exports){\n${m[1]}\n},${m[2]}]`).join(',')}},{},[1]);\n`;
}

const ENTRY = "'use strict';\nconst path = require('path');\n" +
    "const config = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'runnerConfig.json'), 'utf8'));\n" +
    'require(path.join(__dirname, config.JS_RELATIVE_PATH));\n';

function tgzFile(file, opts) {
    opts = opts || {};
    const pkg = { name: 'donor_app', version: '1.0.0', dependencies: { 'oap-sdk': opts.version || '9.8.7' } };
    const files = [{ name: 'javascript/app.js', data: Buffer.from(bundle()), mode: 0o644 }];
    if (opts.main) {
        pkg.main = opts.main;
        files.push({ name: 'javascript/entry.js', data: Buffer.from(ENTRY), mode: 0o644 });
    }
    files.push({ name: 'package.json', data: Buffer.from(JSON.stringify(pkg)), mode: 0o644 });
    fs.writeFileSync(file, tgz(files, 1700000000));
    return file;
}

module.exports = { bundle, tgz: tgzFile, ENTRY };
