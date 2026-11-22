const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTunnel, parseEnv } = require('../src/tunnel');

// A stand-in for the cloudflared program: prints what the real one prints.
function fakeSpawn(lines, { exitAfterMs = null } = {}) {
    const calls = [];
    const spawnFn = (binary, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; child.emit('exit', null); };
        calls.push({ binary, args, child });
        setTimeout(() => lines.forEach((line) => child.stderr.emit('data', Buffer.from(`${line}\n`))), 20);
        if (exitAfterMs !== null) setTimeout(() => child.emit('exit', 1), exitAfterMs);
        return child;
    };
    return { spawnFn, calls };
}

test('quick tunnel: starts cloudflared towards the local port and reads its public address', async () => {
    const fake = fakeSpawn([
        'INF Requesting new quick Tunnel on trycloudflare.com...',
        'INF |  https://silver-lake-moon.trycloudflare.com  |',
        'INF Registered tunnel connection connIndex=0'
    ]);
    const checked = [];
    const tunnel = createTunnel({
        binary: 'cloudflared', localPort: 47800, spawnFn: fake.spawnFn,
        dnsCheck: async (host) => { checked.push(host); return true; }
    });
    assert.equal(await tunnel.start(), 'https://silver-lake-moon.trycloudflare.com');
    assert.deepEqual(checked, ['silver-lake-moon.trycloudflare.com'], 'handed out only after its name resolves');
    assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:47800']);
    assert.equal(await tunnel.start(), 'https://silver-lake-moon.trycloudflare.com', 'started once, then reused');
    assert.equal(fake.calls.length, 1);
    tunnel.stop();
    assert.equal(fake.calls[0].child.killed, true);
    assert.equal(tunnel.url, null);
});

test('named tunnel (institution domain): runs with the token and uses the configured address', async () => {
    const fake = fakeSpawn(['INF Registered tunnel connection connIndex=0 location=fra08']);
    const tunnel = createTunnel({
        binary: 'cloudflared', localPort: 47800, token: 'eyJ-token', publicUrl: 'https://live.university.edu/', spawnFn: fake.spawnFn
    });
    assert.equal(await tunnel.start(), 'https://live.university.edu');
    assert.deepEqual(fake.calls[0].args, ['tunnel', '--no-autoupdate', 'run', '--token', 'eyJ-token']);
    tunnel.stop();
});

test('a quick tunnel is not handed out before it is registered and its name resolves', async () => {
    const onlyUrl = createTunnel({
        binary: 'x', localPort: 1, startTimeoutMs: 300, dnsCheck: async () => true,
        spawnFn: fakeSpawn(['INF |  https://early-bird.trycloudflare.com  |']).spawnFn
    });
    await assert.rejects(onlyUrl.start(), /in time/, 'no "registered" line yet: not ready');
    const noDns = createTunnel({
        binary: 'x', localPort: 1, dnsCheck: async () => false,
        spawnFn: fakeSpawn(['INF |  https://ghost-name.trycloudflare.com  |', 'INF Registered tunnel connection connIndex=0']).spawnFn
    });
    await assert.rejects(noDns.start(), /DNS/);
});

test('tunnel failures are reported, not hidden', async () => {
    const silent = createTunnel({ binary: 'x', localPort: 1, spawnFn: fakeSpawn(['nothing useful']).spawnFn, startTimeoutMs: 200 });
    await assert.rejects(silent.start(), /in time/);
    const crashing = createTunnel({ binary: 'x', localPort: 1, spawnFn: fakeSpawn([], { exitAfterMs: 50 }).spawnFn });
    await assert.rejects(crashing.start(), /exited/);
    const missing = createTunnel({ binary: 'x', localPort: 1, spawnFn: () => { throw new Error('ENOENT'); } });
    await assert.rejects(missing.start(), /ENOENT/);
});

test('.env: keys, comments, quotes; nothing else is read', () => {
    const values = parseEnv([
        '# a comment',
        'LABSHOW_PUBLIC_URL=https://live.university.edu',
        'LABSHOW_TURN_CREDENTIAL="pa ss=word"',
        "LABSHOW_PORT='47800'",
        'not a line',
        'lowercase=ignored',
        '  LABSHOW_TUNNEL = off  ',
        'LABSHOW_EMPTY='
    ].join('\r\n'));
    assert.deepEqual(values, {
        LABSHOW_PUBLIC_URL: 'https://live.university.edu',
        LABSHOW_TURN_CREDENTIAL: 'pa ss=word',
        LABSHOW_PORT: '47800',
        LABSHOW_TUNNEL: 'off',
        LABSHOW_EMPTY: ''
    });
});

test('the example settings file documents every setting the app reads', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const example = parseEnv(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8'));
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const used = new Set(Array.from(main.matchAll(/process\.env\.(LABSHOW_[A-Z_]+)/g), (m) => m[1]));
    for (const key of used) assert.ok(key in example, `${key} missing from .env.example`);
});
