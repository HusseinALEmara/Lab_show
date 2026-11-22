const http = require('node:http');
const os = require('node:os');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const { createSessionStore } = require('./session-store');
const { createRoomStore, OWNER_ID } = require('./room-store');
const { USERNAME_PATTERN } = require('./global-relay');
const { PROTOCOL_VERSION, isCompatible } = require('./protocol');
const { normalizeCode, generateSessionCode } = require('./session-fields');
const { isAllowedControlKey } = require('./keyboard-controls');
const { buildLink } = require('./links');
const { createTurnServer } = require('./turn-server');

const UDP_DISCOVERY_PORT = 41234;
const CODE_ATTEMPTS = 8;
const CODE_PROBE_TIMEOUT_MS = 350;

// Every refusal carries a stable `error` key (translated by the interface) and an
// Arabic `message` kept for older clients.
const MESSAGES = {
    'host-only': 'هذا الإجراء متاح من نافذة التطبيق على هذا الجهاز فقط.',
    'bad-code': 'الرمز غير صحيح أو منتهي.',
    'incompatible': 'إصدارات التطبيق غير متوافقة؛ حدّث كلا الجهازين إلى النسخة نفسها.',
    'global-auth': 'رابط الجلسة غير صالح لهذا الرمز.',
    'bad-name': 'أدخل اسماً من 3 إلى 32 حرفاً أو رقماً.',
    'no-active-share': 'لا توجد مشاركة نشطة.',
    'start-sharing-first': 'ابدأ بث الشاشة أولاً.',
    'control-local-only': 'التحكم بالمفاتيح متاح داخل الشبكة المحلية فقط، وممنوع في الوضع العالمي.',
    'not-broadcasting': 'هذا البث غير متاح حالياً.',
    'peer-gone': 'لم يعد هذا الجهاز متصلاً.',
    'key-not-allowed': 'هذا المفتاح غير مسموح.',
    'control-not-allowed': 'لم يفعّل صاحب البث التحكم.',
    'no-room': 'لا يوجد بث عمومي بهذا الرمز.',
    'bad-token': 'رابط البث العمومي غير صالح.',
    'room-full': 'البث العمومي ممتلئ.',
    'not-in-room': 'لست داخل هذا البث العمومي.',
    'empty-comment': 'اكتب تعليقاً أولاً.',
    'comment-rate': 'تعليقات كثيرة؛ انتظر قليلاً.'
};

// An encoded media chunk: small metadata and a binary payload of at most 2 MB.
function isMediaChunk(meta, data) {
    return Boolean(meta && typeof meta === 'object' && (meta.type === 'key' || meta.type === 'delta' || meta.type === 'audio') &&
        Number.isFinite(meta.ts) && (Buffer.isBuffer(data) || data instanceof ArrayBuffer) && data.byteLength > 0 &&
        data.byteLength <= 2 * 1024 * 1024);
}

function safeCallback(callback, payload) {
    if (typeof callback === 'function') callback(payload);
}

function fail(callback, error) {
    safeCallback(callback, { ok: false, error, message: MESSAGES[error] || error });
}

function isLoopbackAddress(address) {
    return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function stripIpv6Prefix(address) {
    return typeof address === 'string' && address.startsWith('::ffff:') ? address.slice(7) : address;
}

// Constant-time comparison of secrets, so their value cannot be guessed byte by byte.
function secretsMatch(expected, provided) {
    if (typeof expected !== 'string' || typeof provided !== 'string' || !expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ipv4ToNumber(address) {
    if (typeof address !== 'string') return null;
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function isOnLocalSubnet(address) {
    if (isLoopbackAddress(address)) return true;
    const remote = ipv4ToNumber(stripIpv6Prefix(address));
    if (remote === null) return false;

    return Object.values(os.networkInterfaces()).some((interfaces) =>
        interfaces && interfaces.some((iface) => {
            if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) return false;
            const local = ipv4ToNumber(iface.address);
            const mask = ipv4ToNumber(iface.netmask);
            return local !== null && mask !== null && (remote & mask) === (local & mask);
        })
    );
}

function getLocalIPs() {
    const ips = [];
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        }
    }
    return ips;
}

function broadcastUdp(socket, payload) {
    const packet = Buffer.from(payload);
    socket.send(packet, UDP_DISCOVERY_PORT, '255.255.255.255');
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces || []) {
            if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
            const ip = iface.address.split('.').map(Number);
            const mask = iface.netmask.split('.').map(Number);
            const bcast = ip.map((part, i) => (part | (~mask[i] & 255))).join('.');
            socket.send(packet, UDP_DISCOVERY_PORT, bcast);
        }
    }
}

