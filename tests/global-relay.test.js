const test = require('node:test');
const assert = require('node:assert/strict');
const { createGlobalRelay } = require('../src/network/global-relay');
const { generateSessionCode, MAX_DURATION_MINUTES } = require('../src/config/session-fields');
const { connect, ask } = require('./helpers');

async function withRelay(run) {
    const relay = createGlobalRelay({ port: 0 });
    const { port } = await relay.start();
    const sockets = [];
    const open = async () => {
        const socket = await connect(port);
        sockets.push(socket);
        return socket;
    };
    try {
        await run({ relay, open });
    } finally {
        sockets.forEach((socket) => socket.disconnect());
        await relay.stop();
    }
}

test('the relay accepts the 12-character codes the app generates, and finds them', () => withRelay(async ({ open }) => {
    const host = await open();
    const code = generateSessionCode();
    const registered = await ask(host, 'relay:register', {
        code, username: 'teacher_1', endpoint: '192.168.1.10:50000', durationMinutes: 60
    });
    assert.equal(registered.ok, true, registered.message);

    const student = await open();
    const found = await ask(student, 'relay:find', { code: code.toLowerCase(), username: 'teacher_1' });
    assert.equal(found.ok, true);
    assert.equal(found.endpoint, '192.168.1.10:50000');
    assert.equal(found.token, undefined, 'a finder must not receive the owner token');

    assert.equal((await ask(student, 'relay:find', { code, username: 'someone' })).ok, false);
}));

test('the relay keeps rejecting malformed codes, names and endpoints', () => withRelay(async ({ open }) => {
    const host = await open();
    const base = { code: generateSessionCode(), username: 'teacher_1', endpoint: '10.0.0.2:4000' };
    assert.equal((await ask(host, 'relay:register', { ...base, code: 'ABC' })).ok, false);
    assert.equal((await ask(host, 'relay:register', { ...base, username: 'a b' })).ok, false);
    assert.equal((await ask(host, 'relay:register', { ...base, endpoint: 'http://x' })).ok, false);
    assert.equal((await ask(host, 'relay:register', { ...base, code: '123456' })).ok, true, 'legacy 6-digit codes');
}));

test('relay sessions last at most 8 hours, so the timer cannot overflow', () => withRelay(async ({ open }) => {
    const host = await open();
    const before = Date.now();
    const registered = await ask(host, 'relay:register', {
        code: generateSessionCode(), username: 'teacher_9', endpoint: '10.0.0.2:4000', durationMinutes: 1e9
    });
    assert.equal(registered.ok, true);
    assert.ok(registered.expiresAt <= Date.now() + MAX_DURATION_MINUTES * 60 * 1000);
    assert.ok(registered.expiresAt >= before + MAX_DURATION_MINUTES * 60 * 1000 - 1000);
}));

test('a session is removed by its owner token or when the owner disconnects', () => withRelay(async ({ relay, open }) => {
    const host = await open();
    const code = generateSessionCode();
    const { token } = await ask(host, 'relay:register', { code, username: 'teacher_3', endpoint: '10.0.0.2:4000' });
    assert.equal((await ask(host, 'relay:unregister', { code, token: 'wrong' })).ok, false);
    assert.equal((await ask(host, 'relay:unregister', { code, token })).ok, true);
    assert.equal(relay.sessions.size, 0);

    const other = await open();
    await ask(other, 'relay:register', { code, username: 'teacher_3', endpoint: '10.0.0.2:4000' });
    assert.equal(relay.sessions.size, 1);
    other.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(relay.sessions.size, 0);
}));
