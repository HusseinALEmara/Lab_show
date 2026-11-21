// Integration tests of the signaling node: a real Express + Socket.IO + UDP server
// on this machine, driven by real Socket.IO clients playing the teacher window,
// students, and an outside web page.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { createLocalHostNode, UDP_DISCOVERY_PORT, isOnLocalSubnet, secretsMatch } = require('../src/server');
const { connect, ask, nextEvent, receivesWithin } = require('./helpers');

const RENDERER_LINK_CODE = /^(?:\d{6}|[A-Z2-9]{12})$/;

async function startNode() {
    const node = createLocalHostNode();
    const info = await node.start();
    const sockets = [];
    const open = async () => {
        const socket = await connect(info.port);
        sockets.push(socket);
        return socket;
    };
    const close = async () => {
        sockets.forEach((socket) => socket.disconnect());
        await node.stop();
    };
    return { node, info, open, close };
}

async function teacherWithSession(ctx, payload = { durationMinutes: 60 }) {
    const teacher = await ctx.open();
    assert.deepEqual(await ask(teacher, 'host:register', { secret: ctx.info.hostSecret }), { ok: true });
    const created = await ask(teacher, 'host:create', payload, 10000);
    assert.equal(created.ok, true, created.message);
    return { teacher, session: created.session };
}

async function sharingStudent(ctx, code, title, extra = {}) {
    const student = await ctx.open();
    const joined = await ask(student, 'student:join', { code, title, protocolVersion: 3, ...extra });
    assert.equal(joined.ok, true, joined.message);
    const preview = nextEvent(student, 'preview:start');
    student.emit('student:start');
    await preview;
    return { student, id: joined.studentId };
}

test('the node starts with a port, its addresses and a fresh 64-character host secret', async () => {
    const a = createLocalHostNode();
    const b = createLocalHostNode();
    const infoA = await a.start();
    const infoB = await b.start();
    try {
        assert.ok(infoA.port > 0);
        assert.ok(Array.isArray(infoA.ips));
        assert.match(infoA.hostSecret, /^[0-9a-f]{64}$/);
        assert.notEqual(infoA.hostSecret, infoB.hostSecret);
    } finally {
        await a.stop();
        await b.stop();
    }
});

test('a web page on the same computer cannot take the teacher role without the secret', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const { student, id } = await sharingStudent(ctx, session.code, 'Student');
        await ask(teacher, 'host:select', { studentId: id });
        await ask(student, 'student:permission', { enabled: true });

        // The outside page connects from 127.0.0.1 with a browser origin, as a real page would.
        const intruder = await connect(ctx.info.port, { extraHeaders: { origin: 'https://evil.example' } });
        try {
            assert.equal((await ask(intruder, 'host:register')).ok, false, 'no secret');
            assert.equal((await ask(intruder, 'host:register', { secret: 'guess' })).ok, false, 'wrong secret');
            assert.equal((await ask(intruder, 'host:register', { secret: ctx.info.hostSecret.slice(0, 63) + 'x' })).ok,
                false, 'almost-right secret');
            assert.equal((await ask(intruder, 'host:create', { durationMinutes: 20 })).ok, false, 'cannot replace the code');

            const keySeen = receivesWithin(student, 'control:key');
            const sent = await ask(intruder, 'host:key', { studentId: id, key: 'Enter' });
            assert.equal(sent.ok, false);
            assert.equal(await keySeen, false, 'the student received no key from the intruder');
        } finally {
            intruder.disconnect();
        }

        // The real teacher window still works after the attempt.
        const keySeen = nextEvent(student, 'control:key');
        assert.equal((await ask(teacher, 'host:key', { studentId: id, key: 'ArrowDown' })).ok, true);
        assert.deepEqual(await keySeen, { studentId: id, key: 'ArrowDown' });
    } finally {
        await ctx.close();
    }
});