// onBound receives the probe's local UDP port, so this node's own responder can
// recognise (and ignore) its own probe instead of reporting every code as taken.
function probeCodeOnLan(code, onBound = () => {}) {
    return new Promise((resolve) => {
        const probe = dgram.createSocket('udp4');
        let done = false;
        const finish = (taken) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { probe.close(); } catch { /* already closed */ }
            resolve(taken);
        };
        const timer = setTimeout(() => finish(false), CODE_PROBE_TIMEOUT_MS);
        probe.on('message', (msg) => {
            if (msg.toString() === `LAB_SHOW_CODE_TAKEN:${code}`) finish(true);
        });
        probe.on('error', () => finish(false));
        probe.bind(() => {
            probe.setBroadcast(true);
            onBound(probe.address().port);
            broadcastUdp(probe, `LAB_SHOW_CHECK_CODE:${code}`);
        });
    });
}

// This device is the server of its own broadcasts and receptions. Two independent
// parts share it:
//  - a receiving session: other devices send their screens here (one each);
//  - a public broadcast ("room"): this device streams its screen to many viewers.
//
// hostSecret proves that a socket belongs to this computer's own Lab show windows.
// A loopback address alone is not enough: any web page open in a browser on the
// same computer can also reach 127.0.0.1.
//
// resolvePublicEndpoint(port, protocol) is asked for an internet-reachable address
// when a global code is made (the desktop app maps a router port through UPnP). It
// returns { ip, port, reachable, reason } or null.
//
// For global sessions the node also runs a TURN relay (src/turn-server.js) on a UDP
// port mapped the same way: remote devices whose router blocks a direct path send
// their media to it, and it hands the media to this device only.
function createLocalHostNode({
    hostSecret = crypto.randomBytes(32).toString('hex'),
    resolvePublicEndpoint = null,
    resolveWebUrl = null,
    extraIceServers = [],
    port = 0,
    turn = true
} = {}) {
    const app = express();
    // The page a session link opens in a browser: proof that the link really reaches
    // this device, and what to do with it. No script, no data beyond the code.
    app.get('/j', (request, response) => {
        const code = String(request.query.c || '').replace(/[^A-Z0-9]/gi, '').slice(0, 12);
        response.set({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store'
        });
        response.send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab show</title>
<style>body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;background:#050707;color:#eef3f2;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:520px;background:#0d1415;border:1px solid #1f3436;border-radius:14px;padding:24px;line-height:1.8}
code{direction:ltr;display:inline-block;color:#9db24d;font-size:1.3rem;letter-spacing:3px}p[dir=ltr]{text-align:left}</style></head>
<body><main><h1>Lab show</h1>
<p>هذا رابط جلسة على جهاز يعمل الآن. افتح تطبيق Lab show والصق هذا الرابط كاملاً مع الرمز <code>${code}</code>.</p>
<p dir="ltr">This link points to a device running a Lab show session right now. Open the Lab show app and paste this whole link with the code <code>${code}</code>.</p>
</main></body></html>`);
    });
    app.get('/health', (request, response) => response.json({ ok: true }));
    const httpServer = http.createServer(app);
    // 4 MB: a key frame of the WebSocket fallback video fits in one message.
    const io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: 4 * 1024 * 1024 });
    const store = createSessionStore();
    const rooms = createRoomStore();

    let hostSocketId = null;
    let roomOwnerSocketId = null;
    let reservingCode = null;
    let udpSocket = null;
    let expirationTimer = null;
    let warningTimer = null;
    let roomTimer = null;
    let listeningPort = 0;
    let ownProbePort = null;
    let turnServer = null;
    let sessionRelay = null; // { username, iceServers } for the global receiving session
    let roomRelay = null; // same for the global public broadcast

    function isOwnProbe(rinfo) {
        if (!ownProbePort || rinfo.port !== ownProbePort) return false;
        const address = stripIpv6Prefix(rinfo.address);
        return isLoopbackAddress(address) || getLocalIPs().includes(address);
    }

    function isTrustedLocal(socket, secret) {
        return isLoopbackAddress(socket.handshake.address) && secretsMatch(hostSecret, secret);
    }

    function isHost(socket) {
        return Boolean(hostSocketId && socket.id === hostSocketId && isLoopbackAddress(socket.handshake.address));
    }

    function isRoomOwner(socket) {
        return Boolean(roomOwnerSocketId && socket.id === roomOwnerSocketId &&
            isLoopbackAddress(socket.handshake.address));
    }

    // Opens this device's relay for one global session or room: random credentials, and
    // the relay's UDP port mapped on the router. Returns the ICE servers to hand to
    // remote devices once they have proved they hold the link, or null.
    async function openRelay() {
        if (!turnServer || typeof resolvePublicEndpoint !== 'function') return null;
        try {
            const result = await resolvePublicEndpoint(turnServer.port, 'UDP');
            if (!result || !result.reachable) return null;
            const username = `ls-${crypto.randomBytes(6).toString('hex')}`;
            const credential = crypto.randomBytes(18).toString('base64url');
            turnServer.addUser(username, credential);
            return {
                username,
                iceServers: [{ urls: [`turn:${result.ip}:${result.port}?transport=udp`], username, credential }]
            };
        } catch (error) {
            return null;
        }
    }

    function closeRelay(relay) {
        if (relay && turnServer) turnServer.removeUser(relay.username);
    }

    // How a global session can be reached: directly through a router port opened with
    // UPnP, and/or through this device's outbound tunnel (an https address that works
    // even where only port 443 is allowed). Both are tried at once.
    async function reachFor(networkMode) {
        const lanEndpoint = `${getLocalIPs()[0] || '127.0.0.1'}:${listeningPort}`;
        if (networkMode !== 'global') return { endpoint: lanEndpoint, reachability: 'lan', webUrl: '', direct: false };
        const direct = (async () => {
            if (typeof resolvePublicEndpoint !== 'function') return { reachable: false, reason: 'upnp-unavailable' };
            try {
                return (await resolvePublicEndpoint(listeningPort, 'TCP')) || { reachable: false, reason: 'upnp-unavailable' };
            } catch (error) {
                return { reachable: false, reason: 'upnp-unavailable' };
            }
        })();
        const web = (async () => {
            if (typeof resolveWebUrl !== 'function') return '';
            try {
                return (await resolveWebUrl(listeningPort)) || '';
            } catch (error) {
                return '';
            }
        })();
        const [upnp, webUrl] = await Promise.all([direct, web]);
        const directOk = Boolean(upnp.reachable && upnp.ip && upnp.port);
        return {
            endpoint: directOk ? `${upnp.ip}:${upnp.port}` : lanEndpoint,
            webUrl,
            direct: directOk,
            reachability: webUrl ? 'tunnel' : directOk ? 'internet' : (upnp.reason || 'upnp-unavailable')
        };
    }

    function iceFor(relay) {
        return [...(relay ? relay.iceServers : []), ...extraIceServers];
    }

    // ---------- receiving session ----------

    function emitState() {
        if (hostSocketId) io.to(hostSocketId).emit('session:state', store.serialize());
    }

    function sendToStudent(studentId, event, payload) {
        const student = store.get(studentId);
        if (student && student.socketId) io.to(student.socketId).emit(event, payload);
    }

    function emitStudentEvent(studentId, type) {
        if (hostSocketId) io.to(hostSocketId).emit('student:event', { studentId, type });
    }

    function endSession(reason, message) {
        const current = store.serialize();
        if (!current) return;
        if (expirationTimer) clearTimeout(expirationTimer);
        expirationTimer = null;
        if (warningTimer) clearTimeout(warningTimer);
        warningTimer = null;

        for (const student of current.students) {
            sendToStudent(student.id, 'session:ended', { reason, message });
        }
        store.clear();
        closeRelay(sessionRelay);
        sessionRelay = null;

        if (hostSocketId) {
            io.to(hostSocketId).emit('session:state', null);
            io.to(hostSocketId).emit('session:ended', { reason, message });
            if (reason === 'expired') io.to(hostSocketId).emit('session:expired');
        }
    }

    async function reserveUniqueCode() {
        for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
            const candidate = generateSessionCode();
            reservingCode = candidate;
            const taken = await probeCodeOnLan(candidate, (port) => { ownProbePort = port; });
            ownProbePort = null;
            if (!taken) {
                reservingCode = null;
                return candidate;
            }
        }
        reservingCode = null;
        return generateSessionCode();
    }

    // ---------- public broadcast (room) ----------

    function emitRoom(event, payload) {
        io.to('room').emit(event, payload);
        if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit(event, payload);
    }

    function emitParticipants() {
        emitRoom('room:participants', rooms.participants());
    }

    function endRoom(reason) {
        if (!rooms.room) return;
        if (roomTimer) clearTimeout(roomTimer);
        roomTimer = null;
        for (const viewer of rooms.viewers()) {
            const socket = io.sockets.sockets.get(viewer.socketId);
            if (socket) {
                socket.emit('room:ended', { reason });
                socket.leave('room');
            }
        }
        rooms.clear();
        closeRelay(roomRelay);
        roomRelay = null;
        if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:state', null);
    }

    io.on('connection', (socket) => {
        // ----- receiving session: this computer's main window -----

        socket.on('host:register', (payload, callback) => {
            if (typeof payload === 'function') {
                callback = payload;
                payload = {};
            }
            if (!isTrustedLocal(socket, payload && payload.secret)) return fail(callback, 'host-only');
            hostSocketId = socket.id;
            const current = store.serialize();
            emitState();
            for (const student of current?.students || []) {
                if (student.isSharing && !student.isPaused) {
                    sendToStudent(student.id, 'preview:start', { studentId: student.id });
                }
            }
            safeCallback(callback, { ok: true });
        });

        socket.on('host:create', async (payload, callback) => {
            if (!isHost(socket)) return fail(callback, 'host-only');
            const { title, durationMinutes, networkMode, username, protocolVersion } = payload || {};
            const global = networkMode === 'global';
            const name = String(username || '').trim();
            if (global && name && !USERNAME_PATTERN.test(name)) return fail(callback, 'bad-name');
            if (store.session) endSession('replaced', 'تم استبدال الرمز برمز جديد.');

            const code = await reserveUniqueCode();
            const { endpoint, reachability, webUrl, direct } = await reachFor(global ? 'global' : 'local');
            const relayToken = global ? generateSessionCode(12) : '';
            if (global && direct) sessionRelay = await openRelay();
            const globalUrl = buildLink({
                kind: 'send', mode: global ? 'global' : 'local', code, endpoint, token: relayToken, username: name, webUrl
            });

            const session = store.create({
                code, title, durationMinutes, networkMode,
                username: global ? name : '', relayToken, globalUrl, reachability,
                protocolVersion: protocolVersion || PROTOCOL_VERSION
            });

            if (session.expiresAt) {
                expirationTimer = setTimeout(() => {
                    endSession('expired', 'انتهت مدة صلاحية الرمز.');
                }, session.expiresAt - Date.now());
                expirationTimer.unref?.();
                const warningDelay = session.expiresAt - Date.now() - 5 * 60 * 1000;
                if (warningDelay > 0) {
                    warningTimer = setTimeout(() => {
                        if (hostSocketId) {
                            io.to(hostSocketId).emit('session:expiring', { expiresAt: session.expiresAt });
                        }
                        for (const student of store.serialize()?.students || []) {
                            sendToStudent(student.id, 'session:expiring', { expiresAt: session.expiresAt });
                        }
                    }, warningDelay);
                    warningTimer.unref?.();
                }
            }

            emitState();
            safeCallback(callback, { ok: true, session: store.serialize() });
        });

        socket.on('host:delete', () => {
            if (!isHost(socket)) return;
            endSession('deleted', 'تم إيقاف البث وحذف الرمز.');
        });

        socket.on('host:select', ({ studentId } = {}, callback) => {
            if (!isHost(socket)) return fail(callback, 'host-only');
            const result = store.select(studentId);
            if (!result.ok) return fail(callback, 'not-broadcasting');
            sendToStudent(studentId, 'student:selected', { studentId });
            emitState();
            safeCallback(callback, { ok: true, studentId });
        });

        socket.on('host:stop-student', ({ studentId } = {}, callback) => {
            if (!isHost(socket)) return fail(callback, 'host-only');
            if (!store.get(studentId)) return fail(callback, 'peer-gone');
            sendToStudent(studentId, 'host:stop', { studentId });
            safeCallback(callback, { ok: true });
        });

        socket.on('host:pause-student', ({ studentId, paused } = {}, callback) => {
            if (!isHost(socket)) return fail(callback, 'host-only');
            if (!store.get(studentId)) return fail(callback, 'peer-gone');
            sendToStudent(studentId, 'host:pause', { studentId, paused: Boolean(paused) });
            safeCallback(callback, { ok: true });
        });

        socket.on('host:key', ({ studentId, key } = {}, callback) => {
            if (!isHost(socket)) return fail(callback, 'host-only');
            if (store.isGlobal()) return fail(callback, 'control-local-only');
            if (!isAllowedControlKey(key)) return fail(callback, 'key-not-allowed');
            if (!store.canSendKey(studentId)) return fail(callback, 'control-not-allowed');
            sendToStudent(studentId, 'control:key', { studentId, key });
            safeCallback(callback, { ok: true });
        });

        socket.on('host:answer', ({ studentId, answer } = {}) => {
            if (!isHost(socket) || !store.get(studentId)) return;
            sendToStudent(studentId, 'webrtc:answer', { studentId, answer });
        });

        socket.on('host:ice', ({ studentId, candidate } = {}) => {
            if (!isHost(socket) || !store.get(studentId)) return;
            sendToStudent(studentId, 'webrtc:ice', { studentId, candidate });
        });

        // ----- receiving session: a device sending its screen here -----

        socket.on('student:join', ({ code, title, username, token, protocolVersion } = {}, callback) => {
            const current = store.serialize();
            if (current && !isCompatible(protocolVersion, current.protocolVersion)) {
                return fail(callback, 'incompatible');
            }
            if (current && current.networkMode === 'global') {
                const nameOk = !current.username || String(username || '').trim() === current.username;
                if (!nameOk || !secretsMatch(current.relayToken, token)) return fail(callback, 'global-auth');
            }
            const result = store.join({ code: normalizeCode(code), title, socketId: socket.id });
            if (!result.ok) return fail(callback, 'bad-code');
            emitState();
            safeCallback(callback, {
                ok: true,
                studentId: result.student.id,
                networkMode: store.serialize().networkMode,
                expiresAt: store.serialize().expiresAt,
                // Only after the link token was checked (global sessions).
                iceServers: store.isGlobal() ? iceFor(sessionRelay) : []
            });
        });

        socket.on('student:start', () => {
            const student = store.findBySocket(socket.id);
            if (!student) return;
            store.markSharing(student.id, true);
            emitState();
            socket.emit('preview:start', { studentId: student.id });
        });

        socket.on('student:update-title', ({ title } = {}, callback) => {
            const student = store.findBySocket(socket.id);
            if (!student) return fail(callback, 'no-active-share');
            store.updateTitle(student.id, title);
            const updatedTitle = store.get(student.id).title;
            if (hostSocketId) {
                io.to(hostSocketId).emit('student:event', {
                    studentId: student.id,
                    type: 'title-updated',
                    title: updatedTitle
                });
            }
            emitState();
            safeCallback(callback, { ok: true, title: updatedTitle });
        });

        socket.on('student:pause', () => {
            const student = store.findBySocket(socket.id);
            if (!student || !store.markPaused(student.id, true)) return;
            emitState();
            emitStudentEvent(student.id, 'paused');
        });

        socket.on('student:resume', () => {
            const student = store.findBySocket(socket.id);
            if (!student || !store.markPaused(student.id, false)) return;
            emitState();
            emitStudentEvent(student.id, 'resumed');
        });

        socket.on('student:stop', () => {
            const student = store.findBySocket(socket.id);
            if (!student) return;
            store.markSharing(student.id, false);
            socket.emit('preview:stop', { studentId: student.id });
            emitState();
            emitStudentEvent(student.id, 'stopped');
        });

        socket.on('student:permission', ({ enabled } = {}, callback) => {
            const student = store.findBySocket(socket.id);
            if (!student || typeof enabled !== 'boolean') return fail(callback, 'no-active-share');
            if (enabled && store.isGlobal()) return fail(callback, 'control-local-only');
            if (enabled && (!student.isSharing || student.isPaused)) return fail(callback, 'start-sharing-first');
            if (enabled && !isOnLocalSubnet(socket.handshake.address)) return fail(callback, 'control-local-only');
            store.setControl(student.id, enabled);
            if (hostSocketId) {
                io.to(hostSocketId).emit('control:permission', { studentId: student.id, enabled });
            }
            socket.emit('control:permission', { studentId: student.id, enabled });
            emitState();
            safeCallback(callback, { ok: true, enabled });
        });

        socket.on('student:offer', ({ studentId, offer } = {}) => {
            const student = store.findBySocket(socket.id);
            if (
                !student ||
                studentId !== student.id ||
                !student.isSharing ||
                student.isPaused ||
                !hostSocketId
            ) return;
            io.to(hostSocketId).emit('webrtc:offer', { studentId, offer });
        });

        // ----- media over WebSocket: used when no direct WebRTC path exists (networks that
        // block UDP, such as many organizations). The sender encodes its screen; this
        // node passes the encoded chunks to its own receiving window.

        socket.on('student:transport', ({ mode } = {}) => {
            const student = store.findBySocket(socket.id);
            if (!student || !hostSocketId) return;
            student.transport = mode === 'ws' ? 'ws' : 'rtc';
            io.to(hostSocketId).emit('student:transport', { studentId: student.id, mode: student.transport });
        });

        socket.on('student:media', (meta, data) => {
            const student = store.findBySocket(socket.id);
            if (!student || !student.isSharing || student.isPaused || !hostSocketId || !isMediaChunk(meta, data)) return;
            io.to(hostSocketId).emit('media:video', { studentId: student.id, type: meta.type, ts: meta.ts, codec: meta.codec }, data);
        });

        socket.on('host:keyframe', ({ studentId } = {}) => {
            if (!isHost(socket)) return;
            sendToStudent(studentId, 'media:keyframe', { studentId });
        });

        socket.on('student:ice', ({ studentId, candidate } = {}) => {
            const student = store.findBySocket(socket.id);
            if (!student || student.id !== studentId || !hostSocketId) return;
            io.to(hostSocketId).emit('webrtc:ice', { studentId, candidate });
        });

        // ----- public broadcast: this computer's room window -----

        socket.on('room:owner', (payload, callback) => {
            if (!isTrustedLocal(socket, payload && payload.secret)) return fail(callback, 'host-only');
            roomOwnerSocketId = socket.id;
            socket.emit('room:state', rooms.serialize());
            safeCallback(callback, { ok: true });
        });

        socket.on('room:create', async (payload, callback) => {
            if (!isRoomOwner(socket)) return fail(callback, 'host-only');
            const { title, networkMode, durationMinutes, ownerName } = payload || {};
            const global = networkMode === 'global';
            endRoom('replaced');
            const code = await reserveUniqueCode();
            const { endpoint, reachability, webUrl, direct } = await reachFor(global ? 'global' : 'local');
            const token = generateSessionCode(12);
            if (global && direct) roomRelay = await openRelay();
            const link = buildLink({ kind: 'room', mode: global ? 'global' : 'local', code, endpoint, token, webUrl });
            const room = rooms.create({
                code, title, networkMode: global ? 'global' : 'local',
                token, link, reachability, durationMinutes, ownerName
            });
            if (room.expiresAt) {
                roomTimer = setTimeout(() => endRoom('expired'), room.expiresAt - Date.now());
                roomTimer.unref?.();
            }
            socket.emit('room:state', room);
            safeCallback(callback, { ok: true, room });
        });

        socket.on('room:end', () => {
            if (isRoomOwner(socket)) endRoom('ended');
        });

        socket.on('room:kick', ({ viewerId } = {}) => {
            if (!isRoomOwner(socket)) return;
            const viewer = rooms.remove(viewerId);
            if (!viewer) return;
            const target = io.sockets.sockets.get(viewer.socketId);
            if (target) {
                target.emit('room:ended', { reason: 'removed' });
                target.leave('room');
            }
            if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:viewer-left', { viewerId });
            emitParticipants();
        });

        // ----- public broadcast: a viewer -----

        socket.on('room:join', ({ code, token, name, protocolVersion } = {}, callback) => {
            if (!isCompatible(protocolVersion, PROTOCOL_VERSION)) return fail(callback, 'incompatible');
            const result = rooms.join({ code, token, name, socketId: socket.id });
            if (!result.ok) return fail(callback, result.error);
            socket.join('room');
            const room = rooms.serialize();
            safeCallback(callback, {
                ok: true,
                viewerId: result.viewer.id,
                room: {
                    code: room.code,
                    title: room.title,
                    networkMode: room.networkMode,
                    participants: room.participants,
                    comments: room.comments
                },
                iceServers: room.networkMode === 'global' ? iceFor(roomRelay) : []
            });
            if (roomOwnerSocketId) {
                io.to(roomOwnerSocketId).emit('room:viewer-joined', {
                    viewerId: result.viewer.id, name: result.viewer.name
                });
            }
            emitParticipants();
        });

        socket.on('room:leave', () => {
            const viewer = rooms.leaveBySocket(socket.id);
            if (!viewer) return;
            socket.leave('room');
            if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:viewer-left', { viewerId: viewer.id });
            emitParticipants();
        });

        socket.on('room:comment', ({ text } = {}, callback) => {
            const senderId = isRoomOwner(socket) ? OWNER_ID : (rooms.viewerBySocket(socket.id) || {}).id;
            if (!senderId) return fail(callback, 'not-in-room');
            const result = rooms.addComment(senderId, text);
            if (!result.ok) return fail(callback, result.error);
            emitRoom('room:comment', result.comment);
            safeCallback(callback, { ok: true, comment: result.comment });
        });

        // Viewers that have no direct WebRTC path receive the owner's encoded screen and a
        // per-viewer voice mix over this WebSocket, and send their microphone the same way.
        socket.on('room:transport', ({ mode } = {}) => {
            const viewer = rooms.viewerBySocket(socket.id);
            if (!viewer) return;
            viewer.transport = mode === 'ws' ? 'ws' : 'rtc';
            if (viewer.transport === 'ws') socket.join('room-ws');
            else socket.leave('room-ws');
            if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:viewer-transport', { viewerId: viewer.id, mode: viewer.transport });
        });

        socket.on('room:video', (meta, data) => {
            if (!isRoomOwner(socket) || !isMediaChunk(meta, data)) return;
            for (const viewer of rooms.viewers()) {
                if (viewer.transport !== 'ws') continue;
                const target = io.sockets.sockets.get(viewer.socketId);
                if (!target) continue;
                // Per-viewer congestion control: a viewer whose connection is backed up
                // skips frames until the next key frame instead of falling further behind.
                const backlog = target.conn && target.conn.writeBuffer ? target.conn.writeBuffer.length : 0;
                if (meta.type !== 'key' && (viewer.needsKey || backlog > 30)) {
                    viewer.needsKey = true;
                    continue;
                }
                viewer.needsKey = false;
                target.emit('room:video', { type: meta.type, ts: meta.ts, codec: meta.codec }, data);
            }
        });

        socket.on('room:keyframe', () => {
            const viewer = rooms.viewerBySocket(socket.id);
            if (viewer && roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:keyframe-request', { viewerId: viewer.id });
        });

        socket.on('room:audio', (meta, data) => {
            const viewer = rooms.viewerBySocket(socket.id);
            if (!viewer || !roomOwnerSocketId || !isMediaChunk(meta, data)) return;
            io.to(roomOwnerSocketId).emit('room:audio', { from: viewer.id, ts: meta.ts, sr: meta.sr, ch: meta.ch }, data);
        });

        socket.on('room:audio-to', (meta, data) => {
            if (!isRoomOwner(socket) || !meta || !isMediaChunk(meta, data)) return;
            const viewer = rooms.get(meta.to);
            if (viewer) io.to(viewer.socketId).emit('room:audio', { from: OWNER_ID, ts: meta.ts, sr: meta.sr, ch: meta.ch }, data);
        });

        socket.on('room:mic', ({ on } = {}) => {
            const senderId = isRoomOwner(socket) ? OWNER_ID : (rooms.viewerBySocket(socket.id) || {}).id;
            if (!senderId || !rooms.setMic(senderId, on)) return;
            emitParticipants();
        });

        // WebRTC signaling: the owner talks to one viewer at a time; a viewer only to the owner.
        socket.on('room:signal', ({ to, data } = {}) => {
            if (isRoomOwner(socket)) {
                const viewer = rooms.get(to);
                if (viewer) io.to(viewer.socketId).emit('room:signal', { from: OWNER_ID, data });
                return;
            }
            const viewer = rooms.viewerBySocket(socket.id);
            if (viewer && roomOwnerSocketId) {
                io.to(roomOwnerSocketId).emit('room:signal', { from: viewer.id, data });
            }
        });

        socket.on('disconnect', () => {
            if (socket.id === hostSocketId) hostSocketId = null;
            if (socket.id === roomOwnerSocketId) {
                endRoom('owner-left');
                roomOwnerSocketId = null;
            }
            const viewer = rooms.leaveBySocket(socket.id);
            if (viewer) {
                if (roomOwnerSocketId) io.to(roomOwnerSocketId).emit('room:viewer-left', { viewerId: viewer.id });
                emitParticipants();
            }
            const student = store.removeBySocket(socket.id);
            if (!student) return;
            emitState();
            emitStudentEvent(student.id, 'left');
        });
    });

    function startUdpResponder() {
        udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        udpSocket.on('message', (msg, rinfo) => {
            const text = msg.toString();
            if (text.startsWith('LAB_SHOW_CHECK_CODE:')) {
                const candidate = text.slice('LAB_SHOW_CHECK_CODE:'.length).trim();
                if (isOwnProbe(rinfo)) return;
                const current = store.serialize();
                const room = rooms.room;
                if ((current && current.code === candidate) || (room && room.code === candidate) ||
                    reservingCode === candidate) {
                    udpSocket.send(Buffer.from(`LAB_SHOW_CODE_TAKEN:${candidate}`), rinfo.port, rinfo.address);
                }
                return;
            }
            if (text.startsWith('LAB_SHOW_FIND:')) {
                const code = text.slice('LAB_SHOW_FIND:'.length).trim();
                const current = store.serialize();
                if (current && current.code === code && (!current.expiresAt || Date.now() < current.expiresAt)) {
                    udpSocket.send(
                        Buffer.from(`LAB_SHOW_MATCH:${code}:${listeningPort}`),
                        rinfo.port,
                        rinfo.address
                    );
                }
            }
        });
        udpSocket.on('error', () => { /* discovery is best-effort */ });
        udpSocket.bind(UDP_DISCOVERY_PORT, '0.0.0.0');
    }

    return {
        start: () => new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(port, '0.0.0.0', async () => {
                listeningPort = httpServer.address().port;
                startUdpResponder();
                if (turn) {
                    const relayAddress = getLocalIPs()[0] || '127.0.0.1';
                    turnServer = createTurnServer({
                        relayAddress,
                        // Relay to this device only: never an open relay.
                        isAllowedPeer: (ip) => ip === '127.0.0.1' || getLocalIPs().includes(ip)
                    });
                    try {
                        await turnServer.start();
                    } catch (error) {
                        turnServer = null;
                    }
                }
                resolve({ port: listeningPort, ips: getLocalIPs(), hostSecret, turnPort: turnServer ? turnServer.port : 0 });
            });
        }),
        stop: () => new Promise((resolve) => {
            if (expirationTimer) clearTimeout(expirationTimer);
            expirationTimer = null;
            if (warningTimer) clearTimeout(warningTimer);
            warningTimer = null;
            if (roomTimer) clearTimeout(roomTimer);
            roomTimer = null;
            if (udpSocket) {
                try { udpSocket.close(); } catch { /* already closed */ }
                udpSocket = null;
            }
            if (turnServer) {
                turnServer.stop();
                turnServer = null;
            }
            io.close();
            if (httpServer.listening) httpServer.close(() => resolve());
            else resolve();
        }),
        getInfo: () => ({ port: listeningPort, ips: getLocalIPs() })
    };
}

module.exports = {
    createLocalHostNode,
    UDP_DISCOVERY_PORT,
    MESSAGES,
    isOnLocalSubnet,
    isLoopbackAddress,
    secretsMatch
};
