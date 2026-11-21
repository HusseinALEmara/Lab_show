// The device's own TURN relay: protocol checks with a minimal client, and real
// interoperability with Chromium's WebRTC (two peers forced to use only the relay).
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const {
    createTurnServer, buildMessage, parseMessage, longTermKey, encodeXorAddress, xorAddress, METHOD, CLASS, ATTR
} = require('../src/turn-server');

const REALM = 'labshow';

async function withServer(run, { allowed = ['127.0.0.1'] } = {}) {
    const server = createTurnServer({ relayAddress: '127.0.0.1', isAllowedPeer: (ip) => allowed.includes(ip) });
    const { port } = await server.start();
    server.addUser('ls-user', 'secret-pass');
    try {
        await run({ server, port });
    } finally {
        await server.stop();
    }
}

function client(port) {
    const socket = dgram.createSocket('udp4');
    const waiters = [];
    socket.on('message', (msg) => {
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
    });
    return {
        ready: new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)),
        send: (buffer) => socket.send(buffer, port, '127.0.0.1'),
        next: (ms = 1500) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no answer')), ms);
            waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
        }),
        close: () => socket.close()
    };
}

const tid = () => crypto.randomBytes(12);
const code = (msg) => {
    const value = parseMessage(msg).attrs.get(ATTR.ERROR_CODE);
    return value ? value[2] * 100 + value[3] : 0;
};

async function allocate(c, password = 'secret-pass') {
    c.send(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [[ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])]]));
    const challenge = parseMessage(await c.next());
    const nonce = challenge.attrs.get(ATTR.NONCE);
    const key = longTermKey('ls-user', REALM, password);
    const auth = [[ATTR.USERNAME, Buffer.from('ls-user')], [ATTR.REALM, Buffer.from(REALM)], [ATTR.NONCE, nonce]];
    c.send(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [[ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])], ...auth], key));
    return { response: await c.next(), challenge, key, auth };
}

test('TURN: unauthenticated requests are challenged, wrong passwords refused', () => withServer(async ({ port }) => {
    const c = client(port);
    await c.ready;
    try {
        c.send(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [[ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])]]));
        const challenge = await c.next();
        assert.equal(code(challenge), 401);
        assert.equal(parseMessage(challenge).attrs.get(ATTR.REALM).toString(), REALM);
        const { response } = await allocate(c, 'wrong');
        assert.equal(code(response), 401);
    } finally {
        c.close();
    }
}));

test('TURN: allocation, permission only towards this device, relaying both ways', () => withServer(async ({ port, server }) => {
    const c = client(port);
    await c.ready;
    const peer = dgram.createSocket('udp4');
    await new Promise((resolve) => peer.bind(0, '127.0.0.1', resolve));
    try {
        const { response, key, auth } = await allocate(c);
        const ok = parseMessage(response);
        assert.equal(ok.cls, CLASS.SUCCESS);
        const relayed = xorAddress(ok.attrs.get(ATTR.XOR_RELAYED_ADDRESS));
        assert.equal(relayed.address, '127.0.0.1');
        assert.equal(server.allocationCount, 1);

        // Never an open relay: a permission towards another address is forbidden.
        c.send(buildMessage(METHOD.CREATE_PERMISSION, CLASS.REQUEST, tid(),
            [[ATTR.XOR_PEER_ADDRESS, encodeXorAddress('8.8.8.8', 53)], ...auth], key));
        assert.equal(code(await c.next()), 403);

        const peerPort = peer.address().port;
        c.send(buildMessage(METHOD.CREATE_PERMISSION, CLASS.REQUEST, tid(),
            [[ATTR.XOR_PEER_ADDRESS, encodeXorAddress('127.0.0.1', peerPort)], ...auth], key));
        assert.equal(parseMessage(await c.next()).cls, CLASS.SUCCESS);

        // client -> peer (Send indication)
        const got = new Promise((resolve) => peer.once('message', (msg, rinfo) => resolve({ msg, rinfo })));
        c.send(buildMessage(METHOD.SEND, CLASS.INDICATION, tid(), [
            [ATTR.XOR_PEER_ADDRESS, encodeXorAddress('127.0.0.1', peerPort)], [ATTR.DATA, Buffer.from('to-peer')]
        ]));
        const delivered = await got;
        assert.equal(delivered.msg.toString(), 'to-peer');
        assert.equal(delivered.rinfo.port, relayed.port, 'sent from the relayed address');

        // peer -> client (Data indication)
        peer.send(Buffer.from('to-client'), relayed.port, '127.0.0.1');
        const data = parseMessage(await c.next());
        assert.equal(data.method, METHOD.DATA);
        assert.equal(data.attrs.get(ATTR.DATA).toString(), 'to-client');

        // Channels: bind, then ChannelData both ways.
        const channel = Buffer.from([0x40, 0x01, 0, 0]);
        c.send(buildMessage(METHOD.CHANNEL_BIND, CLASS.REQUEST, tid(), [
            [ATTR.CHANNEL_NUMBER, channel], [ATTR.XOR_PEER_ADDRESS, encodeXorAddress('127.0.0.1', peerPort)], ...auth
        ], key));
        assert.equal(parseMessage(await c.next()).cls, CLASS.SUCCESS);
        const viaChannel = new Promise((resolve) => peer.once('message', (msg) => resolve(msg.toString())));
        const payload = Buffer.from('chan');
        c.send(Buffer.concat([Buffer.from([0x40, 0x01, 0, payload.length]), payload]));
        assert.equal(await viaChannel, 'chan');
        peer.send(Buffer.from('back'), relayed.port, '127.0.0.1');
        const frame = await c.next();
        assert.equal(frame.readUInt16BE(0), 0x4001);
        assert.equal(frame.subarray(4, 4 + frame.readUInt16BE(2)).toString(), 'back');

        // Ending the session removes the user and frees its allocations.
        server.removeUser('ls-user');
        assert.equal(server.allocationCount, 0);
    } finally {
        peer.close();
        c.close();
    }
}));