test('local session: code, join with a title, select, permission, and keys to the selected student only', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        assert.match(session.code, /^[A-HJ-NP-Z2-9]{12}$/);
        assert.equal(session.networkMode, 'local');

        const states = [];
        teacher.on('session:state', (state) => states.push(state));
        const a = await sharingStudent(ctx, session.code.toLowerCase(), 'Ahmed Ali - Graduation Project');
        const b = await sharingStudent(ctx, session.code, 'Sara');
        assert.deepEqual([a.id, b.id], ['001', '002']);
        const last = states[states.length - 1];
        assert.deepEqual(last.students.map((s) => s.title), ['Ahmed Ali - Graduation Project', 'Sara']);

        // Keys before permission are refused.
        const selected = nextEvent(a.student, 'student:selected');
        assert.equal((await ask(teacher, 'host:select', { studentId: a.id })).ok, true);
        await selected;
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Enter' })).ok, false);

        // Both students allow control; only the selected one receives keys.
        const permissionSeen = nextEvent(teacher, 'control:permission');
        assert.equal((await ask(a.student, 'student:permission', { enabled: true })).ok, true);
        assert.deepEqual(await permissionSeen, { studentId: a.id, enabled: true });
        assert.equal((await ask(b.student, 'student:permission', { enabled: true })).ok, true);

        const bSeen = receivesWithin(b.student, 'control:key');
        const aSeen = nextEvent(a.student, 'control:key');
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Space' })).ok, true);
        assert.deepEqual(await aSeen, { studentId: a.id, key: 'Space' });
        assert.equal(await bSeen, false, 'the unselected student got nothing');
        assert.equal((await ask(teacher, 'host:key', { studentId: b.id, key: 'Space' })).ok, false);

        // Disallowed keys are refused even for the selected student.
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Delete' })).ok, false);

        // The student revokes; keys stop.
        assert.equal((await ask(a.student, 'student:permission', { enabled: false })).ok, true);
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Space' })).ok, false);

        // Title change reaches the teacher.
        const titleEvent = nextEvent(teacher, 'student:event');
        const updated = await ask(a.student, 'student:update-title', { title: 'Ahmed - Final' });
        assert.equal(updated.title, 'Ahmed - Final');
        assert.deepEqual(await titleEvent, { studentId: a.id, type: 'title-updated', title: 'Ahmed - Final' });
    } finally {
        await ctx.close();
    }
});

test('pausing revokes control and the teacher is told', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const a = await sharingStudent(ctx, session.code, 'A');
        await ask(teacher, 'host:select', { studentId: a.id });
        await ask(a.student, 'student:permission', { enabled: true });
        const paused = nextEvent(teacher, 'student:event');
        a.student.emit('student:pause');
        assert.deepEqual(await paused, { studentId: a.id, type: 'paused' });
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Enter' })).ok, false);
        assert.equal((await ask(a.student, 'student:permission', { enabled: true })).ok, false,
            'permission cannot be re-enabled while paused');
    } finally {
        await ctx.close();
    }
});

test('wrong code, ended session, and student leaving', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const stranger = await ctx.open();
        assert.equal((await ask(stranger, 'student:join', { code: 'ZZZZZZZZZZZZ', title: 'x' })).ok, false);

        const a = await sharingStudent(ctx, session.code, 'A');
        const left = nextEvent(teacher, 'student:event');
        a.student.disconnect();
        assert.deepEqual(await left, { studentId: a.id, type: 'left' });

        const b = await sharingStudent(ctx, session.code, 'B');
        const ended = nextEvent(b.student, 'session:ended');
        teacher.emit('host:delete');
        assert.equal((await ended).reason, 'deleted');
        const late = await ctx.open();
        assert.equal((await ask(late, 'student:join', { code: session.code, title: 'late' })).ok, false,
            'the code is removed when the session ends');
    } finally {
        await ctx.close();
    }
});

