(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const I18n = window.LabShowI18n;
    const Links = window.LabShowLinks;
    const { t } = I18n;
    const bridge = window.electronAPI;
    const hasBridge = Boolean(bridge && typeof bridge.getHostInfo === 'function');
    const api = bridge || {
        getHostInfo: async () => null,
        findHostByCode: async () => null,
        setFullScreen() {},
        setWindowSizeMode() {},
        showWindow() {},
        setOutgoingState() {},
        setStudentControlEnabled() {},
        applyControlKey: async () => ({ ok: false }),
        canStartOutgoing: async () => ({ ok: true }),
        openRoom: async () => ({ ok: false }),
        onTrayStopBroadcast() {},
        onTrayTogglePause() {},
        onTrayToggleControl() {},
        onFloatingClosed() {},
        onRoomOwnerState() {}
    };

    const ids = [
        'liveStatusBar', 'liveStatusText', 'langToggle',
        'codeCard', 'broadcastCard', 'codeInput', 'sendLinkInput', 'joinTitleInput',
        'approveCodeBtn', 'cancelCodeBtn', 'outgoingStatus', 'studentIdentity', 'broadcastStatusPill',
        'titleDisplayBtn', 'titleDisplayText', 'titleEditor', 'broadcastTitleInput', 'titleUpdateBtn',
        'pauseBroadcastBtn', 'stopBroadcastBtn', 'studentControlToggle', 'studentControlStatus',
        'publicCard', 'pubTitleInput', 'pubNameInput', 'pubNetworkMode', 'pubDurationSelect', 'pubStartBtn', 'pubStatus',
        'codeSettingsCard', 'durationSelect', 'networkModeSelect', 'generateBtn', 'hostStatus',
        'generatedBox', 'generatedCode', 'copyCodeBtn', 'globalLinkText', 'copyGlobalLinkBtn', 'reachNote',
        'generatedTitle', 'hostTimer', 'hostStateText', 'deleteCodeBtn',
        'joinCodeInput', 'joinLinkInput', 'joinNameInput', 'joinRoomBtn', 'joinStatus',
        'rosterCard', 'studentRoster', 'emptyRoster', 'rosterViewBtn',
        'teacherControlsCard', 'teacherControlStatus',
        'videoBox', 'remoteVideo', 'freezeCanvas', 'videoPlaceholder', 'viewerTitle',
        'receiverPauseBtn', 'floatBtn', 'fullscreenBtn', 'expandIcon', 'compressIcon'
    ];
    const dom = Object.fromEntries(ids.map((id) => [id, $(id)]));
    dom.remoteKeyButtons = Array.from(document.querySelectorAll('[data-remote-key]'));

    let hostInfo = null;
    let inSocket = null;
    let hostSession = null;
    let hostStudents = [];
    let selectedStudentId = null;
    let networkMode = 'local';
    let hostCountdownTimer = null;
    let incomingStudentId = null;
    let isIncomingPaused = false;
    let floatingWin = null;
    let isFullscreen = false;
    let hideControlsTimer = null;
    let roomOwnerActive = false;

    let outSocket = null;
    let outStream = null;
    let outPC = null;
    let outPendingIce = [];
    let outQualityTimer = null;
    let outQualityController = null;
    let outgoingGlobal = false;
    let outgoingRelayIce = []; // the receiver's own relay, handed out after joining
    let outgoingRequestId = 0;
    let joinedStudentId = null;
    let outgoingTargetCode = '';
    let isSharingOutgoing = false;
    let isPausedOutgoing = false;
    let outgoingBusy = false;
    let isStudentControlEnabled = false;
    let permissionPending = false;
    let permissionRequestId = 0;

    const incoming = new Map(); // studentId -> { pc, pending: [], stream }
    const tileVideos = new Map(); // studentId -> HTMLVideoElement
    const studentCards = new Map(); // studentId -> card elements

    // ---------- helpers ----------

    function setStatus(element, key, type = '', vars) {
        if (!element) return;
        I18n.setText(element, key, vars);
        element.className = `status-text ${type}`;
    }

    function segmentedValue(element) {
        const active = element && element.querySelector('button.active');
        return active ? active.dataset.mode : 'local';
    }

    function bindSegmented(element) {
        element.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-mode]');
            if (!button) return;
            element.querySelectorAll('button[data-mode]').forEach((item) => {
                item.classList.toggle('active', item === button);
            });
        });
    }

    function iceServersFor(global) {
        return global && hostInfo && Array.isArray(hostInfo.iceServers) ? hostInfo.iceServers : [];
    }

    function activeTitle() {
        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        return selected?.title || 'Lab show';
    }

    async function copyText(text, statusElement) {
        try {
            await navigator.clipboard.writeText(text);
            setStatus(statusElement, 'recv.copied', 'ok');
        } catch (error) {
            setStatus(statusElement, 'recv.copyFailed', 'err');
        }
    }

    bindSegmented(dom.networkModeSelect);
    bindSegmented(dom.pubNetworkMode);
    dom.langToggle.addEventListener('click', () => I18n.toggle());
    I18n.onChange(() => {
        syncOutgoingUi();
        renderHostSession(hostSession);
        dom.rosterViewBtn.textContent = t(dom.studentRoster.classList.contains('grid-view') ? 'recv.listView' : 'recv.gridView');
    });
    dom.rosterViewBtn.addEventListener('click', () => {
        const isGrid = dom.studentRoster.classList.toggle('grid-view');
        dom.rosterViewBtn.dataset.i18n = isGrid ? 'recv.listView' : 'recv.gridView';
        dom.rosterViewBtn.textContent = t(dom.rosterViewBtn.dataset.i18n);
    });
    dom.titleDisplayBtn.addEventListener('click', () => {
        dom.titleEditor.hidden = !dom.titleEditor.hidden;
        if (!dom.titleEditor.hidden) dom.broadcastTitleInput.focus();
    });
    dom.copyCodeBtn.addEventListener('click', () => copyText(dom.generatedCode.textContent, dom.hostStatus));
    dom.copyGlobalLinkBtn.addEventListener('click', () => copyText(dom.globalLinkText.textContent, dom.hostStatus));
    for (const input of [dom.codeInput, dom.joinCodeInput]) {
        input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
    }
    // Pasting a link fills in the code too.
    function fillCodeFromLink(linkInput, codeInput) {
        linkInput.addEventListener('input', () => {
            const parsed = Links.parseLink(linkInput.value);
            if (parsed && !codeInput.value.trim()) codeInput.value = parsed.code;
        });
    }
    fillCodeFromLink(dom.sendLinkInput, dom.codeInput);
    fillCodeFromLink(dom.joinLinkInput, dom.joinCodeInput);

    // ---------- outgoing (send my screen to one receiver) ----------

    function setOutgoingNotice(key, type = '') {
        setStatus(dom.outgoingStatus, key, type);
        I18n.setText(dom.studentControlStatus, key);
    }

    function setLiveStatus(key) {
        dom.liveStatusBar.hidden = !key;
        if (key) I18n.setText(dom.liveStatusText, key);
    }

    function syncOutgoingUi(messageKey) {
        dom.codeCard.hidden = isSharingOutgoing;
        dom.broadcastCard.hidden = !isSharingOutgoing;
        if (!isSharingOutgoing) setLiveStatus(null);
        dom.titleDisplayText.textContent = dom.broadcastTitleInput.value || '—';
        I18n.setText(dom.broadcastStatusPill, isPausedOutgoing ? 'send.paused' : 'send.live');
        dom.studentIdentity.textContent = joinedStudentId
            ? `${t('send.target', { code: outgoingTargetCode })} · ${joinedStudentId}` : '';

        dom.studentControlToggle.hidden = outgoingGlobal;
        dom.studentControlToggle.disabled = !isSharingOutgoing || isPausedOutgoing || permissionPending;
        dom.studentControlToggle.setAttribute('aria-checked', String(isStudentControlEnabled));
        I18n.setText(dom.studentControlToggle, isStudentControlEnabled ? 'control.revoke' : 'control.allow');

        let statusKey = messageKey;
        if (!statusKey) {
            if (outgoingGlobal && isSharingOutgoing) statusKey = 'control.globalOff';
            else if (isStudentControlEnabled) statusKey = 'control.on';
            else if (isPausedOutgoing) statusKey = 'control.pausedHint';
            else statusKey = 'control.off';
        }
        I18n.setText(dom.studentControlStatus, statusKey);

        I18n.setText(dom.pauseBroadcastBtn, isPausedOutgoing ? 'send.resume' : 'send.pause');
        dom.pauseBroadcastBtn.disabled = !isSharingOutgoing;
        dom.stopBroadcastBtn.disabled = !isSharingOutgoing;
        dom.approveCodeBtn.disabled = outgoingBusy || roomOwnerActive;
        dom.pubStartBtn.disabled = isSharingOutgoing || outgoingBusy;
        api.setOutgoingState({ sharing: isSharingOutgoing, paused: isPausedOutgoing });
    }

    function setLocalPermission(enabled, messageKey) {
        isStudentControlEnabled = Boolean(enabled);
        if (!isStudentControlEnabled) {
            permissionRequestId += 1;
            permissionPending = false;
        }
        api.setStudentControlEnabled(isStudentControlEnabled);
        syncOutgoingUi(messageKey);
    }

    function requestStudentControl(enabled) {
        if (!enabled) {
            if (outSocket && outSocket.connected) outSocket.emit('student:permission', { enabled: false });
            setLocalPermission(false, 'control.revoked');
            return;
        }
        if (outgoingGlobal) {
            syncOutgoingUi('control.globalOff');
            return;
        }
        if (isStudentControlEnabled || permissionPending) return;
        if (!isSharingOutgoing || isPausedOutgoing || !outSocket || !outSocket.connected) {
            syncOutgoingUi('control.startFirst');
            return;
        }
        const requestId = ++permissionRequestId;
        permissionPending = true;
        syncOutgoingUi('control.pending');
        outSocket.timeout(3000).emit('student:permission', { enabled: true }, (error, response) => {
            if (requestId !== permissionRequestId) return;
            permissionPending = false;
            if (error || !response || !response.ok) {
                setLocalPermission(false, I18n.errorKey(response, 'control.failed'));
                return;
            }
            setLocalPermission(true, 'control.on');
        });
    }

    dom.studentControlToggle.addEventListener('click', () => requestStudentControl(!isStudentControlEnabled));

    function setOutgoingPaused(paused) {
        if (!isSharingOutgoing || !outStream || !outSocket) return;
        const next = Boolean(paused);
        if (isPausedOutgoing === next) return;
        if (next) requestStudentControl(false);
        isPausedOutgoing = next;
        const track = outStream.getVideoTracks()[0];
        if (track) track.enabled = !isPausedOutgoing;
        outSocket.emit(isPausedOutgoing ? 'student:pause' : 'student:resume');
        syncOutgoingUi();
    }

    function toggleOutgoingPause() {
        setOutgoingPaused(!isPausedOutgoing);
    }

    function stopOutgoingViewing() {
        outgoingRequestId += 1;
        if (outQualityTimer) {
            clearInterval(outQualityTimer);
            outQualityTimer = null;
        }
        outQualityController = null;
        if (outPC) {
            outPC.ontrack = null;
            outPC.onicecandidate = null;
            outPC.close();
            outPC = null;
        }
        outPendingIce = [];
    }

    async function startOutgoingViewing(studentId) {
        if (!isSharingOutgoing || isPausedOutgoing || !outStream || !outSocket || studentId !== joinedStudentId) return;
        stopOutgoingViewing();
        const requestId = outgoingRequestId;
        const socket = outSocket;
        const pc = new RTCPeerConnection({ iceServers: [...iceServersFor(outgoingGlobal), ...outgoingRelayIce] });
        outPC = pc;
        outStream.getTracks().forEach((track) => pc.addTrack(track, outStream));

        const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
        const qualityApi = window.AdaptiveQuality;
        if (sender && qualityApi && qualityApi.createQualityController) {
            outQualityController = qualityApi.createQualityController({ mode: outgoingGlobal ? 'global' : 'local' });
            const applyQuality = async (result) => {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    params.encodings[0].maxBitrate = result.maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = result.scaleResolutionDownBy;
                    await sender.setParameters(params);
                } catch (error) {
                    console.error('quality', error);
                }
            };
            applyQuality(outQualityController.state);
            outQualityTimer = setInterval(async () => {
                if (outPC !== pc || !outQualityController || !socket.connected) return;
                try {
                    const stats = await pc.getStats();
                    let availableBitrate = null;
                    let lossRatio = 0;
                    let jitterMs = 0;
                    stats.forEach((report) => {
                        if (report.type === 'candidate-pair' && report.state === 'succeeded' &&
                            report.availableOutgoingBitrate) {
                            availableBitrate = report.availableOutgoingBitrate;
                        }
                        if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                            lossRatio = report.fractionLost || 0;
                            jitterMs = (report.jitter || 0) * 1000;
                        }
                    });
                    const result = outQualityController.update({ availableBitrate, lossRatio, jitterMs });
                    if (result.changed) await applyQuality(result);
                } catch (error) {
                    console.error('stats', error);
                }
            }, 3000);
        }

        pc.onicecandidate = (event) => {
            if (event.candidate && outPC === pc && outSocket === socket) {
                socket.emit('student:ice', { studentId, candidate: event.candidate });
            }
        };
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (requestId !== outgoingRequestId || outPC !== pc || outSocket !== socket) {
                pc.close();
                return;
            }
            socket.emit('student:offer', { studentId, offer });
        } catch (error) {
            console.error('offer', error);
        }
    }

    function stopOutgoingShare(notifyRemote = true) {
        if (outSocket && outSocket.connected) {
            if (isStudentControlEnabled) outSocket.emit('student:permission', { enabled: false });
            if (notifyRemote && isSharingOutgoing) outSocket.emit('student:stop');
        }
        if (outStream) {
            outStream.getTracks().forEach((track) => track.stop());
            outStream = null;
        }
        stopOutgoingViewing();
        if (outSocket) {
            outSocket.removeAllListeners();
            outSocket.disconnect();
            outSocket = null;
        }
        joinedStudentId = null;
        isSharingOutgoing = false;
        isPausedOutgoing = false;
        outgoingBusy = false;
        outgoingGlobal = false;
        outgoingRelayIce = [];
        permissionPending = false;
        permissionRequestId += 1;
        setLocalPermission(false);
        syncOutgoingUi();
    }

    function attachOutgoingHandlers(socket, code, broadcastTitle, identity) {
        socket.on('connect', () => {
            socket.timeout(5000).emit('student:join', {
                code,
                title: broadcastTitle,
                username: identity ? identity.username : undefined,
                token: identity ? identity.token : undefined,
                protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
            }, async (error, response) => {
                if (error || !response || !response.ok) {
                    stopOutgoingShare(false);
                    setStatus(dom.outgoingStatus, I18n.errorKey(response, 'send.joinFailed'), 'err');
                    return;
                }
                outgoingGlobal = outgoingGlobal || response.networkMode === 'global';
                outgoingRelayIce = Array.isArray(response.iceServers) ? response.iceServers : [];
                try {
                    outStream = await navigator.mediaDevices.getDisplayMedia({
                        video: {
                            frameRate: { ideal: 30, max: 30 },
                            width: { ideal: 1920, max: 1920 },
                            height: { ideal: 1080, max: 1080 }
                        },
                        audio: false
                    });
                    if (outSocket !== socket) {
                        outStream.getTracks().forEach((track) => track.stop());
                        outStream = null;
                        return;
                    }
                    joinedStudentId = response.studentId;
                    outgoingTargetCode = code;
                    const finalTitle = (broadcastTitle || '').trim() || 'Lab show';
                    dom.broadcastTitleInput.value = finalTitle;
                    dom.titleEditor.hidden = true;
                    socket.emit('student:start');
                    isSharingOutgoing = true;
                    isPausedOutgoing = false;
                    outgoingBusy = false;
                    syncOutgoingUi();
                    setStatus(dom.outgoingStatus, 'send.live', 'ok');
                    setLiveStatus('send.liveWaiting');
                    outStream.getVideoTracks().forEach((track) => {
                        track.addEventListener('ended', () => {
                            if (outSocket === socket && isSharingOutgoing) {
                                stopOutgoingShare(true);
                                setStatus(dom.outgoingStatus, 'send.stopped');
                            }
                        }, { once: true });
                    });
                } catch (captureError) {
                    console.error('capture', captureError);
                    stopOutgoingShare(true);
                    setStatus(dom.outgoingStatus, 'send.captureFailed', 'err');
                }
            });
        });

        socket.on('connect_error', () => {
            if (outSocket !== socket) return;
            stopOutgoingShare(false);
            setStatus(dom.outgoingStatus, 'send.connectFailed', 'err');
        });
        socket.on('preview:start', ({ studentId }) => {
            if (studentId === joinedStudentId) startOutgoingViewing(studentId).catch(console.error);
        });
        socket.on('preview:stop', ({ studentId }) => {
            if (studentId === joinedStudentId) stopOutgoingViewing();
        });
        socket.on('webrtc:answer', async ({ answer }) => {
            if (!outPC || outPC.remoteDescription) return;
            try {
                await outPC.setRemoteDescription(new RTCSessionDescription(answer));
                for (const candidate of outPendingIce) await outPC.addIceCandidate(new RTCIceCandidate(candidate));
                outPendingIce = [];
            } catch (error) {
                console.error('answer', error);
            }
        });
        socket.on('webrtc:ice', async ({ candidate }) => {
            try {
                if (outPC && outPC.remoteDescription) await outPC.addIceCandidate(new RTCIceCandidate(candidate));
                else outPendingIce.push(candidate);
            } catch (error) {
                console.error('ice', error);
            }
        });
        socket.on('control:key', async ({ key }) => {
            if (outgoingGlobal || !isStudentControlEnabled || !isSharingOutgoing || isPausedOutgoing) return;
            try {
                const result = await api.applyControlKey(key);
                if (!result.ok) syncOutgoingUi('control.keyFailed');
            } catch (error) {
                syncOutgoingUi('control.keyFailed');
            }
        });
        socket.on('student:selected', () => setLiveStatus('send.liveSeen'));
        socket.on('session:expiring', () => setOutgoingNotice('send.expiring', 'err'));
        socket.on('control:permission', ({ enabled }) => {
            if (!enabled && isStudentControlEnabled) setLocalPermission(false, 'control.withdrawn');
        });
        socket.on('host:pause', ({ paused }) => {
            setOutgoingPaused(paused);
            setOutgoingNotice(paused ? 'send.pausedByReceiver' : 'send.resumedByReceiver', paused ? '' : 'ok');
        });
        socket.on('session:ended', () => {
            stopOutgoingShare(false);
            setStatus(dom.outgoingStatus, 'send.sessionEnded', 'err');
        });
        socket.on('host:stop', () => {
            stopOutgoingShare(true);
            setStatus(dom.outgoingStatus, 'send.stoppedByReceiver', 'err');
        });
        socket.on('disconnect', () => {
            if (outSocket !== socket) return;
            if (isSharingOutgoing || outgoingBusy) {
                stopOutgoingShare(false);
                setStatus(dom.outgoingStatus, 'send.disconnected', 'err');
            }
        });
    }

    async function beginOutgoingShare() {
        if (!hasBridge) return setStatus(dom.outgoingStatus, 'send.desktopOnly', 'err');
        if (outgoingBusy) return;
        let code = dom.codeInput.value.trim().toUpperCase();
        const rawLink = dom.sendLinkInput.value.trim();
        let target = null;
        let identity = null;
        let global = false;

        if (rawLink) {
            const parsed = Links.parseLink(rawLink);
            if (!parsed) return setStatus(dom.outgoingStatus, 'send.badLink', 'err');
            if (parsed.kind === 'room') return setStatus(dom.outgoingStatus, 'send.roomLink', 'err');
            if (code && code !== parsed.code) return setStatus(dom.outgoingStatus, 'send.codeMismatch', 'err');
            code = parsed.code;
            dom.codeInput.value = code;
            target = { ip: parsed.host, port: parsed.port };
            global = parsed.mode === 'global';
            if (global) identity = { username: parsed.username, token: parsed.token };
        }
        if (!Links.CODE_PATTERN.test(code)) return setStatus(dom.outgoingStatus, 'send.badCode', 'err');

        const allowed = await api.canStartOutgoing();
        if (!allowed || !allowed.ok) return setStatus(dom.outgoingStatus, 'send.roomActive', 'err');

        outgoingBusy = true;
        syncOutgoingUi();
        if (!target) {
            setStatus(dom.outgoingStatus, 'send.searching');
            try {
                target = await api.findHostByCode(code);
            } catch (error) {
                target = null;
            }
            if (!target || !target.port) {
                outgoingBusy = false;
                syncOutgoingUi();
                return setStatus(dom.outgoingStatus, 'send.notFound', 'err');
            }
        }
        setStatus(dom.outgoingStatus, 'send.connecting');
        stopOutgoingShare(true);
        outgoingBusy = true;
        outgoingGlobal = global;
        syncOutgoingUi();
        outSocket = io(`http://${target.ip}:${target.port}`, {
            timeout: 5000,
            reconnectionDelay: 500,
            reconnectionDelayMax: 2000
        });
        attachOutgoingHandlers(outSocket, code, dom.joinTitleInput.value, identity);
    }

    dom.approveCodeBtn.addEventListener('click', () => beginOutgoingShare());
    dom.cancelCodeBtn.addEventListener('click', () => {
        if (isSharingOutgoing) stopOutgoingShare(true);
        dom.codeInput.value = '';
        dom.sendLinkInput.value = '';
        setStatus(dom.outgoingStatus, 'send.ready');
    });
    dom.codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') dom.approveCodeBtn.click();
    });
    dom.titleUpdateBtn.addEventListener('click', () => {
        if (!outSocket || !outSocket.connected || !isSharingOutgoing) return;
        dom.titleUpdateBtn.disabled = true;
        outSocket.timeout(3000).emit('student:update-title', { title: dom.broadcastTitleInput.value }, (error, response) => {
            dom.titleUpdateBtn.disabled = false;
            if (error || !response || !response.ok) {
                return setOutgoingNotice(I18n.errorKey(response, 'send.titleFailed'), 'err');
            }
            dom.broadcastTitleInput.value = response.title;
            dom.titleDisplayText.textContent = response.title;
            dom.titleEditor.hidden = true;
            setOutgoingNotice('send.titleUpdated', 'ok');
        });
    });
    dom.pauseBroadcastBtn.addEventListener('click', toggleOutgoingPause);
    dom.stopBroadcastBtn.addEventListener('click', () => {
        if (!isSharingOutgoing) return;
        stopOutgoingShare(true);
        setStatus(dom.outgoingStatus, 'send.stopped');
    });
    api.onTrayTogglePause(toggleOutgoingPause);
    api.onTrayToggleControl(() => requestStudentControl(!isStudentControlEnabled));
    api.onTrayStopBroadcast(() => {
        if (isSharingOutgoing) stopOutgoingShare(true);
        setStatus(dom.outgoingStatus, 'send.stopped');
    });

    // ---------- public broadcast ----------

    dom.pubStartBtn.addEventListener('click', async () => {
        if (!hasBridge) return setStatus(dom.pubStatus, 'send.desktopOnly', 'err');
        if (isSharingOutgoing || outgoingBusy) return setStatus(dom.pubStatus, 'pub.sendingActive', 'err');
        const result = await api.openRoom({
            role: 'owner',
            lang: I18n.lang,
            mode: segmentedValue(dom.pubNetworkMode),
            title: dom.pubTitleInput.value,
            name: dom.pubNameInput.value,
            duration: dom.pubDurationSelect.value
        });
        if (!result || !result.ok) return setStatus(dom.pubStatus, I18n.errorKey(result, 'pub.sendingActive'), 'err');
        setStatus(dom.pubStatus, 'pub.opened', 'ok');
    });

    api.onRoomOwnerState(({ active }) => {
        roomOwnerActive = Boolean(active);
        if (roomOwnerActive) {
            setStatus(dom.outgoingStatus, 'send.roomActive');
            setStatus(dom.pubStatus, 'pub.ownerActive', 'ok');
        } else {
            if (!isSharingOutgoing) setStatus(dom.outgoingStatus, 'send.ready');
            delete dom.pubStatus.dataset.i18n;
            dom.pubStatus.textContent = '';
        }
        syncOutgoingUi();
    });

    dom.joinRoomBtn.addEventListener('click', async () => {
        if (!hasBridge) return setStatus(dom.joinStatus, 'send.desktopOnly', 'err');
        const parsed = Links.parseLink(dom.joinLinkInput.value);
        if (!parsed) return setStatus(dom.joinStatus, 'join.badLink', 'err');
        if (parsed.kind !== 'room') return setStatus(dom.joinStatus, 'join.notRoom', 'err');
        const code = dom.joinCodeInput.value.trim().toUpperCase() || parsed.code;
        if (code !== parsed.code) return setStatus(dom.joinStatus, 'send.codeMismatch', 'err');
        const result = await api.openRoom({
            role: 'viewer',
            lang: I18n.lang,
            host: parsed.host,
            port: parsed.port,
            code,
            token: parsed.token,
            mode: parsed.mode,
            name: dom.joinNameInput.value
        });
        if (!result || !result.ok) return setStatus(dom.joinStatus, I18n.errorKey(result, 'room.joinFailed'), 'err');
        setStatus(dom.joinStatus, 'pub.opened', 'ok');
    });

    // ---------- incoming broadcasts ----------

    function closeIncomingPeer(studentId) {
        const entry = incoming.get(studentId);
        if (entry && entry.pc) {
            entry.pc.ontrack = null;
            entry.pc.onicecandidate = null;
            entry.pc.close();
        }
        incoming.delete(studentId);
    }

    function clearIncomingViewer(studentId = null) {
        if (!studentId) {
            for (const id of Array.from(incoming.keys())) closeIncomingPeer(id);
            tileVideos.forEach((video) => { video.srcObject = null; });
            if (isFullscreen) setFullscreenState(false);
            dom.remoteVideo.srcObject = null;
            incomingStudentId = null;
            isIncomingPaused = false;
            dom.freezeCanvas.classList.remove('active');
            closeFloatingWindow(false);
        } else {
            closeIncomingPeer(studentId);
            const tile = tileVideos.get(studentId);
            if (tile) tile.srcObject = null;
            if (incomingStudentId === studentId) {
                dom.remoteVideo.srcObject = null;
                incomingStudentId = null;
                isIncomingPaused = false;
                dom.freezeCanvas.classList.remove('active');
                closeFloatingWindow(false);
            }
        }
        updateViewerLayout();
        updateTeacherControlUi();
    }

    function setViewerStudent(studentId) {
        const entry = incoming.get(studentId);
        const stream = entry && entry.stream ? entry.stream : null;
        if (dom.remoteVideo.srcObject !== stream) {
            dom.remoteVideo.srcObject = stream;
            incomingStudentId = stream ? studentId : null;
            isIncomingPaused = false;
            dom.freezeCanvas.classList.remove('active');
            updateFloatingPlayer();
        }
        updateViewerLayout();
        updateTeacherControlUi();
    }

    function updateViewerLayout() {
        const shouldShow = Boolean(dom.remoteVideo.srcObject);
        document.body.classList.toggle('viewer-active', shouldShow);
        dom.videoPlaceholder.hidden = shouldShow;
        dom.receiverPauseBtn.textContent = isIncomingPaused ? '▶' : '⏸';
        if (shouldShow) I18n.setText(dom.viewerTitle, 'recv.current', { title: activeTitle() });
        else dom.viewerTitle.textContent = '';
    }

    function updateTeacherControlUi() {
        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        const hasView = Boolean(dom.remoteVideo.srcObject);
        const global = networkMode === 'global';
        dom.teacherControlsCard.hidden = !hasView;
        const canSend = hasView && !global && Boolean(selected && selected.controlEnabled) &&
            !isIncomingPaused && !selected?.isPaused;
        dom.remoteKeyButtons.forEach((button) => { button.disabled = !canSend; });
        let key = 'keys.waitingApproval';
        if (!hasView) key = 'keys.waitingView';
        else if (global) key = 'keys.global';
        else if (selected?.isPaused || isIncomingPaused) key = 'keys.paused';
        else if (selected && selected.controlEnabled) key = 'keys.allowed';
        I18n.setText(dom.teacherControlStatus, key);
    }

    function captureFrozenFrame(sourceVideo, canvas) {
        if (!sourceVideo || !canvas || !sourceVideo.videoWidth || !sourceVideo.videoHeight) return;
        canvas.width = sourceVideo.videoWidth;
        canvas.height = sourceVideo.videoHeight;
        canvas.getContext('2d').drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
    }

    function applyIncomingFreeze(paused, studentId) {
        if (studentId && studentId !== selectedStudentId) return;
        isIncomingPaused = Boolean(paused);
        const floatingCanvas = floatingWin && !floatingWin.closed
            ? floatingWin.document.getElementById('pipFreezeCanvas') : null;
        if (isIncomingPaused) {
            captureFrozenFrame(dom.remoteVideo, dom.freezeCanvas);
            dom.freezeCanvas.classList.add('active');
            if (floatingCanvas) {
                captureFrozenFrame(floatingWin.document.getElementById('pipVideo') || dom.remoteVideo, floatingCanvas);
                floatingCanvas.style.display = 'block';
            }
        } else {
            dom.freezeCanvas.classList.remove('active');
            if (floatingCanvas) floatingCanvas.style.display = 'none';
        }
        updateTeacherControlUi();
    }

    function createStudentCard(student) {
        const card = document.createElement('div');
        card.className = 'student-card';
        const preview = document.createElement('div');
        preview.className = 'tile-preview';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        const badge = document.createElement('span');
        badge.className = 'tile-badge';
        preview.append(video, badge);
        const info = document.createElement('div');
        info.className = 'tile-info';
        const title = document.createElement('div');
        title.className = 'tile-title';
        const status = document.createElement('div');
        status.className = 'tile-status';
        info.append(title, status);
        const actions = document.createElement('div');
        actions.className = 'card-actions';
        const selectBtn = document.createElement('button');
        selectBtn.className = 'select-btn';
        selectBtn.type = 'button';
        const stopBtn = document.createElement('button');
        stopBtn.className = 'stop-btn';
        stopBtn.type = 'button';
        actions.append(selectBtn, stopBtn);
        card.append(preview, info, actions);

        selectBtn.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected) return;
            inSocket.timeout(3000).emit('host:select', { studentId: student.id }, (error, response) => {
                if (error || !response || !response.ok) {
                    setStatus(dom.hostStatus, I18n.errorKey(response, 'card.openFailed'), 'err');
                }
            });
        });
        stopBtn.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected) return;
            inSocket.timeout(3000).emit('host:stop-student', { studentId: student.id }, (error, response) => {
                if (error || !response || !response.ok) {
                    setStatus(dom.hostStatus, I18n.errorKey(response, 'card.stopFailed'), 'err');
                }
            });
        });
        return { card, video, badge, title, status, selectBtn, stopBtn };
    }

    function renderStudentRoster(students) {
        const ids = new Set(students.map((student) => student.id));
        for (const [id, refs] of studentCards) {
            if (!ids.has(id)) {
                refs.card.remove();
                refs.video.srcObject = null;
                studentCards.delete(id);
                tileVideos.delete(id);
            }
        }
        students.forEach((student) => {
            let refs = studentCards.get(student.id);
            if (!refs) {
                refs = createStudentCard(student);
                studentCards.set(student.id, refs);
                tileVideos.set(student.id, refs.video);
            }
            const stream = (incoming.get(student.id) || {}).stream || null;
            if (refs.video.srcObject !== stream) refs.video.srcObject = stream;
            refs.badge.textContent = student.id;
            refs.title.textContent = student.title || t('card.device', { id: student.id });
            I18n.setText(refs.status, student.isPaused
                ? 'card.paused'
                : student.isSharing
                    ? (student.id === selectedStudentId ? 'card.selected' : 'card.available')
                    : 'card.connected');
            refs.card.classList.toggle('selected', student.id === selectedStudentId);
            refs.selectBtn.disabled = !student.isSharing || student.isPaused;
            I18n.setText(refs.selectBtn, student.id === selectedStudentId ? 'card.shown' : 'card.view');
            I18n.setText(refs.stopBtn, 'card.stop');
            if (!refs.card.isConnected) dom.studentRoster.appendChild(refs.card);
        });
        dom.emptyRoster.hidden = students.length > 0;
    }

    function updateHostTimer(expiresAt) {
        if (hostCountdownTimer) clearInterval(hostCountdownTimer);
        if (!expiresAt) {
            I18n.setText(dom.hostTimer, 'recv.noLimit');
            return;
        }
        const tick = () => {
            const remaining = expiresAt - Date.now();
            if (remaining <= 0) {
                dom.hostTimer.textContent = '00:00';
                clearInterval(hostCountdownTimer);
                return;
            }
            const total = Math.ceil(remaining / 1000);
            const minutes = Math.floor(total / 60).toString().padStart(2, '0');
            const seconds = (total % 60).toString().padStart(2, '0');
            dom.hostTimer.textContent = `${minutes}:${seconds}`;
        };
        tick();
        hostCountdownTimer = setInterval(tick, 1000);
    }

    function renderHostSession(session) {
        hostSession = session || null;
        if (!session) {
            networkMode = 'local';
            hostStudents = [];
            selectedStudentId = null;
            dom.generatedBox.hidden = true;
            dom.codeSettingsCard.hidden = false;
            if (hostCountdownTimer) clearInterval(hostCountdownTimer);
            clearIncomingViewer();
            renderStudentRoster([]);
            return;
        }
        networkMode = session.networkMode || 'local';
        hostStudents = session.students || [];
        selectedStudentId = session.selectedStudentId || null;
        dom.codeSettingsCard.hidden = true;
        dom.generatedBox.hidden = false;
        dom.generatedCode.textContent = session.code;
        dom.globalLinkText.textContent = session.globalUrl || '';
        I18n.setText(dom.generatedTitle, networkMode === 'global' ? 'recv.modeGlobal' : 'recv.modeLocal');
        const reachKey = `reach.${session.reachability || 'lan'}`;
        dom.reachNote.hidden = !t(reachKey);
        dom.reachNote.className = `reach-note ${session.reachability === 'internet' ? 'ok' : 'warn'}`;
        I18n.setText(dom.reachNote, reachKey);
        updateHostTimer(session.expiresAt);
        renderStudentRoster(hostStudents);

        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        if (selected && (selected.isPaused || selected.isSharing)) {
            setViewerStudent(selected.id);
            if (selected.isPaused) applyIncomingFreeze(true, selected.id);
            else if (isIncomingPaused) applyIncomingFreeze(false, selected.id);
            I18n.setText(dom.hostStateText, selected.isPaused ? 'recv.frozen' : 'recv.viewing');
        } else {
            if (incomingStudentId) setViewerStudent(null);
            I18n.setText(dom.hostStateText, hostStudents.length ? 'recv.pick' : 'recv.waiting');
        }
        updateViewerLayout();
        updateTeacherControlUi();
    }

    async function handleWebrtcOffer(studentId, offer) {
        const student = hostStudents.find((item) => item.id === studentId);
        if (!student || !student.isSharing || student.isPaused || !inSocket) return;
        closeIncomingPeer(studentId);
        const pc = new RTCPeerConnection({ iceServers: iceServersFor(networkMode === 'global') });
        const entry = { pc, pending: [], stream: null };
        incoming.set(studentId, entry);

        pc.ontrack = (event) => {
            if (incoming.get(studentId) !== entry || !event.streams || !event.streams[0]) return;
            if (networkMode === 'global') {
                // A small jitter buffer on internet links absorbs variation without stutter.
                pc.getReceivers().forEach((receiver) => {
                    try {
                        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 1500;
                    } catch (error) { /* not supported */ }
                });
            }
            entry.stream = event.streams[0];
            const tile = tileVideos.get(studentId);
            if (tile) tile.srcObject = entry.stream;
            if (studentId === selectedStudentId) setViewerStudent(studentId);
        };
        pc.onicecandidate = (event) => {
            if (event.candidate && incoming.get(studentId) === entry) {
                inSocket.emit('host:ice', { studentId, candidate: event.candidate });
            }
        };
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            if (incoming.get(studentId) !== entry) return;
            for (const candidate of entry.pending) await pc.addIceCandidate(new RTCIceCandidate(candidate));
            entry.pending = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (incoming.get(studentId) !== entry) return;
            inSocket.emit('host:answer', { studentId, answer });
        } catch (error) {
            console.error('incoming', error);
        }
    }

    async function handleWebrtcIce(studentId, candidate) {
        const entry = incoming.get(studentId);
        if (!entry) return;
        try {
            if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
            else entry.pending.push(candidate);
        } catch (error) {
            console.error('incoming ice', error);
        }
    }

    function attachHostHandlers(socket) {
        socket.on('connect', () => {
            socket.timeout(5000).emit('host:register', { secret: hostInfo && hostInfo.hostSecret }, (error, response) => {
                if (error || !response || !response.ok) {
                    dom.generateBtn.disabled = true;
                    return setStatus(dom.hostStatus, I18n.errorKey(response, 'recv.registerFailed'), 'err');
                }
                setStatus(dom.hostStatus, 'recv.ready', 'ok');
                dom.generateBtn.disabled = false;
            });
        });
        socket.on('disconnect', () => setStatus(dom.hostStatus, 'recv.reconnecting', 'err'));
        socket.on('connect_error', () => setStatus(dom.hostStatus, 'recv.serviceDown', 'err'));
        socket.on('session:state', renderHostSession);
        socket.on('session:ended', () => setStatus(dom.hostStatus, 'recv.ended'));
        socket.on('session:expired', () => setStatus(dom.hostStatus, 'recv.expired', 'err'));
        socket.on('session:expiring', () => setStatus(dom.hostStatus, 'recv.expiring', 'err'));
        socket.on('control:permission', ({ studentId, enabled }) => {
            const student = hostStudents.find((item) => item.id === studentId);
            if (student) student.controlEnabled = Boolean(enabled);
            updateTeacherControlUi();
        });
        socket.on('student:event', ({ studentId, type }) => {
            if (type === 'paused') applyIncomingFreeze(true, studentId);
            else if (type === 'resumed') applyIncomingFreeze(false, studentId);
            else if (type === 'stopped' || type === 'left') clearIncomingViewer(studentId);
        });
        socket.on('webrtc:offer', ({ studentId, offer }) => handleWebrtcOffer(studentId, offer).catch(console.error));
        socket.on('webrtc:ice', ({ studentId, candidate }) => handleWebrtcIce(studentId, candidate).catch(console.error));
    }

    dom.generateBtn.addEventListener('click', () => {
        if (!inSocket) return setStatus(dom.hostStatus, 'recv.serviceDown', 'err');
        dom.generateBtn.disabled = true;
        I18n.setText(dom.generateBtn, 'recv.generating');
        setStatus(dom.hostStatus, 'recv.generating');
        const mode = segmentedValue(dom.networkModeSelect) === 'global' ? 'global' : 'local';
        inSocket.timeout(15000).emit('host:create', {
            networkMode: mode,
            durationMinutes: Number(dom.durationSelect.value),
            protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
        }, (error, response) => {
            if (error || !response || !response.ok) {
                setStatus(dom.hostStatus, I18n.errorKey(response, 'recv.createFailed'), 'err');
            } else {
                setStatus(dom.hostStatus, 'recv.created', 'ok');
            }
            dom.generateBtn.disabled = !inSocket;
            I18n.setText(dom.generateBtn, 'recv.generate');
        });
    });

    dom.deleteCodeBtn.addEventListener('click', () => {
        if (!inSocket || !inSocket.connected) return setStatus(dom.hostStatus, 'recv.serviceDown', 'err');
        inSocket.emit('host:delete');
        clearIncomingViewer();
    });

    dom.receiverPauseBtn.addEventListener('click', () => {
        if (!inSocket || !inSocket.connected || !selectedStudentId) return;
        inSocket.timeout(3000).emit('host:pause-student', {
            studentId: selectedStudentId,
            paused: !isIncomingPaused
        }, (error, response) => {
            if (error || !response || !response.ok) {
                I18n.setText(dom.teacherControlStatus, I18n.errorKey(response, 'keys.sendFailed'));
            }
        });
    });

    dom.remoteKeyButtons.forEach((button) => {
        button.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected || !selectedStudentId) return;
            inSocket.timeout(3000).emit('host:key', {
                studentId: selectedStudentId,
                key: button.dataset.remoteKey
            }, (error, response) => {
                if (error || !response || !response.ok) {
                    I18n.setText(dom.teacherControlStatus, I18n.errorKey(response, 'keys.sendFailed'));
                }
            });
        });
    });

    // ---------- floating player / fullscreen ----------

    function closeFloatingWindow(restoreMain = true) {
        if (floatingWin && !floatingWin.closed) {
            const winRef = floatingWin;
            floatingWin = null;
            winRef.onbeforeunload = null;
            winRef.close();
        }
        if (restoreMain && dom.remoteVideo.srcObject) api.showWindow();
    }

    function updateFloatingPlayer() {
        if (!floatingWin || floatingWin.closed) return;
        try {
            const video = floatingWin.document.getElementById('pipVideo');
            const title = floatingWin.document.getElementById('pipTitle');
            if (video) video.srcObject = dom.remoteVideo.srcObject;
            if (title) title.textContent = activeTitle();
        } catch (error) {
            console.error('floating', error);
        }
    }

    function openFloatingWindow() {
        if (!dom.remoteVideo.srcObject) return;
        if (isFullscreen) setFullscreenState(false);
        if (floatingWin && !floatingWin.closed) {
            floatingWin.focus();
            return;
        }
        floatingWin = window.open('floating.html', 'FloatingPlayer');
        if (!floatingWin) return;
        floatingWin.addEventListener('load', () => {
            updateFloatingPlayer();
            if (isIncomingPaused) applyIncomingFreeze(true, selectedStudentId);
        }, { once: true });
        floatingWin.onbeforeunload = () => {
            floatingWin = null;
            if (dom.remoteVideo.srcObject) api.showWindow();
        };
    }

    api.onFloatingClosed(() => {
        floatingWin = null;
        if (dom.remoteVideo.srcObject) api.showWindow();
    });
    dom.floatBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openFloatingWindow();
    });

    function setFullscreenState(enable) {
        isFullscreen = Boolean(enable);
        api.setFullScreen(isFullscreen);
        dom.videoBox.classList.toggle('is-fullscreen', isFullscreen);
        dom.videoBox.classList.toggle('show-controls', isFullscreen);
        dom.expandIcon.style.display = isFullscreen ? 'none' : 'block';
        dom.compressIcon.style.display = isFullscreen ? 'block' : 'none';
        if (hideControlsTimer) clearTimeout(hideControlsTimer);
        if (isFullscreen) scheduleHideControls();
    }

    function scheduleHideControls() {
        if (hideControlsTimer) clearTimeout(hideControlsTimer);
        if (!isFullscreen) return;
        hideControlsTimer = setTimeout(() => dom.videoBox.classList.remove('show-controls'), 2200);
    }

    dom.videoBox.addEventListener('mousemove', () => {
        if (!isFullscreen) return;
        dom.videoBox.classList.add('show-controls');
        scheduleHideControls();
    });
    dom.fullscreenBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setFullscreenState(!isFullscreen);
    });
    dom.remoteVideo.addEventListener('dblclick', () => setFullscreenState(!isFullscreen));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isFullscreen) setFullscreenState(false);
    });
    window.addEventListener('message', (event) => {
        if (event.source === floatingWin && event.data && event.data.type === 'labshow:restore') {
            closeFloatingWindow(true);
        }
    });

    // ---------- boot ----------

    async function boot() {
        I18n.apply();
        setStatus(dom.outgoingStatus, 'send.ready');
        syncOutgoingUi();
        renderStudentRoster([]);
        updateViewerLayout();
        updateTeacherControlUi();
        if (!hasBridge) {
            dom.generateBtn.disabled = true;
            setStatus(dom.hostStatus, 'recv.desktopOnly', 'err');
            return;
        }
        try {
            hostInfo = await api.getHostInfo();
            if (!hostInfo || !hostInfo.port) throw new Error('no local port');
            inSocket = io(`http://127.0.0.1:${hostInfo.port}`, {
                timeout: 5000,
                reconnectionDelay: 500,
                reconnectionDelayMax: 2000
            });
            attachHostHandlers(inSocket);
        } catch (error) {
            console.error('boot', error);
            dom.generateBtn.disabled = true;
            setStatus(dom.hostStatus, 'recv.registerFailed', 'err');
        }
    }

    boot();
})();
