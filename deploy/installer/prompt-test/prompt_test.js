'use strict';
/*
 * Tests first-install's restart question through deploy/install.ps1 on
 * Windows, in a console (a pseudo console from node-pty) and without one,
 * and that status's remote commands arrive whole:
 *
 *   node prompt_test.js <powershell.exe or pwsh.exe> <download base URL> <folder with the fake ssh.exe>
 *
 * The download base serves the installer release's files (SHA256SUMS and
 * the executables); the fake ssh.exe (fake_ssh.cs) plays a head unit that
 * needs a restart and has a read-only status. Runs as a file and as the
 * README's one-liner.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const pty = require('node-pty');
const { tgz, STATUS_HAS } = require('../../mgu-install.js');

const [shell, base, sshDir] = process.argv.slice(2);
const SCRIPT = path.resolve(__dirname, '..', '..', 'install.ps1');
const QUESTION = 'Restart the head unit now? [y/N]';
let failed = 0;

function check(name, ok, detail) {
    console.log(`${ok ? 'ok' : 'not ok'} - ${name}`);
    if (!ok) {
        failed += 1;
        console.log(String(detail || '').split('\n').map((l) => `  # ${l}`).join('\n'));
    }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* A folder first-install --from reads: a catalog with a deploy tool. */
function fromFolder(dir) {
    const sh = Buffer.from('exit 0\n');
    const component = Buffer.from(JSON.stringify({ id: 'mgu-deploy', kind: 'tool', version: '0.0.1',
        files: [{ path: 'mgu-deploy.sh', sha256: sha256(sh), mode: '0644' }] }));
    const art = tgz([{ name: 'component.json', data: component, mode: 0o644 }, { name: 'files/mgu-deploy.sh', data: sh, mode: 0o644 }],
        Math.floor(Date.now() / 1000));
    fs.writeFileSync(path.join(dir, 'mgu-deploy@0.0.1.tgz'), art);
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schema: 2, components: [{ id: 'mgu-deploy', kind: 'tool', version: '0.0.1',
        artifact: { name: 'mgu-deploy@0.0.1.tgz', size: art.length, sha256: sha256(art) } }] }));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-prompt-test-'));
const from = path.join(tmp, 'repo');
fs.mkdirSync(from);
fromFolder(from);
const quote = (a) => `'${a.replace(/'/g, "''")}'`;
const runs = (args) => ({
    'as a file': ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT].concat(args),
    'one-liner': ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `& ([scriptblock]::Create((Get-Content -Raw ${quote(SCRIPT)}))) ${args.map(quote).join(' ')}; exit $LASTEXITCODE`]
});
const RUNS = runs(['first-install', '--from', from, '--host', '127.0.0.1', '--no-renderer', '--no-uplink']);

function env(log) {
    const e = Object.assign({}, process.env, { MGU_INSTALL_DOWNLOAD: base, FAKE_SSH_LOG: log });
    // Windows names it Path; one entry, with the fake ssh first
    const key = Object.keys(e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    e[key] = `${sshDir};${e[key] || ''}`;
    // a prompt is never offered under CI; each PowerShell finds its own modules
    delete e.CI;
    delete e.PSModulePath;
    return e;
}

/* The run in a console, answer typed once the question shows. */
function inConsole(args, answer, log) {
    return new Promise((resolve) => {
        const p = pty.spawn(shell, args, { name: 'xterm', cols: 200, rows: 50, cwd: tmp, env: env(log) });
        let out = '';
        let sent = false;
        const timer = setTimeout(() => p.kill(), 180000);
        p.onData((d) => {
            out += d;
            if (!sent && out.includes(QUESTION)) {
                sent = true;
                p.write(`${answer}\r`);
            }
        });
        p.onExit(({ exitCode }) => {
            clearTimeout(timer);
            // the console's own escapes left out
            resolve({ status: exitCode, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '') });
        });
    });
}

const restarts = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.includes('nsm_control --requestRestart 7 --normal')).length;

(async () => {
    console.log(`${shell}, ${process.platform} ${process.arch}`);
    let n = 0;
    for (const [what, args] of Object.entries(RUNS)) {
        let log = path.join(tmp, `ssh-${n += 1}.log`);
        let r = await inConsole(args, 'y', log);
        check(`${what}: in a console, asks; y restarts the head unit, says so, exit 0`,
            r.status === 0 && r.out.includes(QUESTION) && r.out.includes('Restarting the head unit.') && restarts(log) === 1, r.out);
        log = path.join(tmp, `ssh-${n += 1}.log`);
        r = await inConsole(args, 'n', log);
        check(`${what}: in a console, n leaves it running, exit 0`,
            r.status === 0 && r.out.includes(QUESTION) && !r.out.includes('Restarting') && restarts(log) === 0, r.out);
        log = path.join(tmp, `ssh-${n += 1}.log`);
        r = await inConsole(args, '', log);
        check(`${what}: in a console, Enter leaves it running, exit 0`,
            r.status === 0 && r.out.includes(QUESTION) && !r.out.includes('Restarting') && restarts(log) === 0, r.out);
        log = path.join(tmp, `ssh-${n += 1}.log`);
        const p = cp.spawnSync(shell, args, { cwd: tmp, env: env(log), input: '', encoding: 'utf8', timeout: 180000 });
        check(`${what}: without a console, no question; ends with the restart line, exit 0`,
            p.status === 0 && !`${p.stdout}${p.stderr}`.includes('[y/N]') && p.stdout.trimEnd().endsWith('Restart the head unit to finish setup.') &&
            restarts(log) === 0, `${p.stdout}${p.stderr}`);
    }
    for (const [what, args] of Object.entries(runs(['status', '--host', '127.0.0.1']))) {
        const log = path.join(tmp, `ssh-${n += 1}.log`);
        const p = cp.spawnSync(shell, args, { cwd: tmp, env: env(log), input: '', encoding: 'utf8', timeout: 180000 });
        const remote = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
        check(`${what}: status runs the probe and status --read-only as sent, prints the status, exit 0`,
            p.status === 0 && p.stdout.includes('app robertn_store 0.9.35') && remote.length === 2 && remote[0] === STATUS_HAS &&
            remote[1] === 'sh /var/opt/mgu-deploy/mgu-deploy.sh status --read-only 2>&1', `${p.stdout}${p.stderr}\n${remote.join('\n')}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `${failed} failed` : 'all passed');
    process.exit(failed ? 1 : 0);
})();