test('WebRTC signaling is relayed between the broadcaster and the teacher only', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const a = await sharingStudent(ctx, session.code, 'A');
        const b = await sharingStudent(ctx, session.code, 'B');

        const offerSeen = nextEvent(teacher, 'webrtc:offer');
        a.student.emit('student:offer', { studentId: a.id, offer: { type: 'offer', sdp: 'v=0-a' } });
        assert.deepEqual(await offerSeen, { studentId: a.id, offer: { type: 'offer', sdp: 'v=0-a' } });

        // A student cannot speak for another student.
        const spoofSeen = receivesWithin(teacher, 'webrtc:offer');
        b.student.emit('student:offer', { studentId: a.id, offer: { type: 'offer', sdp: 'spoof' } });
        assert.equal(await spoofSeen, false);

        const bSeen = receivesWithin(b.student, 'webrtc:answer');
        const answerSeen = nextEvent(a.student, 'webrtc:answer');
        teacher.emit('host:answer', { studentId: a.id, answer: { type: 'answer', sdp: 'v=0-t' } });
        assert.equal((await answerSeen).answer.sdp, 'v=0-t');
        assert.equal(await bSeen, false, 'the answer went to the broadcaster only');
    } finally {
        await ctx.close();
    }
});

test('global session: the link carries a code the interface accepts, and joining needs its username and token', async () => {
    const ctx = await startNode();
    try {
        const { session } = await teacherWithSession(ctx, {
            durationMinutes: 60, networkMode: 'global', username: 'teacher_1'
        });
        assert.equal(session.networkMode, 'global');
        const link = new URL(session.globalUrl);
        const code = link.searchParams.get('c');
        const token = link.searchParams.get('t');
        assert.equal(code, session.code);
        assert.ok(RENDERER_LINK_CODE.test(code), 'the student interface accepts the link code');
        assert.equal(link.searchParams.get('u'), 'teacher_1');
        assert.match(link.searchParams.get('e'), /^[^:]+:\d{2,5}$/);
        assert.match(link.searchParams.get('e'), new RegExp(`:${ctx.info.port}$`),
            'the endpoint is this broadcasting node itself, not a central server');

        const noToken = await ctx.open();
        assert.equal((await ask(noToken, 'student:join', { code, title: 'x', username: 'teacher_1' })).ok, false);
        const badToken = await ctx.open();
        assert.equal((await ask(badToken, 'student:join', {
            code, title: 'x', username: 'teacher_1', token: 'WRONGWRONGWR'
        })).ok, false);
        const badUser = await ctx.open();
        assert.equal((await ask(badUser, 'student:join', { code, title: 'x', username: 'other', token })).ok, false);

        await sharingStudent(ctx, code, 'Remote student', { username: 'teacher_1', token });
    } finally {
        await ctx.close();
    }
});

test("global session: the teacher's own screen share joins with the session identity", async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx, {
            durationMinutes: 60, networkMode: 'global', username: 'teacher_2'
        });
        // The teacher window receives username and token in its session state,
        // exactly what renderer/app.js now passes for "share my screen too".
        const selfIdentity = { username: session.username, token: session.relayToken };
        const self = await sharingStudent(ctx, session.code, 'بث الأستاذ', selfIdentity);
        assert.equal((await ask(teacher, 'host:select', { studentId: self.id })).ok, true);
    } finally {
        await ctx.close();
    }
});

test('global mode needs a valid unique name', async () => {
    const ctx = await startNode();
    try {
        const teacher = await ctx.open();
        await ask(teacher, 'host:register', { secret: ctx.info.hostSecret });
        const refused = await ask(teacher, 'host:create', { networkMode: 'global', username: 'a b' });
        assert.equal(refused.ok, false);
    } finally {
        await ctx.close();
    }
});

test('incompatible protocol versions are refused', async () => {
    const ctx = await startNode();
    try {
        const { session } = await teacherWithSession(ctx);
        const old = await ctx.open();
        assert.equal((await ask(old, 'student:join', { code: session.code, title: 'x', protocolVersion: 1 })).ok, false);
    } finally {
        await ctx.close();
    }
});

