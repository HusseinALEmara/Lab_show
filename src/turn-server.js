const dgram = require('node:dgram');
const crypto = require('node:crypto');

// A small TURN server (RFC 5766 / RFC 8656, UDP) that this device runs for its own
// global sessions. When two devices are both behind home routers, a direct WebRTC
// path often cannot be opened (the routers rewrite ports). The device that made the
// code is the server of its session, so it also offers this relay: the remote device
// sends its media to the relay's port (opened on the router through UPnP), and the
// relay hands it to the app on this same device.
//
// It only ever relays to this device's own addresses: it can never be used as an open
// relay towards anyone else on the internet. Only users of active sessions (random
// per-session credentials) can allocate.
const MAGIC = 0x2112a442;
const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
const CLASS = { REQUEST: 0x000, INDICATION: 0x010, SUCCESS: 0x100, ERROR: 0x110 };
const ATTR = {
    MAPPED_ADDRESS: 0x0001, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009,
    CHANNEL_NUMBER: 0x000c, LIFETIME: 0x000d, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014,
    NONCE: 0x0015, XOR_RELAYED_ADDRESS: 0x0016, REQUESTED_TRANSPORT: 0x0019, XOR_MAPPED_ADDRESS: 0x0020,
    SOFTWARE: 0x8022, FINGERPRINT: 0x8028
};
const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;
const PERMISSION_LIFETIME = 300;
const CHANNEL_LIFETIME = 600;
const MAX_ALLOCATIONS = 100;

function messageType(method, cls) {
    // Method bits are interleaved with the two class bits (RFC 5389 section 6).
    return ((method & 0x0f80) << 2) | ((method & 0x0070) << 1) | (method & 0x000f) | cls;
}

function parseType(type) {
    const method = ((type & 0x3e00) >> 2) | ((type & 0x00e0) >> 1) | (type & 0x000f);
    return { method, cls: type & 0x0110 };
}

function parseMessage(buffer) {
    if (buffer.length < 20 || (buffer[0] & 0xc0) !== 0 || buffer.readUInt32BE(4) !== MAGIC) return null;
    const length = buffer.readUInt16BE(2);
    if (length + 20 > buffer.length || length % 4 !== 0) return null;
    const { method, cls } = parseType(buffer.readUInt16BE(0));
    const attrs = new Map();
    let integrityOffset = -1;
    let offset = 20;
    while (offset + 4 <= 20 + length) {
        const type = buffer.readUInt16BE(offset);
        const size = buffer.readUInt16BE(offset + 2);
        if (offset + 4 + size > 20 + length) return null;
        if (type === ATTR.MESSAGE_INTEGRITY) integrityOffset = offset;
        if (!attrs.has(type)) attrs.set(type, buffer.subarray(offset + 4, offset + 4 + size));
        if (type === ATTR.XOR_PEER_ADDRESS) {
            const list = attrs.get('peers') || [];
            list.push(buffer.subarray(offset + 4, offset + 4 + size));
            attrs.set('peers', list);
        }
        offset += 4 + size + ((4 - (size % 4)) % 4);
    }
    return { method, cls, transactionId: buffer.subarray(8, 20), attrs, integrityOffset, raw: buffer.subarray(0, 20 + length) };
}

function xorAddress(value, transactionId) {
    if (!value || value.length < 8 || value[1] !== 0x01) return null; // IPv4 only
    const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
    const ip = (value.readUInt32BE(4) ^ MAGIC) >>> 0;
    return { address: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
}

function encodeXorAddress(address, port) {
    const buffer = Buffer.alloc(8);
    buffer[1] = 0x01;
    buffer.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
    const parts = address.split('.').map(Number);
    const ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    buffer.writeUInt32BE((ip ^ MAGIC) >>> 0, 4);
    return buffer;
}

function attribute(type, value) {
    const padding = (4 - (value.length % 4)) % 4;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value, Buffer.alloc(padding)]);
}

