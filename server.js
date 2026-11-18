const http = require('http');
const os = require('os');
const dgram = require('dgram');
const express = require('express');
const { Server } = require('socket.io');
const { isAllowedControlKey } = require('./keyboard-controls');

const UDP_DISCOVERY_PORT = 41234;
const CONTROL_RATE_LIMIT = 12;

function isLoopbackAddress(address) {
    return address === '::1' ||
        address === '127.0.0.1' ||
        address === '::ffff:127.0.0.1';
}

function ipv4ToNumber(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function isOnLocalSubnet(address) {
    if (isLoopbackAddress(address)) return true;
    const normalizedAddress = address && address.startsWith('::ffff:')
        ? address.slice('::ffff:'.length)
        : address;
    const remoteNumber = normalizedAddress ? ipv4ToNumber(normalizedAddress) : null;
    if (remoteNumber === null) return false;

    return Object.values(os.networkInterfaces()).some((interfaces) =>
        interfaces && interfaces.some((iface) => {
            if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) return false;
            const localNumber = ipv4ToNumber(iface.address);
            const maskNumber = ipv4ToNumber(iface.netmask);
            return localNumber !== null &&
                maskNumber !== null &&
                (remoteNumber & maskNumber) === (localNumber & maskNumber);
        })
    );
}

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}



//there is some mistake in the " `````` " word so fix it if see in any time 


function generateSixDigitCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function sendUdpBroadcast(socket, payload) {
    const packet = Buffer.from(payload);
    socket.send(packet, UDP_DISCOVERY_PORT, '255.255.255.255');

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
                const ipParts = iface.address.split('.').map(Number);
                const maskParts = iface.netmask.split('.').map(Number);
                const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
                socket.send(packet, UDP_DISCOVERY_PORT, bcast);
            }
        }
    }
}

// فحص الشبكة المحلية قبل اعتماد الرمز لمنع التشابه أو التعارض بين الأجهزة
function checkCodeExistsOnLan(candidateCode) {
    return new Promise((resolve) => {
        const probe = dgram.createSocket('udp4');
        let settled = false;

        const finish = (exists) => {
            if (settled) return;
            settled = true;
            try { probe.close(); } catch { }
            resolve(exists);
        };

        const timer = setTimeout(() => finish(false), 350);

        probe.on('message', (msg) => {
            if (msg.toString() === `LAB_SHOW_CODE_TAKEN: ${candidateCode}`) {
                clearTimeout(timer);
                finish(true);
            }
        });

        probe.on('error', () => {
            clearTimeout(timer);
            finish(false);
        });

        probe.bind(() => {
            probe.setBroadcast(true);
            sendUdpBroadcast(probe, `LAB_SHOW_CHECK_CODE: ${candidateCode}`);
        });
    });
}