test('UDP discovery: the code owner answers with its port, and an active code is reported as taken', async () => {
    const ctx = await startNode();
    const probe = dgram.createSocket('udp4');
    try {
        const { session } = await teacherWithSession(ctx);
        await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
        const reply = (message) => new Promise((resolve) => {
            const timer = setTimeout(() => { probe.removeAllListeners('message'); resolve(null); }, 800);
            probe.once('message', (msg) => { clearTimeout(timer); resolve(msg.toString()); });
            probe.send(Buffer.from(message), UDP_DISCOVERY_PORT, '127.0.0.1');
        });
        assert.equal(await reply(`LAB_SHOW_FIND:${session.code}`), `LAB_SHOW_MATCH:${session.code}:${ctx.info.port}`);
        assert.equal(await reply('LAB_SHOW_FIND:ZZZZZZZZZZZZ'), null, 'other codes get no answer');
        assert.equal(await reply(`LAB_SHOW_CHECK_CODE:${session.code}`), `LAB_SHOW_CODE_TAKEN:${session.code}`);
    } finally {
        probe.close();
        await ctx.close();
    }
});

test('creating a code does not collide with its own UDP probe', async () => {
    // Before the fix, the node answered its own probe and every attempt counted as
    // "taken": 8 attempts x 350 ms before giving up, wherever broadcasts loop back.
    const ctx = await startNode();
    try {
        const teacher = await ctx.open();
        await ask(teacher, 'host:register', { secret: ctx.info.hostSecret });
        const started = Date.now();
        const created = await ask(teacher, 'host:create', { durationMinutes: 20 }, 10000);
        const elapsed = Date.now() - started;
        assert.equal(created.ok, true);
        assert.ok(elapsed < 1000, `code created in ${elapsed} ms`);
    } finally {
        await ctx.close();
    }
});

test('helpers: local-subnet check and constant-time secret comparison', () => {
    assert.equal(isOnLocalSubnet('127.0.0.1'), true);
    assert.equal(isOnLocalSubnet('::ffff:127.0.0.1'), true);
    assert.equal(isOnLocalSubnet('8.8.8.8'), false);
    assert.equal(isOnLocalSubnet('not-an-ip'), false);
    assert.equal(secretsMatch('abc', 'abc'), true);
    assert.equal(secretsMatch('abc', 'abd'), false);
    assert.equal(secretsMatch('abc', 'abcd'), false);
    assert.equal(secretsMatch('abc', undefined), false);
});

// ---------- global mode: no key control ----------

test('global session: allowing key control is refused, and keys cannot be sent', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx, { durationMinutes: 60, networkMode: 'global' });
        const token = new URL(session.globalUrl).searchParams.get('t');
        const a = await sharingStudent(ctx, session.code, 'Remote', { token });
        await ask(teacher, 'host:select', { studentId: a.id });
        const permission = await ask(a.student, 'student:permission', { enabled: true });
        assert.equal(permission.ok, false);
        assert.equal(permission.error, 'control-local-only');
        const keySeen = receivesWithin(a.student, 'control:key');
        const sent = await ask(teacher, 'host:key', { studentId: a.id, key: 'Enter' });
        assert.equal(sent.error, 'control-local-only');
        assert.equal(await keySeen, false);
    } finally {
        await ctx.close();
    }
});

test('local session still allows key control after the global block', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const a = await sharingStudent(ctx, session.code, 'Local');
        await ask(teacher, 'host:select', { studentId: a.id });
        assert.equal((await ask(a.student, 'student:permission', { enabled: true })).ok, true);
        assert.equal((await ask(teacher, 'host:key', { studentId: a.id, key: 'Enter' })).ok, true);
    } finally {
        await ctx.close();
    }
});

// ---------- global links carry the router's public address ----------

async function startNodeWith(resolvePublicEndpoint) {
    const node = createLocalHostNode({ resolvePublicEndpoint });
    const info = await node.start();
    const sockets = [];
    return {
        info,
        open: async () => { const s = await connect(info.port); sockets.push(s); return s; },
        close: async () => { sockets.forEach((s) => s.disconnect()); await node.stop(); }
    };
}

test('global code: the link holds the public address the router opened', async () => {
    const asked = [];
    const ctx = await startNodeWith(async (port) => {
        asked.push(port);
        return { reachable: true, ip: '203.0.113.9', port: 40404 };
    });
    try {
        const { session } = await teacherWithSession(ctx, { networkMode: 'global' });
        assert.deepEqual(asked, [ctx.info.port], 'the port asked for is this node\'s own port');
        assert.equal(new URL(session.globalUrl).searchParams.get('e'), '203.0.113.9:40404');
        assert.equal(session.reachability, 'internet');
    } finally {
        await ctx.close();
    }
});

