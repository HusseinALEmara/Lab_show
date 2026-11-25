(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const I18n = window.LabShowI18n;
    const Links = window.LabShowLinks;
    const { t, setText, errorKey } = I18n;
    const bridge = window.electronAPI;
    const hasBridge = Boolean(bridge && typeof bridge.getHostInfo === 'function');
    const api = bridge || {
        getHostInfo: async () => null,
        openRoom: async () => ({ ok: false }),
        setOutgoingState() {},
        onRoomOwnerState() {}
    };

    // ---------- DOM elements ----------
    const welcomePane = $('welcomePane');
    const broadcastPane = $('broadcastPane');

    // The two ways in, as two tabs of one page
    const tabCreate = $('tabCreate');
    const tabJoin = $('tabJoin');
    const createCard = $('createCard');
    const joinCard = $('joinCard');

    // Create link form
    const meshTitle = $('meshTitle');
    const meshPassword = $('meshPassword');
    const meshMaxViewers = $('meshMaxViewers');
    const meshNetworkMode = $('meshNetworkMode');
    const meshDuration = $('meshDuration');
    const meshCreateBtn = $('meshCreateBtn');
    const meshCreateStatus = $('meshCreateStatus');
    const meshLinkBox = $('meshLinkBox');
    const meshLinkText = $('meshLinkText');
    const meshCopyLinkBtn = $('meshCopyLinkBtn');
    const meshCancelLinkBtn = $('meshCancelLinkBtn');
    const meshReachNote = $('meshReachNote');

    // Join form
    const meshJoinLink = $('meshJoinLink');
    const meshJoinPassword = $('meshJoinPassword');
    const meshJoinName = $('meshJoinName');
    const meshJoinBtn = $('meshJoinBtn');
    const meshJoinStatus = $('meshJoinStatus');

    // Broadcast UI (exists on both welcome and broadcast pages)
    const broadcastHeading = $('broadcastHeading');
    const broadcastMeta = $('broadcastMeta');
    const broadcasterCard = $('broadcasterCard');
    const viewerCard = $('viewerCard');
    const waitingCard = $('waitingCard');
    const selfVideo = $('selfVideo');
    const selfLabel = $('selfLabel');
    const remoteVideo = $('remoteVideo');
    const viewerTitle = $('viewerTitle');
    const btnStartBroadcast = $('btnStartBroadcast');
    const btnStopBroadcast = $('btnStopBroadcast');
    const btnControlToggle = $('btnControlToggle');
    const keyPad = $('keyPad');
    const broadcastPill = $('broadcastPill');
    const viewerCount = $('viewerCount');
    const btnToggleRelay = $('btnToggleRelay');
    const relayControl = $('relayControl');
    const relayStatus = $('relayStatus');
    const viewerPill = $('viewerPill');
    const viewerCountDisplay = $('viewerCountDisplay');
    const btnViewerRelay = $('btnViewerRelay');
    const viewerRelayControl = $('viewerRelayControl');
    const viewerRelayStatus = $('viewerRelayStatus');
    const btnReceiverPause = $('btnReceiverPause');
    const btnFullscreen = $('btnFullscreen');
    const btnOpenRoom = $('btnOpenRoom');
    const btnViewIncoming = $('btnViewIncoming');
    const waitingText = $('waitingText');
    // "View live broadcast" button on the welcome page - opens live view inline
    const btnViewLive = $('btnViewLive');
    const btnBackToWelcome = $('btnBackToWelcome');
    const liveContainer = $('liveContainer');
    const inlineRemoteVideo = $('inlineRemoteVideo');
    const inlineViewerTitle = $('inlineViewerTitle');
    const inlineViewerCard = $('inlineViewerCard');
    const inlineWaitingCard = $('inlineWaitingCard');

    // ---------- State ----------
    let hostInfo = null;
    let socket = null;
    let myRole = null; // 'host' | 'broadcaster' | 'viewer' | 'relay'
    let myStudentId = null;
    let sessionCode = null;
    let sessionPassword = null;
    let isBroadcasting = false;
    let isPaused = false;
    let isRelay = false;
    let outStream = null;
    let outPC = null;
    let outWsSender = null;
    let inPC = null;
    let inStream = null;
    let inWsReceiver = null;
    let incomingStudentId = null;
    // Socket.IO listeners are bound once per socket; revisiting a page must not
    // register the same handler again.
    const boundSockets = new WeakSet();
    const relayButtonsBound = new WeakSet();
    let viewerCountNum = 0;
    let networkMode = 'local';
    let maxViewers = 20;
    let sessionBroadcasterId = null;
    let controlAllowed = false;
    let isFullscreen = false;

    const WsMedia = window.LabShowWsMedia;
    const QualityApi = window.AdaptiveQuality;
    const DIRECT_TIMEOUT_MS = 8000;

    // ---------- Helpers ----------
    function showPane(name) {
        welcomePane.hidden = name !== 'welcome';
        broadcastPane.hidden = name !== 'broadcast';
        if (name === 'welcome') showWelcomeTab('create');
        if (name === 'broadcast') I18n.apply(document);
    }

    function setStatus(el, key, type = '', vars) {
        if (!el) return;
        setText(el, key, vars);
        el.className = `status-text ${type}`;
    }

    function segmentValue(el) {
        const active = el && el.querySelector('button.active');
        return active ? active.dataset.mode : 'local';
    }

    function bindSegmented(el) {
        el.addEventListener('click', (ev) => {
            const btn = ev.target.closest('button[data-mode]');
            if (!btn) return;
            el.querySelectorAll('button[data-mode]').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
        });
    }

    function copyText(text, statusEl) {
        return navigator.clipboard.writeText(text).then(() => {
            setStatus(statusEl, 'recv.copied', 'ok');
        }).catch(() => {
            setStatus(statusEl, 'recv.copyFailed', 'err');
        });
    }

    function activeTitle() {
        return 'Lab show';
    }

    // ---------- Navigation ----------
    function showWelcomeTab(tab) {
        const createActive = tab === 'create';
        createCard.hidden = !createActive;
        joinCard.hidden = createActive;
        tabCreate.classList.toggle('active', createActive);
        tabJoin.classList.toggle('active', !createActive);
        tabCreate.setAttribute('aria-selected', String(createActive));
        tabJoin.setAttribute('aria-selected', String(!createActive));
    }
    tabCreate.addEventListener('click', () => showWelcomeTab('create'));
    tabJoin.addEventListener('click', () => showWelcomeTab('join'));

    // Public broadcast lives in its own window, opened by Electron.
    if (btnOpenRoom) {
        btnOpenRoom.addEventListener('click', async () => {
            if (!hasBridge) return setStatus(meshCreateStatus, 'send.desktopOnly', 'err');
            const result = await api.openRoom({
                role: 'owner',
                title: meshTitle.value.trim() || t('mesh.defaultTitle'),
                name: t('mesh.hostName'),
                mode: segmentValue(meshNetworkMode) === 'global' ? 'global' : 'local',
                duration: Number(meshDuration.value)
            });
            if (!result || !result.ok) return setStatus(meshCreateStatus, 'mesh.roomFailed', 'err');
            setStatus(meshCreateStatus, 'pub.opened', 'ok');
        });
    }

    bindSegmented(meshNetworkMode);
    meshCreateBtn.addEventListener('click', async () => {
        if (!hasBridge) return setStatus(meshCreateStatus, 'send.desktopOnly', 'err');
        const title = meshTitle.value.trim() || t('mesh.defaultTitle');
        const password = meshPassword.value.trim();
        const maxViewersVal = Number(meshMaxViewers.value);
        const mode = segmentValue(meshNetworkMode);
        const duration = Number(meshDuration.value);

        meshCreateBtn.disabled = true;
        I18n.setText(meshCreateBtn, 'recv.generating');
        setStatus(meshCreateStatus, 'recv.generating');

        try {
            const info = await api.getHostInfo();
            if (!info) throw new Error('no-host-info');
            hostInfo = info;
            networkMode = mode;
            maxViewers = maxViewersVal;

            // Connect to local host
            await connectToHost(info.port, info.hostSecret);

            // Create session as host
            socket.timeout(15000).emit('host:create', {
                title,
                durationMinutes: duration,
                networkMode: mode,
                username: t('mesh.hostName'),
                password: password || '',
                maxViewers: maxViewersVal,
                protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
            }, (error, response) => {
                meshCreateBtn.disabled = false;
                I18n.setText(meshCreateBtn, 'mesh.create');
                if (error || !response || !response.ok) {
                    setStatus(meshCreateStatus, errorKey(response, 'mesh.linkFailed'), 'err');
                    return;
                }
                sessionCode = response.session.code;
                sessionPassword = password || '';
                const link = response.session.globalUrl || `http://127.0.0.1:${info.port}/j?k=s&c=${response.session.code}&t=${response.session.relayToken}&p=${encodeURIComponent(password || '')}`;
                meshLinkText.textContent = link;
                meshLinkBox.hidden = false;
                setStatus(meshCreateStatus, 'mesh.linkCreated', 'ok');
                myRole = 'host';
                broadcastMeta.textContent = `${t('mesh.host')} · ${sessionCode}`;
                btnViewIncoming.hidden = false;
                // Attach signaling listeners now so an early offer is not lost while
                // the host is still on the link page.
                setupBroadcastUI();
            });
        } catch (err) {
            meshCreateBtn.disabled = false;
            I18n.setText(meshCreateBtn, 'mesh.create');
            setStatus(meshCreateStatus, 'mesh.linkFailed', 'err');
            console.error('create link', err);
        }
    });

    meshCopyLinkBtn.addEventListener('click', () => copyText(meshLinkText.textContent, meshCreateStatus));

    // Cancel the created link
    meshCancelLinkBtn.addEventListener('click', () => {
        if (!socket || !socket.connected) return;
        if (!window.confirm(t('mesh.cancelLinkConfirm'))) return;
        if (socket) socket.emit('host:delete');
        meshLinkBox.hidden = true;
        meshLinkText.textContent = '';
        btnViewIncoming.hidden = true;
        myRole = null;
        setStatus(meshCreateStatus, 'mesh.cancelLinkSuccess', 'ok');
        showPane('welcome');
    });

    // Join via link
    meshJoinBtn.addEventListener('click', async () => {
        if (!hasBridge) return setStatus(meshJoinStatus, 'send.desktopOnly', 'err');
        const rawLink = meshJoinLink.value.trim();
        const password = meshJoinPassword.value.trim();
        const name = meshJoinName.value.trim() || t('mesh.viewerName');

        const parsed = Links.parseLink(rawLink);
        if (!parsed) return setStatus(meshJoinStatus, 'mesh.badLink', 'err');

        // A room link opens the separate public-broadcast window.
        if (parsed.kind === 'room') {
            meshJoinBtn.disabled = true;
            const result = await api.openRoom({
                role: 'viewer',
                host: parsed.host, port: parsed.port, web: parsed.webUrl,
                code: parsed.code, token: parsed.token,
                mode: parsed.mode === 'global' ? 'global' : 'local',
                name
            });
            meshJoinBtn.disabled = false;
            if (!result || !result.ok) return setStatus(meshJoinStatus, 'mesh.roomFailed', 'err');
            return setStatus(meshJoinStatus, 'pub.opened', 'ok');
        }

        meshJoinBtn.disabled = true;
        I18n.setText(meshJoinBtn, 'recv.generating');
        setStatus(meshJoinStatus, 'recv.generating');

        try {
            const urls = Links.connectTargets(parsed);

            let connected = false;
            for (const url of urls) {
                try {
                    await tryConnect(url, parsed, password, name);
                    connected = true;
                    break;
                } catch (e) {
                    console.error('join url failed', url, e);
                }
            }
            if (!connected) {
                meshJoinBtn.disabled = false;
                I18n.setText(meshJoinBtn, 'mesh.join');
                setStatus(meshJoinStatus, 'mesh.joinFailed', 'err');
            }
        } catch (err) {
            meshJoinBtn.disabled = false;
            I18n.setText(meshJoinBtn, 'mesh.join');
            setStatus(meshJoinStatus, 'mesh.joinFailed', 'err');
            console.error('join', err);
        }
    });

    async function tryConnect(url, parsed, password, name) {
        return new Promise((resolve) => {
            if (socket) { try { socket.disconnect(); } catch { /* ignore */ } }
            socket = io(url, { timeout: 8000, reconnection: false, forceNew: true });
            let settled = false;
            const timer = setTimeout(() => finish(false), 8000);
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (!ok) {
                    try { socket.disconnect(); } catch { /* ignore */ }
                    socket = null;
                }
                resolve(ok);
            };
            // The socket is already connected here; do not wait for a second
            // "connect" event (reconnection is disabled, so it never arrives).
            socket.once('connect', () => finish(true));
            socket.once('connect_error', () => finish(false));
        }).then(async (ok) => {
            if (!ok || !socket) throw new Error('connect failed');
            sessionCode = parsed.code;
            sessionPassword = parsed.password || password;
            networkMode = parsed.mode;
            // The server decides who presents; the link's username is part of the
            // global-session credential and must be forwarded exactly.
            await new Promise((resolve, reject) => {
                socket.timeout(10000).emit('student:join', {
                    code: parsed.code,
                    title: name,
                    username: parsed.username || '',
                    token: parsed.token || '',
                    password: parsed.password || password,
                    protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
                }, (error, response) => {
                    if (error || !response || !response.ok) {
                        setStatus(meshJoinStatus, errorKey(response, 'mesh.joinFailed'), 'err');
                        try { socket.disconnect(); } catch { /* ignore */ }
                        socket = null;
                        return reject(new Error((response && response.error) || 'join failed'));
                    }
                    myStudentId = response.studentId;
                    myRole = response.role || 'viewer';
                    sessionBroadcasterId = response.broadcasterId || null;
                    sessionCode = parsed.code;
                    showPane('broadcast');
                    setupBroadcastUI();
                    setStatus(meshJoinStatus, 'mesh.linkCreated', 'ok');
                    resolve();
                });
            });
        });
    }

    async function connectToHost(port, secret) {
        return new Promise((resolve, reject) => {
            socket = io(`http://127.0.0.1:${port}`, { timeout: 8000, reconnection: false, forceNew: true });
            socket.once('connect', () => {
                socket.timeout(5000).emit('host:register', { secret }, (err, res) => {
                    if (err || !res || !res.ok) {
                        reject(new Error('register failed'));
                    } else {
                        resolve();
                    }
                });
            });
            socket.once('connect_error', reject);
        });
    }

    // ---------- Broadcast UI setup ----------
    function setupBroadcastUI() {
        // A viewer may start if nobody has claimed the presenter slot yet; the
        // server promotes the first device that actually starts sharing.
        const isPresenter = myRole === 'broadcaster' || (myRole === 'viewer' && !sessionBroadcasterId);
        if (isPresenter) {
            broadcasterCard.hidden = false;
            viewerCard.hidden = true;
            waitingCard.hidden = true;
            btnStartBroadcast.hidden = false;
            btnStopBroadcast.hidden = true;
            btnControlToggle.hidden = false;
            keyPad.hidden = true;
            isBroadcasting = false;
            setText(broadcastPill, 'mesh.notStarted');
            setText(viewerCount, 'mesh.viewers', { n: 0 });
            setText(broadcastHeading, 'mesh.broadcastTitle');
            setupRelayUI(true);
        } else {
            // The host watches the participant's screen in this same viewer card.
            broadcasterCard.hidden = true;
            viewerCard.hidden = false;
            waitingCard.hidden = false;
            btnControlToggle.hidden = true;
            keyPad.hidden = true;
            waitingText.textContent = t('recv.placeholder');
            setText(broadcastHeading, myRole === 'host' ? 'mesh.incoming' : 'mesh.broadcastTitle');
            setupRelayUI(false);
            if (myRole === 'host') {
                relayControl.hidden = true;
                viewerRelayControl.hidden = true;
            }
        }

        if (!socket || boundSockets.has(socket)) return;
        boundSockets.add(socket);

        socket.on('session:state', (state) => {
            if (!state) return;
            const previousBroadcaster = sessionBroadcasterId;
            sessionBroadcasterId = state.broadcasterId || null;
            if (myRole === 'viewer' && Boolean(previousBroadcaster) !== Boolean(sessionBroadcasterId)) {
                setupBroadcastUI();
            }
            viewerCountNum = state.students ? state.students.filter(s => s.role === 'viewer' && !s.parentId).length : 0;
            setText(viewerCount, 'mesh.viewers', { n: viewerCountNum });
            setText(viewerCountDisplay, 'mesh.viewers', { n: viewerCountNum });
        });

        socket.on('session:ended', () => {
            setStatus(broadcastPill, 'recv.ended', 'err');
            stopIncoming();
            stopLocalBroadcast();
        });

        socket.on('session:expired', () => {
            setStatus(broadcastPill, 'recv.expired', 'err');
            stopIncoming();
            stopLocalBroadcast();
        });

        socket.on('webrtc:offer', (payload) => {
            // The participant who joined our link is sending their screen.
            if (payload && payload.studentId) {
                incomingStudentId = payload.studentId;
                handleIncomingOffer(payload.studentId, payload.offer);
            }
        });

        socket.on('webrtc:answer', (payload) => {
            if (outPC && !outPC.remoteDescription) {
                outPC.setRemoteDescription(new RTCSessionDescription(payload.answer)).catch(console.error);
            }
        });

        socket.on('webrtc:ice', (payload) => {
            if (outPC && outPC.remoteDescription) {
                outPC.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(console.error);
            } else if (inPC && incomingStudentId && payload && payload.studentId === incomingStudentId) {
                inPC.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(console.error);
            }
        });

        // WebSocket fallback: the sender encodes frames when WebRTC cannot connect.
        socket.on('media:video', (meta, data) => {
            if (myRole !== 'host' && myRole !== 'viewer') return;
            if (!inWsReceiver) {
                if (!WsMedia || !WsMedia.createVideoReceiver) return;
                inWsReceiver = WsMedia.createVideoReceiver({
                    onNeedKeyframe: () => {
                        if (socket && socket.connected) socket.emit('host:keyframe', { studentId: incomingStudentId });
                    }
                });
                remoteVideo.srcObject = inWsReceiver.stream;
                waitingCard.hidden = true;
                viewerCard.hidden = false;
                setText(viewerPill, 'recv.viewing');
            }
            inWsReceiver.push(meta, data);
        });

        socket.on('mesh:relay-offer', ({ from, to, offer }) => {
            if (myRole !== 'host' && myRole !== 'broadcaster') return;
            handleMeshRelayOffer(from, to, offer);
        });

        socket.on('mesh:relay-answer', ({ from, to, answer }) => {
            // Answer to our relay offer
        });

        socket.on('mesh:relay-ice', ({ from, to, candidate }) => {
            // ICE candidate for mesh
        });

        socket.on('session:full', () => {
            setStatus(broadcastPill, 'err.session-full', 'err');
        });

        socket.on('control:permission', ({ enabled } = {}) => {
            controlAllowed = Boolean(enabled);
            if (myRole !== 'broadcaster') {
                keyPad.hidden = !controlAllowed;
                setText(viewerPill, controlAllowed ? 'keys.allowed' : 'keys.waitingApproval');
            }
            setText(btnControlToggle, controlAllowed ? 'control.revoke' : 'control.allow');
        });
    }

    function stopIncoming() {
        if (inWsReceiver) {
            try { inWsReceiver.stop(); } catch { /* ignore */ }
            inWsReceiver = null;
        }
        if (inPC) {
            inPC.close();
            inPC = null;
        }
        incomingStudentId = null;
        if (remoteVideo) remoteVideo.srcObject = null;
        if (inlineRemoteVideo) inlineRemoteVideo.srcObject = null;
    }

    // Buttons that never change their behaviour, bound once so a second visit to
    // the broadcast page cannot attach the same handler twice.
    function bindPageControls() {
        btnReceiverPause.addEventListener('click', () => {
            isPaused = !isPaused;
            if (remoteVideo) remoteVideo.muted = isPaused;
            if (inlineRemoteVideo) inlineRemoteVideo.muted = isPaused;
            btnReceiverPause.textContent = isPaused ? '▶' : '⏸';
        });

        btnFullscreen.addEventListener('click', toggleFullscreen);

        btnControlToggle.addEventListener('click', () => {
            if (!socket || !socket.connected) return;
            socket.timeout(5000).emit('student:permission', { enabled: !controlAllowed }, (error, response) => {
                if (error || !response || !response.ok) {
                    setStatus(broadcastPill, errorKey(response, 'control.failed'), 'err');
                    return;
                }
                controlAllowed = Boolean(response.enabled);
                setText(btnControlToggle, controlAllowed ? 'control.revoke' : 'control.allow');
            });
        });

        keyPad.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-key]');
            if (!button || !sessionBroadcasterId || !socket || !socket.connected) return;
            socket.emit('host:key', { studentId: sessionBroadcasterId, key: button.dataset.key });
        });

        btnBackToWelcome.addEventListener('click', () => {
            stopIncoming();
            stopLocalBroadcast();
            showPane('welcome');
        });

        // View the live broadcast inline, on the same page
        btnViewLive.addEventListener('click', () => openLiveView());

        // Host: watch the broadcast a participant sends through this link
        btnViewIncoming.addEventListener('click', () => {
            showPane('broadcast');
            setupBroadcastUI();
        });
    }

    function openLiveView() {
        liveContainer.hidden = false;
        btnViewLive.hidden = true;
        // Show waiting card if broadcast not yet started
        if (!remoteVideo.srcObject && !inPC) {
            inlineWaitingCard.hidden = false;
            inlineViewerCard.hidden = true;
            waitingText.textContent = t('recv.placeholder');
        }
        // If broadcast is already active, show viewer card
        if (remoteVideo.srcObject) {
            inlineViewerCard.hidden = false;
            inlineWaitingCard.hidden = true;
            inlineRemoteVideo.srcObject = remoteVideo.srcObject;
            inlineViewerTitle.textContent = activeTitle();
        }
    }

    // Update inline view when broadcast starts (if user is viewing inline)
    function updateInlineView() {
        if (liveContainer && !liveContainer.hidden) {
            if (remoteVideo.srcObject) {
                inlineViewerCard.hidden = false;
                inlineWaitingCard.hidden = true;
                inlineRemoteVideo.srcObject = remoteVideo.srcObject;
            }
        }
    }

    function setupRelayUI() {
        // The relay negotiation is not implemented end-to-end; do not offer a
        // control that would fail. Viewers still watch through the host.
        relayControl.hidden = true;
        viewerRelayControl.hidden = true;
    }

    // ---------- Broadcaster: start sharing ----------
    btnStartBroadcast.addEventListener('click', async () => {
        if (!socket || !socket.connected) return;
        if (myRole === 'host') return;
        if (myRole === 'viewer' && sessionBroadcasterId) return;

        try {
            setText(btnStartBroadcast, 'recv.generating');
            btnStartBroadcast.disabled = true;

            outStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
                audio: false
            });
            selfVideo.srcObject = outStream;
            selfLabel.textContent = t('mesh.broadcaster');

            // Mark self as sharing on server
            socket.emit('student:start');
            isBroadcasting = true;
            btnStartBroadcast.hidden = true;
            btnStopBroadcast.hidden = false;
            setText(broadcastPill, 'mesh.broadcasting');

            // Start WebRTC to host (we are the broadcaster sending TO host)
            startOutgoingWebRTC();

            outStream.getVideoTracks()[0].addEventListener('ended', () => {
                stopLocalBroadcast();
            });
        } catch (err) {
            console.error('capture', err);
            setStatus(broadcastPill, 'send.captureFailed', 'err');
            btnStartBroadcast.disabled = false;
            I18n.setText(btnStartBroadcast, 'mesh.startBroadcast');
        }
    });

    btnStopBroadcast.addEventListener('click', () => {
        stopLocalBroadcast();
    });

    function stopLocalBroadcast() {
        isBroadcasting = false;
        if (controlAllowed && socket && socket.connected) {
            socket.emit('student:permission', { enabled: false }, () => {});
            controlAllowed = false;
            keyPad.hidden = true;
            setText(btnControlToggle, 'control.allow');
        }
        if (outStream) {
            outStream.getTracks().forEach(t => t.stop());
            outStream = null;
        }
        if (outPC) {
            outPC.close();
            outPC = null;
        }
        if (outWsSender) {
            outWsSender.stop();
            outWsSender = null;
        }
        selfVideo.srcObject = null;
        btnStartBroadcast.hidden = false;
        btnStopBroadcast.hidden = true;
        btnStartBroadcast.disabled = false;
        I18n.setText(btnStartBroadcast, 'mesh.startBroadcast');
        setText(broadcastPill, 'mesh.paused');
        if (socket && socket.connected) {
            socket.emit('student:stop');
        }
    }

    async function startOutgoingWebRTC() {
        const pc = new RTCPeerConnection({ iceServers: iceServersFor(networkMode === 'global') });
        outPC = pc;
        outStream.getTracks().forEach(track => pc.addTrack(track, outStream));

        pc.onicecandidate = (ev) => {
            if (ev.candidate && socket && socket.connected) {
                socket.emit('student:ice', { studentId: myStudentId, candidate: ev.candidate });
            }
        };

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('student:offer', { studentId: myStudentId, offer });
            // UDP can be blocked without ever producing a "failed" state. If no
            // direct path is up shortly, start the WebSocket fallback.
            const fallbackTimer = setTimeout(() => {
                if (outPC === pc && pc.connectionState !== 'connected') {
                    switchToWebSocket();
                    if (socket && socket.connected) socket.emit('student:transport', { mode: 'ws' });
                }
            }, DIRECT_TIMEOUT_MS);
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'connected') clearTimeout(fallbackTimer);
                if (pc.connectionState === 'failed') {
                    clearTimeout(fallbackTimer);
                    switchToWebSocket();
                }
            };
        } catch (err) {
            console.error('outgoing offer', err);
        }
    }

    function switchToWebSocket() {
        if (outWsSender || !outStream) return;
        outWsSender = WsMedia.createVideoSender({
            track: outStream.getVideoTracks()[0],
            send: (meta, data) => socket && socket.emit('student:media', meta, data),
            isBacklogged: WsMedia.backlogOf(socket)
        });
    }

    // ---------- Viewer: receive broadcast ----------
    function handleIncomingOffer(studentId, offer) {
        incomingStudentId = studentId || null;
        if (inPC) inPC.close();
        inPC = new RTCPeerConnection({ iceServers: iceServersFor(networkMode === 'global') });

        inPC.ontrack = (ev) => {
            if (ev.streams && ev.streams[0]) {
                inStream = ev.streams[0];
                remoteVideo.srcObject = inStream;
                waitingCard.hidden = true;
                viewerCard.hidden = false;
                viewerTitle.textContent = activeTitle();
                setText(viewerPill, 'recv.viewing');
                updateInlineView();
            }
        };

        inPC.onicecandidate = (ev) => {
            if (ev.candidate && socket && socket.connected) {
                socket.emit('host:ice', { studentId: incomingStudentId, candidate: ev.candidate });
            }
        };

        inPC.setRemoteDescription(new RTCSessionDescription(offer)).then(() => {
            return inPC.createAnswer();
        }).then(answer => {
            return inPC.setLocalDescription(answer);
        }).then(() => {
            socket.emit('host:answer', { studentId: incomingStudentId, answer });
        }).catch(console.error);
    }

    // ---------- Mesh relay ----------
    async function handleMeshRelayOffer(from, to, offer) {
        // We act as relay: create PC to forward to the child viewer
        const relayPc = new RTCPeerConnection({ iceServers: iceServersFor(networkMode === 'global') });
        // We need our own screen stream to forward. For simplicity, if we are the broadcaster,
        // we forward our outStream. If we are a viewer in relay mode, we would need to re-encode.
        // Here we only support broadcaster-as-relay for MVP.
        if (outStream) {
            outStream.getTracks().forEach(track => relayPc.addTrack(track, outStream));
        }
        relayPc.onicecandidate = (ev) => {
            if (ev.candidate && socket && socket.connected) {
                socket.emit('mesh:relay-ice', { from: myStudentId, to, candidate: ev.candidate });
            }
        };
        try {
            const answer = await relayPc.createAnswer();
            await relayPc.setLocalDescription(answer);
            socket.emit('mesh:relay-answer', { from: myStudentId, to, answer });
            // Tell server to attach child
            socket.emit('mesh:attach-child', { parentId: myStudentId, childId: to });
        } catch (err) {
            console.error('relay answer', err);
        }
    }

    // ---------- ICE servers ----------
    function iceServersFor(global) {
        return global && hostInfo && Array.isArray(hostInfo.iceServers) ? hostInfo.iceServers : [];
    }

    // ---------- Fullscreen / Floating ----------
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    }

    // ---------- Socket.io-client global for HTML ----------
    window.io = window.io || (typeof require !== 'undefined' ? require('socket.io-client') : null);

    // ---------- Boot ----------
    I18n.apply(document);
    bindSegmented(meshNetworkMode);
    bindPageControls();
    showPane('welcome');

    // If running in preview (no Electron bridge), disable host-only actions.
    if (!hasBridge) {
        meshCreateBtn.disabled = true;
        meshJoinBtn.disabled = true;
        setStatus(meshCreateStatus, 'send.desktopOnly', 'err');
        setStatus(meshJoinStatus, 'send.desktopOnly', 'err');
    }

})();