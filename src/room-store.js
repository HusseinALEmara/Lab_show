const {
    normalizeCode,
    normalizeTitle,
    normalizeDurationMinutes
} = require('./session-fields');

// A public broadcast ("room"): one owner streams its screen to many viewers, who can
// comment and talk. Pure state, no sockets or timers, so every rule can be tested.
const MAX_VIEWERS = 50;
const MAX_COMMENT_LENGTH = 500;
const MAX_STORED_COMMENTS = 200;
const COMMENT_RATE_LIMIT = 5;
const COMMENT_RATE_WINDOW_MS = 10000;
const OWNER_ID = 'owner';

function normalizeComment(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_COMMENT_LENGTH);
}

function createRoomStore({ now = Date.now } = {}) {
    let room = null;

    function viewerBySocket(socketId) {
        if (!room || !socketId) return null;
        for (const viewer of room.viewers.values()) {
            if (viewer.socketId === socketId) return viewer;
        }
        return null;
    }

    function participants() {
        if (!room) return [];
        return [
            { id: OWNER_ID, name: room.ownerName, micOn: room.ownerMicOn, isOwner: true },
            ...Array.from(room.viewers.values(), (viewer) => ({
                id: viewer.id, name: viewer.name, micOn: viewer.micOn, isOwner: false
            }))
        ];
    }

    function serialize() {
        if (!room) return null;
        return {
            code: room.code,
            title: room.title,
            networkMode: room.networkMode,
            token: room.token,
            link: room.link,
            reachability: room.reachability,
            expiresAt: room.expiresAt,
            participants: participants(),
            comments: room.comments.slice()
        };
    }

    function isExpired() {
        return Boolean(room && room.expiresAt && now() >= room.expiresAt);
    }

    function create({ code, title, networkMode, token, link = '', reachability = 'lan', durationMinutes, ownerName }) {
        const duration = normalizeDurationMinutes(durationMinutes);
        room = {
            code: normalizeCode(code),
            title: normalizeTitle(title, 'Lab show'),
            networkMode: networkMode === 'global' ? 'global' : 'local',
            token: typeof token === 'string' ? token : '',
            link: typeof link === 'string' ? link : '',
            reachability,
            expiresAt: duration ? now() + duration * 60 * 1000 : null,
            ownerName: normalizeTitle(ownerName, 'Host'),
            ownerMicOn: false,
            viewers: new Map(),
            nextNumber: 1,
            nextCommentId: 1,
            comments: [],
            rates: new Map()
        };
        return serialize();
    }

    function clear() {
        room = null;
    }

    function join({ code, token, name, socketId }) {
        if (!room || isExpired()) return { ok: false, error: 'no-room' };
        if (normalizeCode(code) !== room.code) return { ok: false, error: 'bad-code' };
        if (typeof token !== 'string' || token !== room.token) return { ok: false, error: 'bad-token' };
        const existing = viewerBySocket(socketId);
        if (existing) return { ok: true, viewer: existing };
        if (room.viewers.size >= MAX_VIEWERS) return { ok: false, error: 'room-full' };
        const id = `v${String(room.nextNumber++).padStart(3, '0')}`;
        const viewer = { id, socketId, name: normalizeTitle(name, `Viewer ${id.slice(1)}`), micOn: false };
        room.viewers.set(id, viewer);
        return { ok: true, viewer };
    }

    function leaveBySocket(socketId) {
        const viewer = viewerBySocket(socketId);
        if (!viewer) return null;
        room.viewers.delete(viewer.id);
        room.rates.delete(viewer.id);
        return viewer;
    }

    function remove(viewerId) {
        if (!room) return null;
        const viewer = room.viewers.get(viewerId) || null;
        if (viewer) room.viewers.delete(viewerId);
        return viewer;
    }

    function setMic(senderId, on) {
        if (!room) return false;
        if (senderId === OWNER_ID) {
            room.ownerMicOn = Boolean(on);
            return true;
        }
        const viewer = room.viewers.get(senderId);
        if (!viewer) return false;
        viewer.micOn = Boolean(on);
        return true;
    }

    function addComment(senderId, text) {
        if (!room) return { ok: false, error: 'no-room' };
        const name = senderId === OWNER_ID
            ? room.ownerName
            : (room.viewers.get(senderId) || {}).name;
        if (!name) return { ok: false, error: 'not-in-room' };
        const clean = normalizeComment(text);
        if (!clean) return { ok: false, error: 'empty-comment' };

        const current = now();
        const rate = room.rates.get(senderId) || { start: current, count: 0 };
        if (current - rate.start >= COMMENT_RATE_WINDOW_MS) {
            rate.start = current;
            rate.count = 0;
        }
        if (rate.count >= COMMENT_RATE_LIMIT) return { ok: false, error: 'comment-rate' };
        rate.count += 1;
        room.rates.set(senderId, rate);

        const comment = {
            id: room.nextCommentId++,
            from: senderId,
            name,
            isOwner: senderId === OWNER_ID,
            text: clean,
            at: current
        };
        room.comments.push(comment);
        if (room.comments.length > MAX_STORED_COMMENTS) room.comments.shift();
        return { ok: true, comment };
    }

    return {
        create,
        clear,
        isExpired,
        join,
        leaveBySocket,
        remove,
        setMic,
        addComment,
        participants,
        serialize,
        viewerBySocket,
        get: (viewerId) => (room ? room.viewers.get(viewerId) || null : null),
        viewers: () => (room ? Array.from(room.viewers.values()) : []),
        get room() { return room; }
    };
}

module.exports = {
    createRoomStore,
    normalizeComment,
    OWNER_ID,
    MAX_VIEWERS,
    MAX_COMMENT_LENGTH,
    MAX_STORED_COMMENTS,
    COMMENT_RATE_LIMIT
};