// Builds a message; with `key`, appends MESSAGE-INTEGRITY over everything before it.
function buildMessage(method, cls, transactionId, attributes, key = null) {
    let body = Buffer.concat(attributes.map(([type, value]) => attribute(type, value)));
    const header = Buffer.alloc(20);
    header.writeUInt16BE(messageType(method, cls), 0);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    if (key) {
        header.writeUInt16BE(body.length + 24, 2);
        const hmac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
        body = Buffer.concat([body, attribute(ATTR.MESSAGE_INTEGRITY, hmac)]);
    }
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
}

function longTermKey(username, realm, password) {
    return crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();
}

function integrityValid(message, key) {
    if (message.integrityOffset < 0) return false;
    const copy = Buffer.from(message.raw.subarray(0, message.integrityOffset));
    copy.writeUInt16BE(message.integrityOffset - 20 + 24, 2);
    const expected = crypto.createHmac('sha1', key).update(copy).digest();
    const given = message.raw.subarray(message.integrityOffset + 4, message.integrityOffset + 24);
    return given.length === 20 && crypto.timingSafeEqual(expected, given);
}

function createTurnServer({
    port = 0,
    realm = 'labshow',
    relayAddress,
    isAllowedPeer,
    now = Date.now
}) {
    const users = new Map(); // username -> password
    const allocations = new Map(); // "ip:port" -> allocation
    const nonce = crypto.randomBytes(12).toString('hex');
    let socket = null;
    let sweepTimer = null;

    function send(buffer, rinfo) {
        if (socket) socket.send(buffer, rinfo.port, rinfo.address);
    }

    function error(message, rinfo, code, reason, key = null, extra = []) {
        const value = Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(reason)]);
        send(buildMessage(message.method, CLASS.ERROR, message.transactionId, [[ATTR.ERROR_CODE, value], ...extra], key), rinfo);
    }

    // Long-term credential check (RFC 5389 section 10.2). Returns the key, or null after
    // answering 401 / 438 itself.
    function authenticate(message, rinfo) {
        const username = message.attrs.get(ATTR.USERNAME);
        const given = message.attrs.get(ATTR.NONCE);
        const challenge = [[ATTR.REALM, Buffer.from(realm)], [ATTR.NONCE, Buffer.from(nonce)]];
        if (!username || message.integrityOffset < 0) {
            error(message, rinfo, 401, 'Unauthorized', null, challenge);
            return null;
        }
        if (!given || given.toString() !== nonce) {
            error(message, rinfo, 438, 'Stale Nonce', null, challenge);
            return null;
        }
        const password = users.get(username.toString());
        const key = password ? longTermKey(username.toString(), realm, password) : null;
        if (!key || !integrityValid(message, key)) {
            error(message, rinfo, 401, 'Unauthorized', null, challenge);
            return null;
        }
        return { key, username: username.toString() };
    }

    function closeAllocation(id) {
        const allocation = allocations.get(id);
        if (!allocation) return;
        allocations.delete(id);
        try { allocation.relay.close(); } catch { /* closed */ }
    }

    function permitted(allocation, address) {
        const expires = allocation.permissions.get(address);
        return Boolean(expires && expires > now());
    }

    function onRelayMessage(allocation, data, peer) {
        if (!permitted(allocation, peer.address)) return;
        const channel = allocation.channelByPeer.get(`${peer.address}:${peer.port}`);
        if (channel && channel.expires > now()) {
            const header = Buffer.alloc(4);
            header.writeUInt16BE(channel.number, 0);
            header.writeUInt16BE(data.length, 2);
            send(Buffer.concat([header, data, Buffer.alloc((4 - (data.length % 4)) % 4)]), allocation.client);
            return;
        }
        send(buildMessage(METHOD.DATA, CLASS.INDICATION, crypto.randomBytes(12), [
            [ATTR.XOR_PEER_ADDRESS, encodeXorAddress(peer.address, peer.port)],
            [ATTR.DATA, data]
        ]), allocation.client);
    }

    function lifetimeFrom(message) {
        const value = message.attrs.get(ATTR.LIFETIME);
        const asked = value && value.length === 4 ? value.readUInt32BE(0) : DEFAULT_LIFETIME;
        return Math.min(asked, MAX_LIFETIME);
    }

    function handleAllocate(message, rinfo, id) {
        const auth = authenticate(message, rinfo);
        if (!auth) return;
        const existing = allocations.get(id);
        if (existing) {
            if (existing.transactionId.equals(message.transactionId)) return sendAllocateSuccess(existing, message, auth.key);
            return error(message, rinfo, 437, 'Allocation Mismatch', auth.key);
        }
        const transport = message.attrs.get(ATTR.REQUESTED_TRANSPORT);
        if (!transport || transport[0] !== 17) return error(message, rinfo, 442, 'Unsupported Transport Protocol', auth.key);
        if (allocations.size >= MAX_ALLOCATIONS) return error(message, rinfo, 486, 'Allocation Quota Reached', auth.key);

        const relay = dgram.createSocket('udp4');
        const allocation = {
            client: { address: rinfo.address, port: rinfo.port },
            username: auth.username,
            transactionId: Buffer.from(message.transactionId),
            relay,
            relayPort: 0,
            expires: now() + lifetimeFrom(message) * 1000,
            permissions: new Map(),
            channels: new Map(),
            channelByPeer: new Map()
        };
        relay.on('message', (data, peer) => onRelayMessage(allocation, data, peer));
        relay.on('error', () => closeAllocation(id));
        relay.bind(0, relayAddress, () => {
            allocation.relayPort = relay.address().port;
            allocations.set(id, allocation);
            sendAllocateSuccess(allocation, message, auth.key);
        });
    }

    function sendAllocateSuccess(allocation, message, key) {
        const lifetime = Buffer.alloc(4);
        lifetime.writeUInt32BE(Math.max(0, Math.round((allocation.expires - now()) / 1000)), 0);
        send(buildMessage(METHOD.ALLOCATE, CLASS.SUCCESS, message.transactionId, [
            [ATTR.XOR_RELAYED_ADDRESS, encodeXorAddress(relayAddress, allocation.relayPort)],
            [ATTR.XOR_MAPPED_ADDRESS, encodeXorAddress(allocation.client.address, allocation.client.port)],
            [ATTR.LIFETIME, lifetime]
        ], key), allocation.client);
    }

    function handleRequest(message, rinfo, id) {
        if (message.method === METHOD.BINDING) {
            send(buildMessage(METHOD.BINDING, CLASS.SUCCESS, message.transactionId, [
                [ATTR.XOR_MAPPED_ADDRESS, encodeXorAddress(rinfo.address, rinfo.port)]
            ]), rinfo);
            return;
        }
        if (message.method === METHOD.ALLOCATE) return handleAllocate(message, rinfo, id);

        const auth = authenticate(message, rinfo);
        if (!auth) return;
        const allocation = allocations.get(id);
        if (!allocation || allocation.username !== auth.username) {
            return error(message, rinfo, 437, 'Allocation Mismatch', auth.key);
        }

        if (message.method === METHOD.REFRESH) {
            const lifetime = lifetimeFrom(message);
            if (lifetime === 0) closeAllocation(id);
            else allocation.expires = now() + lifetime * 1000;
            const value = Buffer.alloc(4);
            value.writeUInt32BE(lifetime, 0);
            send(buildMessage(METHOD.REFRESH, CLASS.SUCCESS, message.transactionId, [[ATTR.LIFETIME, value]], auth.key), rinfo);
            return;
        }

        const peers = (message.attrs.get('peers') || []).map((value) => xorAddress(value));
        if (!peers.length || peers.some((peer) => !peer)) return error(message, rinfo, 400, 'Bad Request', auth.key);
        if (peers.some((peer) => !isAllowedPeer(peer.address))) return error(message, rinfo, 403, 'Forbidden', auth.key);

        if (message.method === METHOD.CREATE_PERMISSION) {
            for (const peer of peers) allocation.permissions.set(peer.address, now() + PERMISSION_LIFETIME * 1000);
            send(buildMessage(METHOD.CREATE_PERMISSION, CLASS.SUCCESS, message.transactionId, [], auth.key), rinfo);
            return;
        }
        if (message.method === METHOD.CHANNEL_BIND) {
            const value = message.attrs.get(ATTR.CHANNEL_NUMBER);
            const number = value && value.length === 4 ? value.readUInt16BE(0) : 0;
            if (number < 0x4000 || number > 0x7ffe) return error(message, rinfo, 400, 'Bad Request', auth.key);
            const peer = peers[0];
            const peerKey = `${peer.address}:${peer.port}`;
            const current = allocation.channels.get(number);
            const bound = allocation.channelByPeer.get(peerKey);
            if ((current && current.peerKey !== peerKey) || (bound && bound.number !== number)) {
                return error(message, rinfo, 400, 'Bad Request', auth.key);
            }
            const channel = { number, peer, peerKey, expires: now() + CHANNEL_LIFETIME * 1000 };
            allocation.channels.set(number, channel);
            allocation.channelByPeer.set(peerKey, channel);
            allocation.permissions.set(peer.address, now() + PERMISSION_LIFETIME * 1000);
            send(buildMessage(METHOD.CHANNEL_BIND, CLASS.SUCCESS, message.transactionId, [], auth.key), rinfo);
            return;
        }
        error(message, rinfo, 400, 'Bad Request', auth.key);
    }

    function onMessage(buffer, rinfo) {
        const id = `${rinfo.address}:${rinfo.port}`;
        // ChannelData: first two bits 01.
        if (buffer.length >= 4 && (buffer[0] & 0xc0) === 0x40) {
            const allocation = allocations.get(id);
            if (!allocation) return;
            const channel = allocation.channels.get(buffer.readUInt16BE(0));
            const length = buffer.readUInt16BE(2);
            if (!channel || channel.expires <= now() || length + 4 > buffer.length) return;
            if (!permitted(allocation, channel.peer.address)) return;
            allocation.relay.send(buffer.subarray(4, 4 + length), channel.peer.port, channel.peer.address);
            return;
        }
        const message = parseMessage(buffer);
        if (!message) return;
        if (message.cls === CLASS.REQUEST) return handleRequest(message, rinfo, id);
        if (message.cls === CLASS.INDICATION && message.method === METHOD.SEND) {
            const allocation = allocations.get(id);
            const peer = xorAddress(message.attrs.get(ATTR.XOR_PEER_ADDRESS));
            const data = message.attrs.get(ATTR.DATA);
            if (allocation && peer && data && permitted(allocation, peer.address)) {
                allocation.relay.send(data, peer.port, peer.address);
            }
        }
    }

    function sweep() {
        const current = now();
        for (const [id, allocation] of allocations) {
            if (allocation.expires <= current || !users.has(allocation.username)) closeAllocation(id);
        }
    }

    return {
        start: () => new Promise((resolve, reject) => {
            socket = dgram.createSocket('udp4');
            socket.on('message', onMessage);
            socket.once('error', reject);
            socket.bind(port, '0.0.0.0', () => {
                sweepTimer = setInterval(sweep, 15000);
                sweepTimer.unref?.();
                resolve({ port: socket.address().port });
            });
        }),
        stop: () => new Promise((resolve) => {
            if (sweepTimer) clearInterval(sweepTimer);
            for (const id of Array.from(allocations.keys())) closeAllocation(id);
            if (!socket) return resolve();
            const current = socket;
            socket = null;
            current.close(() => resolve());
        }),
        addUser: (username, password) => users.set(username, password),
        removeUser: (username) => {
            users.delete(username);
            sweep();
        },
        get port() { return socket ? socket.address().port : 0; },
        get allocationCount() { return allocations.size; }
    };
}

module.exports = {
    createTurnServer,
    // exported for tests (a minimal TURN client)
    buildMessage, parseMessage, longTermKey, encodeXorAddress, xorAddress, METHOD, CLASS, ATTR
};
