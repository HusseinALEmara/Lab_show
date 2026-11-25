const http = require('node:http');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const { CODE_PATTERN, normalizeCode, normalizeDurationMinutes } = require('../config/session-fields');

const DEFAULT_RELAY_PORT = 4477;
const MAX_ATTEMPTS_PER_MINUTE = 30;
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,32}$/u;
const ENDPOINT_PATTERN = /^[A-Za-z0-9.\-]+:\d{2,5}$/;

function normalizeUsername(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isRateLimited(store, key) {
    const now = Date.now();
    // Drop finished windows so the map cannot grow without bound.
    if (store.size > 10000) {
        for (const [storedKey, entry] of store) {
            if (now - entry.start >= 60000) store.delete(storedKey);
        }
    }
    const entry = store.get(key) || { start: now, count: 0 };
    if (now - entry.start >= 60000) {
        entry.start = now;
        entry.count = 0;
    }
    entry.count += 1;
    store.set(key, entry);
    return entry.count > MAX_ATTEMPTS_PER_MINUTE;
}

// خادم مطابقة خفيف: ينقل رسائل العثور على الجلسة فقط، ولا يستقبل أو يمرر أي بث.
function createGlobalRelay({ port = DEFAULT_RELAY_PORT } = {}) {
    const httpServer = http.createServer((request, response) => {
        if (request.url === '/health') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true, sessions: sessions.size }));
            return;
        }
        response.writeHead(404);
        response.end();
    });
    // Socket.IO clients of the app run in Node (no Origin header). Blocking browser
    // origins stops any website from using a locally running matching service.
    const io = new Server(httpServer, { cors: { origin: 'none' } });

    const sessions = new Map(); // code -> { code, username, endpoint, token, expiresAt, socketId }
    const usernameOwners = new Map(); // username -> code
    const attempts = new Map();

    function removeSession(code) {
        const session = sessions.get(code);
        if (!session) return;
        clearTimeout(session.timer);
        usernameOwners.delete(session.username);
        sessions.delete(code);
    }

    io.on('connection', (socket) => {
        socket.on('relay:register', (payload = {}, callback) => {
            const reply = (ok, extra = {}) => {
                if (typeof callback === 'function') callback({ ok, ...extra });
            };
            if (isRateLimited(attempts, `register:${socket.handshake.address}`)) {
                return reply(false, { message: 'تم تجاوز حد المحاولات؛ حاول لاحقاً.' });
            }
            const code = normalizeCode(String(payload.code || ''));
            const username = normalizeUsername(payload.username);
            const endpoint = String(payload.endpoint || '').trim();
            // Same bound as a local session (8 hours), and below setTimeout's 2^31 ms limit.
            const duration = normalizeDurationMinutes(payload.durationMinutes);

            if (!CODE_PATTERN.test(code)) return reply(false, { message: 'رمز الجلسة غير صالح.' });
            if (!USERNAME_PATTERN.test(username)) {
                return reply(false, { message: 'اسم المستخدم يجب أن يكون 3–32 حرفاً أو رقماً.' });
            }
            if (!ENDPOINT_PATTERN.test(endpoint)) {
                return reply(false, { message: 'عنوان البث غير صالح.' });
            }
            if (sessions.has(code)) return reply(false, { message: 'هذا الرمز مستخدم عالمياً الآن.' });
            if (usernameOwners.has(username)) {
                return reply(false, { message: 'اسم المستخدم مستخدم في بث عالمي نشط.' });
            }

            const ttl = duration ? duration * 60 * 1000 : 60 * 60 * 1000;
            const token = crypto.randomBytes(18).toString('hex');
            const session = {
                code,
                username,
                endpoint,
                token,
                expiresAt: Date.now() + ttl,
                socketId: socket.id,
                timer: null
            };
            session.timer = setTimeout(() => removeSession(code), ttl);
            sessions.set(code, session);
            usernameOwners.set(username, code);
            reply(true, { token, expiresAt: session.expiresAt });
        });

        socket.on('relay:find', (payload = {}, callback) => {
            const reply = (ok, extra = {}) => {
                if (typeof callback === 'function') callback({ ok, ...extra });
            };
            if (isRateLimited(attempts, `find:${socket.handshake.address}`)) {
                return reply(false, { message: 'تم تجاوز حد المحاولات؛ حاول لاحقاً.' });
            }
            const code = normalizeCode(String(payload.code || ''));
            const username = normalizeUsername(payload.username);
            const session = sessions.get(code);
            if (!session || session.username !== username || Date.now() >= session.expiresAt) {
                return reply(false, { message: 'لم يُعثر على جلسة بهذا الرمز واسم المستخدم.' });
            }
            reply(true, {
                endpoint: session.endpoint,
                token: session.token,
                expiresAt: session.expiresAt
            });
        });

        socket.on('relay:unregister', (payload = {}, callback) => {
            const session = sessions.get(normalizeCode(String(payload.code || '')));
            if (!session || session.token !== payload.token) {
                if (typeof callback === 'function') callback({ ok: false });
                return;
            }
            removeSession(session.code);
            if (typeof callback === 'function') callback({ ok: true });
        });

        socket.on('disconnect', () => {
            for (const session of Array.from(sessions.values())) {
                if (session.socketId === socket.id) removeSession(session.code);
            }
        });
    });

    return {
        start: () => new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(port, '0.0.0.0', () => resolve({ port: httpServer.address().port }));
        }),
        stop: () => new Promise((resolve) => {
            for (const code of Array.from(sessions.keys())) removeSession(code);
            io.close();
            if (httpServer.listening) httpServer.close(() => resolve());
            else resolve();
        }),
        get sessions() { return sessions; }
    };
}

module.exports = { createGlobalRelay, DEFAULT_RELAY_PORT, USERNAME_PATTERN };