test('global code: when the router cannot open a port, the reason is reported', async () => {
    const ctx = await startNodeWith(async () => ({ reachable: false, reason: 'cgnat' }));
    try {
        const { session } = await teacherWithSession(ctx, { networkMode: 'global' });
        assert.equal(session.reachability, 'cgnat');
        assert.match(new URL(session.globalUrl).searchParams.get('e'), new RegExp(`:${ctx.info.port}$`));
    } finally {
        await ctx.close();
    }
});

test('local code: the router is not asked', async () => {
    let asked = false;
    const ctx = await startNodeWith(async () => { asked = true; return null; });
    try {
        const { session } = await teacherWithSession(ctx);
        assert.equal(asked, false);
        assert.equal(session.reachability, 'lan');
    } finally {
        await ctx.close();
    }
});

// ---------- public broadcast (room) ----------

async function ownerWithRoom(ctx, payload = { title: 'Lecture', networkMode: 'local', ownerName: 'Host A' }) {
    const owner = await ctx.open();
    assert.deepEqual(await ask(owner, 'room:owner', { secret: ctx.info.hostSecret }), { ok: true });
    const created = await ask(owner, 'room:create', payload, 10000);
    assert.equal(created.ok, true, created.message);
    return { owner, room: created.room };
}

async function viewer(ctx, room, name) {
    const socket = await ctx.open();
    const link = new URL(room.link);
    const joined = await ask(socket, 'room:join', {
        code: link.searchParams.get('c'), token: link.searchParams.get('t'), name, protocolVersion: 3
    });
    assert.equal(joined.ok, true, joined.message);
    return { socket, id: joined.viewerId, joined };
}

test('room: only this computer\'s window with the secret can own a public broadcast', async () => {
    const ctx = await startNode();
    try {
        const intruder = await ctx.open();
        assert.equal((await ask(intruder, 'room:owner', { secret: 'nope' })).ok, false);
        assert.equal((await ask(intruder, 'room:create', { title: 'x' })).ok, false);
    } finally {
        await ctx.close();
    }
});

test('room: code and link, joining, participants and comments for everyone', async () => {
    const ctx = await startNode();
    try {
        const { owner, room } = await ownerWithRoom(ctx);
        assert.match(room.code, /^[A-HJ-NP-Z2-9]{12}$/);
        const link = new URL(room.link);
        assert.equal(link.searchParams.get('k'), 'r');
        assert.equal(link.searchParams.get('c'), room.code);
        assert.match(link.searchParams.get('e'), new RegExp(`:${ctx.info.port}$`), 'this device serves its own broadcast');

        const stranger = await ctx.open();
        assert.equal((await ask(stranger, 'room:join', { code: room.code, token: 'WRONGWRONGWR' })).error, 'bad-token');
        assert.equal((await ask(stranger, 'room:join', { code: room.code })).error, 'bad-token');

        const joinedSeen = nextEvent(owner, 'room:viewer-joined');
        const a = await viewer(ctx, room, 'Sara');
        assert.equal((await joinedSeen).viewerId, a.id);
        assert.equal(a.joined.room.title, 'Lecture');

        const listSeen = nextEvent(a.socket, 'room:participants');
        const b = await viewer(ctx, room, 'Omar');
        assert.deepEqual((await listSeen).map((p) => p.name), ['Host A', 'Sara', 'Omar']);

        // A comment from a viewer reaches the owner and every viewer.
        const seen = [nextEvent(owner, 'room:comment'), nextEvent(a.socket, 'room:comment'), nextEvent(b.socket, 'room:comment')];
        assert.equal((await ask(b.socket, 'room:comment', { text: 'Question about slide 3' })).ok, true);
        for (const comment of await Promise.all(seen)) {
            assert.equal(comment.text, 'Question about slide 3');
            assert.equal(comment.name, 'Omar');
        }
        // The owner's comment is marked as the owner's.
        const ownerComment = nextEvent(a.socket, 'room:comment');
        await ask(owner, 'room:comment', { text: 'Welcome' });
        assert.equal((await ownerComment).isOwner, true);

        // A late viewer gets the history.
        const c = await viewer(ctx, room, 'Late');
        assert.deepEqual(c.joined.room.comments.map((x) => x.text), ['Question about slide 3', 'Welcome']);

        // Someone not in the room cannot comment.
        assert.equal((await ask(stranger, 'room:comment', { text: 'spam' })).error, 'not-in-room');
    } finally {
        await ctx.close();
    }
});

