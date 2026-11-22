// The isolated back end process and where the installed app keeps its files.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fork } = require('node:child_process');
const { chooseDataRoot, dataPaths, migrateFrom } = require('../src/app-storage');
const { connect, ask } = require('./helpers');

function startBackendProcess(config) {
    const child = fork(path.join(__dirname, '..', 'src', 'backend.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const messages = [];
    const waiters = [];
    child.on('message', (message) => {
        const waiter = waiters.findIndex((w) => w.match(message));
        if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
        else messages.push(message);
    });
    const next = (match, ms = 8000) => new Promise((resolve, reject) => {
        const found = messages.findIndex(match);
        if (found >= 0) return resolve(messages.splice(found, 1)[0]);
        const timer = setTimeout(() => reject(new Error('no message')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
    child.send({ type: 'start', config });
    return { child, next };
}

test('back end runs in its own process: the windows reach it only through its port and the secret', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'labshow-work-'));
    const secret = 'a'.repeat(64);
    const { child, next } = startBackendProcess({ secret, tunnelOff: true, workDir: work });
    try {
        const ready = await next((m) => m.type === 'ready');
        assert.ok(ready.info.port > 0);
        assert.notEqual(child.pid, process.pid, 'a separate process');
        assert.equal(ready.info.hostSecret, undefined, 'the secret is not echoed back');

        const health = await (await fetch(`http://127.0.0.1:${ready.info.port}/health`)).json();
        assert.deepEqual(health, { ok: true });
        const window = await connect(ready.info.port);
        assert.equal((await ask(window, 'host:register', { secret })).ok, true);
        assert.equal((await ask(window, 'host:register', { secret: 'b'.repeat(64) })).ok, false);
        const created = await ask(window, 'host:create', { durationMinutes: 20 }, 10000);
        assert.equal(created.ok, true);
        window.disconnect();

        // Local discovery is answered from inside the back end.
        child.send({ type: 'find-host', id: 7, code: 'ZZZZZZZZZZZZ' });
        const reply = await next((m) => m.type === 'reply' && m.id === 7);
        assert.equal(reply.result, null, 'an unknown code finds nobody');

        child.send({ type: 'stop' });
        await next((m) => m.type === 'stopped');
        await new Promise((resolve) => child.once('exit', resolve));
        await assert.rejects(fetch(`http://127.0.0.1:${ready.info.port}/health`), 'the port is closed after stopping');
    } finally {
        if (child.exitCode === null) child.kill();
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('restarting the back end on the same port and secret lets the windows reconnect', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'labshow-work-'));
    const secret = 'c'.repeat(64);
    const first = startBackendProcess({ secret, tunnelOff: true, workDir: work });
    const { info } = await first.next((m) => m.type === 'ready');
    first.child.kill('SIGKILL'); // a crash
    await new Promise((resolve) => first.child.once('exit', resolve));
    const second = startBackendProcess({ secret, port: info.port, tunnelOff: true, workDir: work });
    try {
        const again = await second.next((m) => m.type === 'ready');
        assert.equal(again.info.port, info.port);
        const window = await connect(info.port);
        assert.equal((await ask(window, 'host:register', { secret })).ok, true);
        window.disconnect();
    } finally {
        second.child.kill();
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('installed app: everything it writes goes to "data" inside its own folder', () => {
    const install = fs.mkdtempSync(path.join(os.tmpdir(), 'labshow-install-'));
    const exe = path.join(install, 'Lab show.exe');
    assert.equal(chooseDataRoot({ isPackaged: false, execPath: exe }), null, 'development keeps Electron defaults');
    const root = chooseDataRoot({ isPackaged: true, execPath: exe });
    assert.equal(root, path.join(install, 'data'));
    assert.equal(chooseDataRoot({ isPackaged: true, execPath: exe, canWrite: () => false }), null,
        'a read-only installation folder falls back to the default');
    const paths = dataPaths(root);
    for (const dir of Object.values(paths)) assert.ok(dir.startsWith(root + path.sep) || dir === root, dir);
    fs.rmSync(install, { recursive: true, force: true });
});

test('settings and .env from older versions are carried over once', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labshow-old-'));
    const newDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labshow-new-')), 'data');
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"blockNotifications":true}');
    fs.writeFileSync(path.join(oldDir, '.env'), 'LABSHOW_PORT=47800');
    assert.deepEqual(migrateFrom(oldDir, newDir), ['settings.json', '.env']);
    fs.writeFileSync(path.join(newDir, 'settings.json'), '{"blockNotifications":false}');
    assert.deepEqual(migrateFrom(oldDir, newDir), [], 'never overwrites newer data');
    assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"blockNotifications":false}');
});

test('the installer keeps the data folder on update and removes everything on uninstall', () => {
    const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    assert.match(nsh, /!macro customRemoveFiles[\s\S]*\$\{if\} \$\{isUpdated\}[\s\S]*!= "data"[\s\S]*\$\{else\}[\s\S]*SetOutPath "\$TEMP"\s*RMDir \/r "\$INSTDIR"/);
    const pkg = require('../package.json');
    assert.equal(pkg.build.nsis.oneClick, false, 'an installation window, not a silent one-click install');
    assert.equal(pkg.build.nsis.perMachine, false, 'installed for the user, in a folder the app can write to');
});
