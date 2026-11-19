const http = require('node:http');
const os = require('node:os');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { io: connectToRelay } = require('socket.io-client');

const { createSessionStore } = require('./session-store');
const { USERNAME_PATTERN } = require('./global-relay');
const { PROTOCOL_VERSION, isCompatible } = require('./protocol');
const { normalizeCode, generateSessionCode } = require('./session-fields');
const { isAllowedControlKey } = require('./keyboard-controls');

const UDP_DISCOVERY_PORT = 41234;
const CODE_ATTEMPTS = 8;
const CODE_PROBE_TIMEOUT_MS = 350;

function safeCallback(callback, payload) {
    if (typeof callback === 'function') callback(payload);
}

function isLoopbackAddress(address) {
    return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function ipv4ToNumber(address) {
    if (typeof address !== 'string') return null;
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function isOnLocalSubnet(address) {
    if (isLoopbackAddress(address)) return true;
    const normalized = typeof address === 'string' && address.startsWith('::ffff:')
        ? address.slice(7)
        : address;
    const remote = ipv4ToNumber(normalized);
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

function probeCodeOnLan(code) {
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
            broadcastUdp(probe, `LAB_SHOW_CHECK_CODE:${code}`);
        });
    });
}

function createLocalHostNode() {
    const app = express();
    const httpServer = http.createServer(app);
    const io = new Server(httpServer, { cors: { origin: '*' } });
    const store = createSessionStore();

    let hostSocketId = null;
    let reservingCode = null;
    let udpSocket = null;
    let expirationTimer = null;
    let warningTimer = null;
    let listeningPort = 0;
    let relayClient = null;

    function isHost(socket) {
        return Boolean(hostSocketId && socket.id === hostSocketId && isLoopbackAddress(socket.handshake.address));
    }

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
        if (relayClient) {
            const client = relayClient;
            relayClient = null;
            client.timeout(1000).emit(
                'relay:unregister', { code: current.code, token: current.relayToken },
                () => client.disconnect()
            );
        }
        store.clear();

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
            const taken = await probeCodeOnLan(candidate);
            if (!taken) {
                reservingCode = null;
                return candidate;
            }
        }
        reservingCode = null;
        return generateSessionCode();
    }

    async function registerWithRelay({ code, username, relayUrl, endpoint, durationMinutes }) {
        const url = relayUrl || process.env.LABSHOW_RELAY_URL || 'http://127.0.0.1:4477';
        const client = connectToRelay(url, {
            transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000
        });
        try {
            await new Promise((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
            });
            const response = await new Promise((resolve) => {
                client.timeout(5000).emit('relay:register', {
                    code, username, endpoint, durationMinutes
                }, (error, reply) => resolve(
                    error ? { ok: false, message: 'خادم المطابقة لم يستجب.' } : reply
                ));
            });
            if (!response || !response.ok) {
                client.disconnect();
                return { ok: false, message: (response && response.message) || 'تعذر التسجيل في خادم المطابقة.' };
            }
            return { ok: true, client, token: response.token };
        } catch (error) {
            client.disconnect();
            return { ok: false, message: 'تعذر الاتصال بخادم المطابقة العالمية.' };
        }
    }

    io.on('connection', (socket) => {
        socket.on('host:register', (payload, callback) => {
            if (typeof payload === 'function') callback = payload;
            if (!isLoopbackAddress(socket.handshake.address)) {
                return safeCallback(callback, { ok: false, message: 'تسجيل واجهة الأستاذ مسموح من هذا الجهاز فقط.' });
            }
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

        socket.on('host:create', async (payload = {}, callback) => {
            if (!isLoopbackAddress(socket.handshake.address)) {
                return safeCallback(callback, { ok: false, message: 'يجب إنشاء الجلسة من هذا الجهاز.' });
            }
            const { title, durationMinutes, networkMode, username, relayUrl, publicEndpoint, protocolVersion } = payload;
            const global = networkMode === 'global';
            if (global && !USERNAME_PATTERN.test(String(username || '').trim())) {
                return safeCallback(callback, {
                    ok: false,
                    message: 'أدخل اسماً فريداً من 3 إلى 32 حرفاً أو رقماً للوضع العالمي.'
                });
            }
            hostSocketId = socket.id;
            if (store.session) endSession('replaced', 'تم استبدال الرمز برمز جديد.');

            const code = await reserveUniqueCode();
            let usernameValue = '';
            let relayToken = '';
            let globalUrl = '';
            if (global) {
                usernameValue = username.trim();
                relayToken = generateSessionCode(12);
                const endpoint = `${getLocalIPs()[0] || '127.0.0.1'}:${listeningPort}`;
                const params = new URLSearchParams({
                    c: code,
                    u: usernameValue,
                    e: endpoint,
                    t: relayToken
                });
                globalUrl = `https://labshow.link/j?${params.toString()}`;
            }

            const session = store.create({
                code, title, durationMinutes, networkMode,
                username: usernameValue, relayToken, globalUrl,
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
            safeCallback(callback, { ok: true, session });
        });

        socket.on('host:delete', () => {
            if (!isHost(socket)) return;
            endSession('deleted', 'تم إيقاف البث وحذف الرمز.');
        });

        socket.on('host:select', ({ studentId } = {}, callback) => {
            if (!isHost(socket)) return safeCallback(callback, { ok: false, message: 'مصدر التحكم غير مصرح.' });
            const result = store.select(studentId);
            if (!result.ok) return safeCallback(callback, { ok: false, message: 'الطالب غير متصل بالبث حالياً.' });
            sendToStudent(studentId, 'student:selected', { studentId });
            emitState();
            safeCallback(callback, { ok: true, studentId });
        });

        socket.on('host:stop-student', ({ studentId } = {}, callback) => {
            if (!isHost(socket)) return safeCallback(callback, { ok: false, message: 'مصدر التحكم غير مصرح.' });
            const student = store.get(studentId);
            if (!student) return safeCallback(callback, { ok: false, message: 'لم يعد هذا الطالب متصلاً.' });
            sendToStudent(studentId, 'host:stop', { studentId });
            safeCallback(callback, { ok: true });
        });

        socket.on('host:pause-student', ({ studentId, paused } = {}, callback) => {
            if (!isHost(socket)) return safeCallback(callback, { ok: false, message: 'مصدر التحكم غير مصرح.' });
            const student = store.get(studentId);
            if (!student) return safeCallback(callback, { ok: false, message: 'لم يعد هذا الطالب متصلاً.' });
            sendToStudent(studentId, 'host:pause', { studentId, paused: Boolean(paused) });
            safeCallback(callback, { ok: true });
        });

        socket.on('host:key', ({ studentId, key } = {}, callback) => {
            if (!isHost(socket)) return safeCallback(callback, { ok: false, message: 'مصدر التحكم غير مصرح.' });
            if (!isAllowedControlKey(key)) return safeCallback(callback, { ok: false, message: 'هذا المفتاح غير مسموح.' });
            if (!store.canSendKey(studentId)) {
                return safeCallback(callback, { ok: false, message: 'لم يفعّل الطالب التحكم لهذا البث.' });
            }
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

        socket.on('student:join', ({ code, title, username, token, protocolVersion } = {}, callback) => {
            const current = store.serialize();
            if (current && !isCompatible(protocolVersion, current.protocolVersion)) {
                return safeCallback(callback, {
                    ok: false,
                    message: 'إصدارات التطبيق غير متوافقة؛ حدّث كلا الجهازين إلى النسخة نفسها.'
                });
            }
            if (current && current.networkMode === 'global') {
                if (String(username || '').trim() !== current.username || token !== current.relayToken) {
                    return safeCallback(callback, {
                        ok: false,
                        message: 'اسم المستخدم أو رمز المطابقة غير صالح لهذه الجلسة.'
                    });
                }
            }
            const result = store.join({ code: normalizeCode(code), title, socketId: socket.id });
            if (!result.ok) {
                const message = result.reason === 'no-session'
                    ? 'الرمز غير صحيح أو منتهي.'
                    : 'الرمز غير صحيح أو منتهي.';
                return safeCallback(callback, { ok: false, message });
            }
            emitState();
            safeCallback(callback, {
                ok: true,
                studentId: result.student.id,
                expiresAt: store.serialize().expiresAt
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
            if (!student) return safeCallback(callback, { ok: false, message: 'لا توجد جلسة مشاركة نشطة.' });
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
            if (!student || typeof enabled !== 'boolean') {
                return safeCallback(callback, { ok: false, message: 'لا توجد جلسة مشاركة نشطة.' });
            }
            if (enabled && (!student.isSharing || student.isPaused)) {
                return safeCallback(callback, { ok: false, message: 'ابدأ بث الشاشة أولاً.' });
            }
            if (enabled && !store.isGlobal() && !isOnLocalSubnet(socket.handshake.address)) {
                return safeCallback(callback, { ok: false, message: 'التحكم متاح داخل الشبكة المحلية فقط.' });
            }
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

        socket.on('student:ice', ({ studentId, candidate } = {}) => {
            const student = store.findBySocket(socket.id);
            if (!student || student.id !== studentId || !hostSocketId) return;
            io.to(hostSocketId).emit('webrtc:ice', { studentId, candidate });
        });

        socket.on('disconnect', () => {
            if (socket.id === hostSocketId) hostSocketId = null;
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
                const current = store.serialize();
                if ((current && current.code === candidate) || reservingCode === candidate) {
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
            httpServer.listen(0, '0.0.0.0', () => {
                listeningPort = httpServer.address().port;
                startUdpResponder();
                resolve({ port: listeningPort, ips: getLocalIPs() });
            });
        }),
        stop: () => new Promise((resolve) => {
            if (expirationTimer) clearTimeout(expirationTimer);
            expirationTimer = null;
            if (warningTimer) clearTimeout(warningTimer);
            warningTimer = null;
            if (relayClient) {
                relayClient.disconnect();
                relayClient = null;
            }
            if (udpSocket) {
                try { udpSocket.close(); } catch { /* already closed */ }
                udpSocket = null;
            }
            io.close();
            if (httpServer.listening) httpServer.close(() => resolve());
            else resolve();
        }),
        getInfo: () => ({ port: listeningPort, ips: getLocalIPs() })
    };
}

module.exports = { createLocalHostNode, UDP_DISCOVERY_PORT };
