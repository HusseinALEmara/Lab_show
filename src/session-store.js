const {
    normalizeCode,
    normalizeTitle,
    normalizeDurationMinutes
} = require('./session-fields');

const CONTROL_RATE_LIMIT = 12;

// Pure session state: no sockets, no timers, no Electron. Every decision the
// signaling layer makes about a session goes through here so it can be tested.
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
            relayToken: session.relayToken,
            globalUrl: session.globalUrl,
            reachability: session.reachability,
            protocolVersion: session.protocolVersion,
            durationMinutes: session.durationMinutes,
            expiresAt: session.expiresAt,
            selectedStudentId: session.selectedStudentId,
            students: Array.from(session.students.values(), (student) => ({
                id: student.id,
                title: student.title,
                isSharing: student.isSharing,
                isPaused: student.isPaused,
                controlEnabled: student.controlEnabled
            }))
        };
    }

    function isExpired() {
        return Boolean(session && session.expiresAt && now() >= session.expiresAt);
    }

    function create({
        code, title, durationMinutes, networkMode, username, relayToken, globalUrl, protocolVersion, reachability = 'lan'
    }) {
        const duration = normalizeDurationMinutes(durationMinutes);
        session = {
            code: normalizeCode(code),
            title: normalizeTitle(title, 'جلسة الأستاذ'),
            networkMode: networkMode === 'global' ? 'global' : 'local',
            username: typeof username === 'string' ? username.trim() : '',
            relayToken: typeof relayToken === 'string' ? relayToken : '',
            globalUrl: typeof globalUrl === 'string' ? globalUrl : '',
            reachability,
            protocolVersion: protocolVersion || null,
            durationMinutes: duration,
            expiresAt: duration ? now() + duration * 60 * 1000 : null,
            students: new Map(),
            nextNumber: 1,
            selectedStudentId: null
        };
        return serialize();
    }

    function clear() {
        session = null;
    }

    function join({ code, title, socketId = null }) {
        if (!session || isExpired()) return { ok: false, reason: 'no-session' };
        if (normalizeCode(code) !== session.code) return { ok: false, reason: 'bad-code' };

        const existing = findBySocket(socketId);
        if (existing) return { ok: true, student: existing };

        const id = String(session.nextNumber++).padStart(3, '0');
        const student = {
            id,
            socketId,
            title: normalizeTitle(title, `الطالب ${id}`),
            isSharing: false,
            isPaused: false,
            controlEnabled: false,
            rateStart: 0,
            rateCount: 0
        };
        session.students.set(id, student);
        return { ok: true, student };
    }

    function updateTitle(studentId, title) {
        const student = get(studentId);
        if (!student) return false;
        student.title = normalizeTitle(title, `الطالب ${student.id}`);
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

    function removeBySocket(socketId) {
        const student = findBySocket(socketId);
        if (!student || !session) return null;
        session.students.delete(student.id);
        if (session.selectedStudentId === student.id) session.selectedStudentId = null;
        return student;
    }

    return {
        create,
        clear,
        isExpired,
        isGlobal: () => Boolean(session && session.networkMode === 'global'),
        join,
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
        serialize,
        get session() { return session; }
    };
}

module.exports = { createSessionStore, CONTROL_RATE_LIMIT };