test('room: microphones show for everyone', async () => {
    const ctx = await startNode();
    try {
        const { owner, room } = await ownerWithRoom(ctx);
        const a = await viewer(ctx, room, 'Sara');
        const updated = new Promise((resolve) => {
            owner.on('room:participants', (list) => {
                if (list.some((p) => p.id === a.id && p.micOn)) resolve(list);
            });
        });
        a.socket.emit('room:mic', { on: true });
        const list = await Promise.race([updated, new Promise((_, reject) => setTimeout(() => reject(new Error('no update')), 3000))]);
        assert.equal(list.find((p) => p.id === a.id).micOn, true);
    } finally {
        await ctx.close();
    }
});

test('room: WebRTC signaling goes owner -> one viewer, and viewer -> owner only', async () => {
    const ctx = await startNode();
    try {
        const { owner, room } = await ownerWithRoom(ctx);
        const a = await viewer(ctx, room, 'A');
        const b = await viewer(ctx, room, 'B');

        const bSeen = receivesWithin(b.socket, 'room:signal');
        const aSeen = nextEvent(a.socket, 'room:signal');
        owner.emit('room:signal', { to: a.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
        assert.deepEqual(await aSeen, { from: 'owner', data: { sdp: { type: 'offer', sdp: 'v=0' } } });
        assert.equal(await bSeen, false, 'other viewers do not see it');

        const ownerSeen = nextEvent(owner, 'room:signal');
        const aEcho = receivesWithin(a.socket, 'room:signal');
        b.socket.emit('room:signal', { to: a.id, data: { sdp: { type: 'answer', sdp: 'v=0-b' } } });
        assert.deepEqual(await ownerSeen, { from: b.id, data: { sdp: { type: 'answer', sdp: 'v=0-b' } } },
            'a viewer cannot address another viewer; it always reaches the owner, under its own id');
        assert.equal(await aEcho, false);
    } finally {
        await ctx.close();
    }
});

test('room: removing a viewer, ending, and the owner leaving', async () => {
    const ctx = await startNode();
    try {
        const { owner, room } = await ownerWithRoom(ctx);
        const a = await viewer(ctx, room, 'A');
        const removed = nextEvent(a.socket, 'room:ended');
        owner.emit('room:kick', { viewerId: a.id });
        assert.equal((await removed).reason, 'removed');

        const b = await viewer(ctx, room, 'B');
        const ended = nextEvent(b.socket, 'room:ended');
        owner.emit('room:end');
        assert.equal((await ended).reason, 'ended');
        const late = await ctx.open();
        assert.equal((await ask(late, 'room:join', { code: room.code, token: 'X' })).error, 'no-room');

        const second = await ask(owner, 'room:create', { title: 'Again' }, 10000);
        const c = await viewer(ctx, second.room, 'C');
        const gone = nextEvent(c.socket, 'room:ended');
        owner.disconnect();
        assert.equal((await gone).reason, 'owner-left');
    } finally {
        await ctx.close();
    }
});

test('a device can receive private broadcasts and run a public broadcast at the same time', async () => {
    const ctx = await startNode();
    try {
        const { teacher, session } = await teacherWithSession(ctx);
        const { room } = await ownerWithRoom(ctx);
        const sender = await sharingStudent(ctx, session.code, 'Sender');
        const watcher = await viewer(ctx, room, 'Watcher');
        assert.notEqual(session.code, room.code);
        assert.equal((await ask(teacher, 'host:select', { studentId: sender.id })).ok, true);
        assert.ok(watcher.id.startsWith('v'));
    } finally {
        await ctx.close();
    }
});