function createLocalHostNode() {
    const app = express();
    const httpServer = http.createServer(app);
    const io = new Server(httpServer, {
        cors: { origin: '*' }
    });

    let hostUiSocketId = null;
    let activeSession = null;
    let reservingCode = null;
    let udpSocket = null;
    let listeningPort = 0;

    function getStudentBySocketId(socketId) {
        if (!activeSession) return null;
        for (const student of activeSession.students.values()) {
            if (student.socketId === socketId) return student;
        }
        return null;
    }

    function serializeSession() {
        if (!activeSession) return null;
        const students = Array.from(activeSession.students.values(), (student) => ({
            id: student.id,
            isSharing: student.isSharing,
            isPaused: student.isPaused,
            controlEnabled: student.controlEnabled
        }));
        const selectedStudent = activeSession.students.get(activeSession.selectedStudentId);

        return {
            code: activeSession.code,
            durationMinutes: activeSession.durationMinutes,
            expiresAt: activeSession.expiresAt,
            senderConnected: students.length > 0,
            isSharing: students.some((student) => student.isSharing),
            isPaused: Boolean(selectedStudent && selectedStudent.isPaused),
            controlEnabled: Boolean(selectedStudent && selectedStudent.controlEnabled),
            selectedStudentId: activeSession.selectedStudentId,
            students
        };
    }

    function notifyHostUI() {
        if (hostUiSocketId) {
            io.to(hostUiSocketId).emit('host-session-state', serializeSession());
        }
    }

    function setControlPermission(student, enabled) {
        if (!activeSession || student.controlEnabled === enabled) return;
        student.controlEnabled = enabled;
        const payload = { studentId: student.id, enabled };
        io.to(student.socketId).emit('student-control-permission-changed', payload);
        if (hostUiSocketId) {
            io.to(hostUiSocketId).emit('control-permission-changed', payload);
        }
        notifyHostUI();
    }

    function stopSelectedStudent() {
        if (!activeSession || !activeSession.selectedStudentId) return;
        const student = activeSession.students.get(activeSession.selectedStudentId);
        if (student) {
            io.to(student.socketId).emit('student-stop-viewing', { studentId: student.id });
        }
        activeSession.selectedStudentId = null;
    }

    function terminateSession(reason, senderMessage) {
        if (!activeSession) return;
        if (activeSession.timer) clearTimeout(activeSession.timer);

        for (const student of activeSession.students.values()) {
            io.to(student.socketId).emit('session-terminated', {
                reason,
                message: senderMessage
            });
        }

        activeSession = null;
        notifyHostUI();
        if (reason === 'expired' && hostUiSocketId) {
            io.to(hostUiSocketId).emit('host-expired-notice');
        }
    }

    io.on('connection', (socket) => {
        socket.on('register-host-ui', () => {
            if (!isLoopbackAddress(socket.handshake.address)) return;
            hostUiSocketId = socket.id;
            notifyHostUI();
        });

        socket.on('host-create-code', async ({ durationMinutes }, callback) => {
            if (!isLoopbackAddress(socket.handshake.address)) {
                if (typeof callback === 'function') {
                    callback({ ok: false, message: 'يجب إنشاء الجلسة من هذا الجهاز.' });
                }
                return;
            }
            hostUiSocketId = socket.id;

            if (activeSession) {
                terminateSession('replaced', 'تم استبدال الرمز برمز جديد.');
            }
            let uniqueCode = null;
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = generateSixDigitCode();
                reservingCode = candidate;
                const taken = await checkCodeExistsOnLan(candidate);
                if (!taken) {
                    uniqueCode = candidate;
                    break;
                }
            }
            reservingCode = null;

            if (!uniqueCode) uniqueCode = generateSixDigitCode();

            const parsedMinutes = Number(durationMinutes);
            const hasDuration = Number.isFinite(parsedMinutes) && parsedMinutes > 0;
            const expiresAt = hasDuration ? Date.now() + parsedMinutes * 60 * 1000 : null;
            activeSession = {
                code: uniqueCode,
                durationMinutes: hasDuration ? parsedMinutes : null,
                expiresAt,
                students: new Map(),
                nextStudentNumber: 1,
                selectedStudentId: null,
                timer: null
            };

            if (hasDuration) {
                activeSession.timer = setTimeout(() => {
                    terminateSession('expired', 'انتهت مدة صلاحية الرمز.');
                }, parsedMinutes * 60 * 1000);
            }

            notifyHostUI();
            if (typeof callback === 'function') {
                callback({ ok: true, session: serializeSession() });
            }
        });

        socket.on('host-delete-code', () => {
            if (socket.id !== hostUiSocketId) return;
            terminateSession('deleted-by-host', 'تم إيقاف البث وحذف الرمز من قِبل الأستاذ.');
        });

        socket.on('sender-join-code', ({ code }, callback) => {
            const reject = (message) => {
                if (typeof callback === 'function') callback({ ok: false, message });
            };
            const cleanCode = (code || '').trim();
            if (!activeSession || activeSession.code !== cleanCode) {
                reject('الرمز غير صحيح أو منتهي.');
                return;
            }
            if (activeSession.expiresAt && Date.now() >= activeSession.expiresAt) {
                terminateSession('expired', 'انتهت مدة صلاحية الرمز.');
                reject('انتهت صلاحية الرمز.');
                return;
            }

            let student = getStudentBySocketId(socket.id);
            if (!student) {
                const studentId = String(activeSession.nextStudentNumber++).padStart(3, '0');
                student = {
                    id: studentId,
                    socketId: socket.id,
                    isSharing: false,
                    isPaused: false,
                    controlEnabled: false,
                    controlRateWindowStart: 0,
                    controlRateCount: 0
                };
                activeSession.students.set(studentId, student);
            }

            notifyHostUI();
            if (typeof callback === 'function') {
                callback({
                    ok: true,
                    expiresAt: activeSession.expiresAt,
                    studentId: student.id
                });
            }
        });

        socket.on('sender-start-sharing', () => {
            const student = getStudentBySocketId(socket.id);
            if (!student) return;
            student.isSharing = true;
            student.isPaused = false;
            notifyHostUI();
        });

        socket.on('sender-control-permission', ({ enabled }, callback) => {
            const student = getStudentBySocketId(socket.id);
            if (!student || typeof enabled !== 'boolean') {
                if (typeof callback === 'function') {
                    callback({ ok: false, message: 'لا توجد جلسة مشاركة نشطة.' });
                }
                return;
            }
            if (!enabled) {
                setControlPermission(student, false);
                if (typeof callback === 'function') callback({ ok: true, enabled: false });
                return;
            }
            if (!student.isSharing || student.isPaused) {
                if (typeof callback === 'function') callback({ ok: false, message: 'ابدأ بث الشاشة أولاً.' });
                return;
            }
            if (!isOnLocalSubnet(socket.handshake.address)) {
                if (typeof callback === 'function') {
                    callback({ ok: false, message: 'التحكم متاح داخل الشبكة المحلية فقط.' });
                }
                return;
            }
            setControlPermission(student, true);
            if (typeof callback === 'function') callback({ ok: true, enabled: true });
        });

        socket.on('host-select-student', ({ studentId }, callback) => {
            const reject = (message) => {
                if (typeof callback === 'function') callback({ ok: false, message });
            };
            if (socket.id !== hostUiSocketId || !activeSession) {
                reject('مصدر التحكم غير مصرح.');
                return;
            }
            const student = activeSession.students.get(studentId);
            if (!student || !student.isSharing || student.isPaused) {
                reject('الطالب غير متصل بالبث حالياً.');
                return;
            }
            if (activeSession.selectedStudentId !== student.id) {
                stopSelectedStudent();
                activeSession.selectedStudentId = student.id;
                io.to(student.socketId).emit('student-start-viewing', { studentId: student.id });
                notifyHostUI();
            }
            if (typeof callback === 'function') callback({ ok: true, studentId: student.id });
        });

        socket.on('host-control-key', ({ studentId, key }, callback) => {
            const reject = (message) => {
                if (typeof callback === 'function') callback({ ok: false, message });
            };
            if (socket.id !== hostUiSocketId) {
                reject('مصدر التحكم غير مصرح.');
                return;
            }
            const student = activeSession && activeSession.students.get(studentId);
            if (
                !student ||
                activeSession.selectedStudentId !== studentId ||
                !student.isSharing ||
                student.isPaused ||
                !student.controlEnabled
            ) {
                reject('لم يفعّل الطالب التحكم لهذا البث.');
                return;
            }
            if (!isAllowedControlKey(key)) {
                reject('هذا المفتاح غير مسموح.');
                return;
            }

            const now = Date.now();
            if (now - student.controlRateWindowStart >= 1000) {
                student.controlRateWindowStart = now;
                student.controlRateCount = 0;
            }
            if (student.controlRateCount >= CONTROL_RATE_LIMIT) {
                reject('تم تجاوز حد ضغطات المفاتيح المسموح.');
                return;
            }
            student.controlRateCount += 1;
            io.to(student.socketId).emit('student-control-key', { studentId, key });
            if (typeof callback === 'function') callback({ ok: true });
        });

        socket.on('sender-pause-sharing', () => {
            const student = getStudentBySocketId(socket.id);
            if (!student) return;
            student.isPaused = true;
            setControlPermission(student, false);
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-paused-sharing', { studentId: student.id });
            }
        });

        socket.on('sender-resume-sharing', () => {
            const student = getStudentBySocketId(socket.id);
            if (!student) return;
            student.isPaused = false;
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-resumed-sharing', { studentId: student.id });
            }
        });

        socket.on('sender-stop-sharing', () => {
            const student = getStudentBySocketId(socket.id);
            if (!student) return;
            if (activeSession.selectedStudentId === student.id) stopSelectedStudent();
            student.isSharing = false;
            student.isPaused = false;
            setControlPermission(student, false);
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-stopped-sharing', { studentId: student.id });
            }
        });

        socket.on('webrtc-offer', ({ studentId, offer }) => {
            const student = getStudentBySocketId(socket.id);
            if (
                !student ||
                student.id !== studentId ||
                activeSession.selectedStudentId !== student.id ||
                !student.isSharing ||
                student.isPaused
            ) return;
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('webrtc-offer', { studentId, offer });
            }
        });

        socket.on('webrtc-answer', ({ studentId, answer }) => {
            if (socket.id !== hostUiSocketId || !activeSession) return;
            if (activeSession.selectedStudentId !== studentId) return;
            const student = activeSession.students.get(studentId);
            if (student) {
                io.to(student.socketId).emit('webrtc-answer', { studentId, answer });
            }
        });

        socket.on('webrtc-ice-candidate', ({ candidate, target, studentId }) => {
            if (!activeSession || activeSession.selectedStudentId !== studentId) return;
            const student = activeSession.students.get(studentId);
            if (!student) return;

            if (target === 'host' && student.socketId === socket.id) {
                if (hostUiSocketId) {
                    io.to(hostUiSocketId).emit('webrtc-ice-candidate', { candidate, studentId });
                }
            } else if (target === 'sender' && socket.id === hostUiSocketId) {
                io.to(student.socketId).emit('webrtc-ice-candidate', { candidate, studentId });
            }
        });

        socket.on('disconnect', () => {
            if (socket.id === hostUiSocketId) hostUiSocketId = null;
            const student = getStudentBySocketId(socket.id);
            if (!student) return;
            if (activeSession.selectedStudentId === student.id) stopSelectedStudent();
            activeSession.students.delete(student.id);
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-left', { studentId: student.id });
            }
        });
    });

    function startUdpResponder() {
        udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        udpSocket.on('message', (msg, rinfo) => {
            const text = msg.toString();

            if (text.startsWith('LAB_SHOW_CHECK_CODE:')) {
                const candidate = text.slice('LAB_SHOW_CHECK_CODE:'.length).trim();
                const isTaken =
                    (activeSession && activeSession.code === candidate) ||
                    reservingCode === candidate;

                if (isTaken) {
                    const reply = Buffer.from(`LAB_SHOW_CODE_TAKEN: ${candidate}`);
                    udpSocket.send(reply, rinfo.port, rinfo.address);
                }
                return;
            }

            if (text.startsWith('LAB_SHOW_FIND:')) {
                const requestedCode = text.slice('LAB_SHOW_FIND:'.length).trim();
                if (
                    activeSession &&
                    activeSession.code === requestedCode &&
                    (!activeSession.expiresAt || Date.now() < activeSession.expiresAt)
                ) {
                    const reply = Buffer.from(`LAB_SHOW_MATCH: ${requestedCode}: ${listeningPort}`);
                    udpSocket.send(reply, rinfo.port, rinfo.address);
                }
            }
        });

        udpSocket.on('error', (err) => {
            console.error('UDP responder error:', err.message);
        });

        try {
            udpSocket.bind(UDP_DISCOVERY_PORT, '0.0.0.0');
        } catch (err) {
            console.error('UDP bind error:', err.message);
        }
    }

    return {
        start: () =>
            new Promise((resolve, reject) => {
                httpServer.on('error', reject);
                httpServer.listen(0, '0.0.0.0', () => {
                    listeningPort = httpServer.address().port;
                    startUdpResponder();
                    resolve({ port: listeningPort, ips: getLocalIPs() });
                });
            }),
        stop: () =>
            new Promise((resolve) => {
                if (udpSocket) {
                    try { udpSocket.close(); } catch { }
                    udpSocket = null;
                }
                io.close();
                httpServer.close(() => resolve());
            }),
        getInfo: () => ({ port: listeningPort, ips: getLocalIPs() })
    };
}

module.exports = { createLocalHostNode, UDP_DISCOVERY_PORT };

