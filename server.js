const http = require('http');
const os = require('os');
const dgram = require('dgram');
const express = require('express');
const { Server } = require('socket.io');

const UDP_DISCOVERY_PORT = 41234;

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

    function serializeSession() {
        if (!activeSession) return null;
        return {
            code: activeSession.code,
            durationMinutes: activeSession.durationMinutes,
            expiresAt: activeSession.expiresAt,
            senderConnected: Boolean(activeSession.senderSocketId),
            isSharing: activeSession.isSharing,
            isPaused: activeSession.isPaused
        };
    }

    function notifyHostUI() {
        if (hostUiSocketId) {
            io.to(hostUiSocketId).emit('host-session-state', serializeSession());
        }
    }

    function terminateSession(reason, senderMessage) {
        if (!activeSession) return;

        if (activeSession.timer) {
            clearTimeout(activeSession.timer);
            activeSession.timer = null;
        }

        if (activeSession.senderSocketId) {
            io.to(activeSession.senderSocketId).emit('session-terminated', {
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
            hostUiSocketId = socket.id;
            notifyHostUI();
        });

        socket.on('host-create-code', async ({ durationMinutes }, callback) => {
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

            if (!uniqueCode) {
                uniqueCode = generateSixDigitCode();
            }

            const parsedMinutes = Number(durationMinutes);
            const hasDuration = Number.isFinite(parsedMinutes) && parsedMinutes > 0;
            const expiresAt = hasDuration ? Date.now() + parsedMinutes * 60 * 1000 : null;

            activeSession = {
                code: uniqueCode,
                durationMinutes: hasDuration ? parsedMinutes : null,
                expiresAt,
                senderSocketId: null,
                isSharing: false,
                isPaused: false,
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
            terminateSession('deleted-by-host', 'تم إيقاف البث وحذف الرمز من قِبل المستقبِل.');
        });

        socket.on('sender-join-code', ({ code }, callback) => {
            const cleanCode = (code || '').trim();

            if (!activeSession || activeSession.code !== cleanCode) {
                if (typeof callback === 'function') {
                    return callback({ ok: false, message: 'الرمز غير صحيح أو منتهي.' });
                }
                return;
            }

            if (activeSession.expiresAt && Date.now() >= activeSession.expiresAt) {
                terminateSession('expired', 'انتهت مدة صلاحية الرمز.');
                if (typeof callback === 'function') {
                    return callback({ ok: false, message: 'انتهت صلاحية الرمز.' });
                }
                return;
            }

            if (activeSession.senderSocketId && activeSession.senderSocketId !== socket.id) {
                if (typeof callback === 'function') {
                    return callback({ ok: false, message: 'الرمز مستخدم حالياً من قِبل جهاز آخر.' });
                }
                return;
            }

            activeSession.senderSocketId = socket.id;
            activeSession.isSharing = false;
            activeSession.isPaused = false;
            notifyHostUI();

            if (typeof callback === 'function') {
                callback({ ok: true, expiresAt: activeSession.expiresAt });
            }
        });

        socket.on('sender-start-sharing', () => {
            if (!activeSession || activeSession.senderSocketId !== socket.id) return;
            activeSession.isSharing = true;
            activeSession.isPaused = false;
            notifyHostUI();
        });

        socket.on('sender-pause-sharing', () => {
            if (!activeSession || activeSession.senderSocketId !== socket.id) return;
            activeSession.isPaused = true;
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-paused-sharing');
            }
        });

        socket.on('sender-resume-sharing', () => {
            if (!activeSession || activeSession.senderSocketId !== socket.id) return;
            activeSession.isPaused = false;
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-resumed-sharing');
            }
        });

        socket.on('sender-stop-sharing', () => {
            if (!activeSession || activeSession.senderSocketId !== socket.id) return;
            activeSession.isSharing = false;
            activeSession.isPaused = false;
            activeSession.senderSocketId = null;
            notifyHostUI();
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('sender-stopped-sharing');
            }
        });

        socket.on('webrtc-offer', ({ offer }) => {
            if (!activeSession || activeSession.senderSocketId !== socket.id) return;
            if (hostUiSocketId) {
                io.to(hostUiSocketId).emit('webrtc-offer', { offer });
            }
        });

        socket.on('webrtc-answer', ({ answer }) => {
            if (socket.id !== hostUiSocketId) return;
            if (activeSession && activeSession.senderSocketId) {
                io.to(activeSession.senderSocketId).emit('webrtc-answer', { answer });
            }
        });
        socket.on('webrtc-ice-candidate', ({ candidate, target }) => {
            if (target === 'host' && activeSession && activeSession.senderSocketId === socket.id) {
                if (hostUiSocketId) {
                    io.to(hostUiSocketId).emit('webrtc-ice-candidate', { candidate });
                }
            } else if (target === 'sender' && socket.id === hostUiSocketId) {
                if (activeSession && activeSession.senderSocketId) {
                    io.to(activeSession.senderSocketId).emit('webrtc-ice-candidate', { candidate });
                }
            }
        });

        socket.on('disconnect', () => {
            if (socket.id === hostUiSocketId) {
                hostUiSocketId = null;
            }
            if (activeSession && activeSession.senderSocketId === socket.id) {
                activeSession.senderSocketId = null;
                activeSession.isSharing = false;
                activeSession.isPaused = false;
                notifyHostUI();
                if (hostUiSocketId) {
                    io.to(hostUiSocketId).emit('sender-left');
                }
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