test('TURN: only UDP relays are offered', () => withServer(async ({ port }) => {
    const c = client(port);
    await c.ready;
    try {
        c.send(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [[ATTR.REQUESTED_TRANSPORT, Buffer.from([6, 0, 0, 0])]]));
        const nonce = parseMessage(await c.next()).attrs.get(ATTR.NONCE);
        const key = longTermKey('ls-user', REALM, 'secret-pass');
        c.send(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [
            [ATTR.REQUESTED_TRANSPORT, Buffer.from([6, 0, 0, 0])],
            [ATTR.USERNAME, Buffer.from('ls-user')], [ATTR.REALM, Buffer.from(REALM)], [ATTR.NONCE, nonce]
        ], key));
        assert.equal(code(await c.next()), 442);
    } finally {
        c.close();
    }
}));

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }

test('TURN works with real Chromium WebRTC: two peers connected only through the relay',
    { skip: !playwright && 'playwright is not installed here' }, () => withServer(async ({ port }) => {
        const browser = await playwright.chromium.launch();
        try {
            const page = await browser.newPage();
            const result = await page.evaluate(async (turnPort) => {
                const config = {
                    iceServers: [{ urls: `turn:127.0.0.1:${turnPort}?transport=udp`, username: 'ls-user', credential: 'secret-pass' }],
                    iceTransportPolicy: 'relay'
                };
                const a = new RTCPeerConnection(config);
                const b = new RTCPeerConnection(config);
                const types = [];
                a.onicecandidate = (e) => { if (e.candidate) { types.push(e.candidate.type); b.addIceCandidate(e.candidate); } };
                b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };
                const channel = a.createDataChannel('x');
                const received = new Promise((resolve) => {
                    b.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(m.data); };
                });
                await a.setLocalDescription(await a.createOffer());
                await b.setRemoteDescription(a.localDescription);
                await b.setLocalDescription(await b.createAnswer());
                await a.setRemoteDescription(b.localDescription);
                await new Promise((resolve, reject) => {
                    channel.onopen = resolve;
                    setTimeout(() => reject(new Error(`not connected: ${a.iceConnectionState}`)), 10000);
                });
                channel.send('hello through the relay');
                const message = await received;
                const stats = await a.getStats();
                let pairType = null;
                stats.forEach((r) => {
                    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
                        pairType = stats.get(r.localCandidateId).candidateType;
                    }
                });
                return { message, types, pairType };
            }, port);
            assert.equal(result.message, 'hello through the relay');
            assert.ok(result.types.every((t) => t === 'relay'), JSON.stringify(result.types));
            assert.equal(result.pairType, 'relay');
        } finally {
            await browser.close();
        }
    }));
