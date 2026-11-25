const crypto = require('node:crypto');
const {
    normalizeCode,
    normalizeTitle,
    normalizeDurationMinutes
} = require('../config/session-fields');

const CONTROL_RATE_LIMIT = 12;
const MAX_VIEWERS_DEFAULT = 20;
const MAX_VIEWERS_ABSOLUTE = 20;

function constantTimeEqual(expected, provided) {
    if (typeof expected !== 'string' || typeof provided !== 'string' || !expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pure session state: no sockets, no timers, no Electron. Every decision the
// signaling layer makes about a session goes through here so it can be tested.
//
// A session now represents a broadcast created by a host. One broadcaster can
// share their screen, and up to MAX_VIEWERS_DEFAULT (20) viewers can watch
// directly. Viewers beyond that can be offered a relay role (mesh) where they
// re-stream to other viewers, forming a sub-server tree under the host.
function createSessionStore({ now = Date.now } = {}) {
    let session = null;

    function get(studentId) {
        return session ? session.students.get(studentId) || null : null;
    }

    function findBySocket(socketId) {
        if (!session || !socketId) return null;
        for (const student of session.students.values()) {
            if (student.socketId === socketId) return student;
        }
        return null;
    }

    function serialize() {
        if (!session) return null;
        return {
            code: session.code,
            title: session.title,
            networkMode: session.networkMode,
            username: session.username,
            password: session.password,
            relayToken: session.relayToken,
            globalUrl: session.globalUrl,
            reachability: session.reachability,
            protocolVersion: session.protocolVersion,
            durationMinutes: session.durationMinutes,
            expiresAt: session.expiresAt,
            selectedStudentId: session.selectedStudentId,
            broadcasterId: session.broadcasterId,
            maxViewers: session.maxViewers,
            students: Array.from(session.students.values(), (student) => ({
                id: student.id,
                title: student.title,
                role: student.role,
                isSharing: student.isSharing,
                isPaused: student.isPaused,
                controlEnabled: student.controlEnabled,
                socketId: student.socketId,
                parentId: student.parentId,
                children: Array.from(student.children || [])
            }))
        };
    }

    function isExpired() {
        return Boolean(session && session.expiresAt && now() >= session.expiresAt);
    }

    function create({
        code, title, durationMinutes, networkMode, username, password, relayToken, globalUrl, protocolVersion, reachability = 'lan', maxViewers = MAX_VIEWERS_DEFAULT
    }) {
        const duration = normalizeDurationMinutes(durationMinutes);
        const viewersLimit = Math.min(Math.max(Number(maxViewers) || MAX_VIEWERS_DEFAULT, 1), MAX_VIEWERS_ABSOLUTE);
        session = {
            code: normalizeCode(code),
            title: normalizeTitle(title, 'جلسة البث'),
            networkMode: networkMode === 'global' ? 'global' : 'local',
            username: typeof username === 'string' ? username.trim() : '',
            password: typeof password === 'string' ? password : '',
            relayToken: typeof relayToken === 'string' ? relayToken : '',
            globalUrl: typeof globalUrl === 'string' ? globalUrl : '',
            reachability,
            protocolVersion: protocolVersion || null,
            durationMinutes: duration,
            expiresAt: duration ? now() + duration * 60 * 1000 : null,
            broadcasterId: null,
            maxViewers: viewersLimit,
            students: new Map(),
            nextNumber: 1,
            selectedStudentId: null
        };
        return serialize();
    }

    function clear() {
        session = null;
    }

    // join: the device joining with the session link becomes the presenter when no
    // presenter exists yet; everyone after that is a viewer. The role is decided
    // here, never taken from the client, so nobody can claim the broadcast slot.
    function join({ code, title, socketId = null, password = '' }) {
        if (!session || isExpired()) return { ok: false, reason: 'no-session' };
        if (normalizeCode(code) !== session.code) return { ok: false, reason: 'bad-code' };
        if (session.password && !constantTimeEqual(session.password, String(password))) {
            return { ok: false, reason: 'bad-password' };
        }

        const existing = findBySocket(socketId);
        if (existing) return { ok: true, student: existing };

        // Everyone joins as a viewer. The presenter is promoted only when they
        // actually start sharing, so an early viewer cannot block the real source.
        const role = 'viewer';
        {
            const directViewers = Array.from(session.students.values()).filter(
                (s) => s.role === 'viewer' && !s.parentId
            ).length;
            if (directViewers >= session.maxViewers) {
                return { ok: false, reason: 'session-full', maxViewers: session.maxViewers };
            }
        }

        const id = String(session.nextNumber++).padStart(3, '0');
        const student = {
            id,
            socketId,
            title: normalizeTitle(title, `المشاهد ${id}`),
            role,
            isSharing: false,
            isPaused: false,
            controlEnabled: false,
            parentId: null,
            children: new Set(),
            rateStart: 0,
            rateCount: 0
        };
        session.students.set(id, student);

        return { ok: true, student };
    }

    function setBroadcaster(id) {
        if (!session) return false;
        const student = get(id);
        if (!student) return false;
        session.broadcasterId = id;
        student.isSharing = true;
        student.role = 'broadcaster';
        return true;
    }

    function updateTitle(studentId, title) {
        const student = get(studentId);
        if (!student) return false;
        student.title = normalizeTitle(title, `المشاهد ${student.id}`);
        return true;
    }

    function markSharing(studentId, isSharing) {
        const student = get(studentId);
        if (!student) return false;
        student.isSharing = Boolean(isSharing);
        if (!isSharing) {
            student.isPaused = false;
            student.controlEnabled = false;
            if (session.selectedStudentId === studentId) session.selectedStudentId = null;
        }
        return true;
    }

    function markPaused(studentId, isPaused) {
        const student = get(studentId);
        if (!student || !student.isSharing) return false;
        student.isPaused = Boolean(isPaused);
        if (isPaused) student.controlEnabled = false;
        return true;
    }

    function setControl(studentId, enabled) {
        const student = get(studentId);
        if (!student) return false;
        if (enabled && (!student.isSharing || student.isPaused)) return false;
        student.controlEnabled = Boolean(enabled);
        return true;
    }

    function select(studentId) {
        if (!session) return { ok: false, reason: 'no-session' };
        const student = get(studentId);
        if (!student || !student.isSharing || student.isPaused) {
            return { ok: false, reason: 'student-not-broadcasting' };
        }
        const previousStudentId = session.selectedStudentId;
        session.selectedStudentId = studentId;
        return { ok: true, previousStudentId };
    }

    function clearSelection() {
        if (!session) return null;
        const previousStudentId = session.selectedStudentId;
        session.selectedStudentId = null;
        return previousStudentId;
    }

    function canSendKey(studentId) {
        const student = get(studentId);
        if (
            !session ||
            !student ||
            session.selectedStudentId !== studentId ||
            !student.isSharing ||
            student.isPaused ||
            !student.controlEnabled
        ) return false;

        const current = now();
        if (current - student.rateStart >= 1000) {
            student.rateStart = current;
            student.rateCount = 0;
        }
        if (student.rateCount >= CONTROL_RATE_LIMIT) return false;
        student.rateCount += 1;
        return true;
    }

    // Mesh relay: attach a viewer as child of a relay parent.
    function addRelayChild(parentId, childId) {
        if (!session) return false;
        const parent = get(parentId);
        const child = get(childId);
        if (!parent || !child || parentId === childId) return false;
        if (child.parentId) return false; // already attached
        // The child must not already be an ancestor of the parent, otherwise the
        // relay graph becomes cyclic and the tree walk would recurse forever.
        let ancestor = parent;
        const seen = new Set();
        while (ancestor && !seen.has(ancestor.id)) {
            if (ancestor.id === childId) return false;
            seen.add(ancestor.id);
            ancestor = ancestor.parentId ? get(ancestor.parentId) : null;
        }
        parent.children.add(childId);
        child.parentId = parentId;
        child.role = 'relay';
        return true;
    }

    function removeRelayChild(parentId, childId) {
        if (!session) return false;
        const parent = get(parentId);
        const child = get(childId);
        if (!parent || !child) return false;
        parent.children.delete(childId);
        if (child.parentId === parentId) child.parentId = null;
        if (child.role === 'relay' && !child.parentId) child.role = 'viewer';
        return true;
    }

    function getRelayTree() {
        if (!session) return null;
        const rootId = session.broadcasterId;
        if (!rootId) return null;
        const build = (id, visited = new Set()) => {
            const student = get(id);
            if (!student || visited.has(id)) return null;
            visited.add(id);
            return {
                id: student.id,
                role: student.role,
                isSharing: student.isSharing,
                children: Array.from(student.children)
                    .map((childId) => build(childId, visited))
                    .filter(Boolean)
            };
        };
        return build(rootId);
    }

    function removeBySocket(socketId) {
        const student = findBySocket(socketId);
        if (!student || !session) return null;

        // If this was a relay, reparent its children to the broadcaster (or clear them).
        if (student.children && student.children.size > 0) {
            const newParent = session.broadcasterId && session.broadcasterId !== student.id
                ? session.broadcasterId : null;
            for (const childId of Array.from(student.children)) {
                const child = get(childId);
                if (child) {
                    child.parentId = newParent;
                    if (!newParent && child.role === 'relay') child.role = 'viewer';
                    if (newParent) {
                        const parent = get(newParent);
                        if (parent) parent.children.add(childId);
                        else child.parentId = null;
                    }
                }
            }
            student.children.clear();
        }

        session.students.delete(student.id);
        if (session.selectedStudentId === student.id) session.selectedStudentId = null;
        if (session.broadcasterId === student.id) session.broadcasterId = null;
        return student;
    }

    function countDirectViewers() {
        if (!session) return 0;
        return Array.from(session.students.values()).filter(
            (s) => s.role === 'viewer' && !s.parentId
        ).length;
    }

    function countRelays() {
        if (!session) return 0;
        return Array.from(session.students.values()).filter(
            (s) => s.role === 'relay'
        ).length;
    }

    return {
        create,
        clear,
        isExpired,
        isGlobal: () => Boolean(session && session.networkMode === 'global'),
        join,
        setBroadcaster,
        get,
        findBySocket,
        updateTitle,
        markSharing,
        markPaused,
        setControl,
        select,
        clearSelection,
        canSendKey,
        removeBySocket,
        addRelayChild,
        removeRelayChild,
        getRelayTree,
        serialize,
        countDirectViewers,
        countRelays,
        get session() { return session; }
    };
}

module.exports = { createSessionStore, CONTROL_RATE_LIMIT, MAX_VIEWERS_DEFAULT, MAX_VIEWERS_ABSOLUTE };