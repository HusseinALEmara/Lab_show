(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const bridge = window.electronAPI;
    const hasBridge = Boolean(bridge && typeof bridge.getHostInfo === 'function');
    const api = bridge || {
        getHostInfo: async () => null,
        findHostByCode: async () => null,
        findGlobalHost: async () => ({ ok: false, message: 'المعاينة لا تدعم المطابقة العالمية.' }),
        setFullScreen() {},
        setWindowSizeMode() {},
        showWindow() {},
        setOutgoingState() {},
        setStudentControlEnabled() {},
        applyControlKey: async () => ({ ok: false, message: 'التحكم غير متاح خارج التطبيق.' }),
        onTrayStopBroadcast() {},
        onTrayTogglePause() {},
        onTrayToggleControl() {},
        onFloatingClosed() {}
    };

    const dom = {
        roleScreen: $('roleScreen'), liveStatusBar: $('liveStatusBar'), liveStatusText: $('liveStatusText'),
        studentScreen: $('studentScreen'), teacherScreen: $('teacherScreen'),
        studentStartBtn: $('studentStartBtn'), teacherStartBtn: $('teacherStartBtn'),
        backFromStudentBtn: $('backFromStudentBtn'), backFromTeacherBtn: $('backFromTeacherBtn'),
        codeCard: $('codeCard'), broadcastCard: $('broadcastCard'),
        codeInput: $('codeInput'), joinTitleInput: $('joinTitleInput'),
        studentConnectionMode: $('studentConnectionMode'),
        globalStudentFields: $('globalStudentFields'), globalUsernameInput: $('globalUsernameInput'),
        globalLinkInput: $('globalLinkInput'),
        approveCodeBtn: $('approveCodeBtn'), cancelCodeBtn: $('cancelCodeBtn'),
        outgoingStatus: $('outgoingStatus'), studentIdentity: $('studentIdentity'),
        broadcastStatusPill: $('broadcastStatusPill'),
        titleDisplayBtn: $('titleDisplayBtn'), titleDisplayText: $('titleDisplayText'),
        titleEditor: $('titleEditor'), broadcastTitleInput: $('broadcastTitleInput'),
        titleUpdateBtn: $('titleUpdateBtn'),
        pauseBroadcastBtn: $('pauseBroadcastBtn'), stopBroadcastBtn: $('stopBroadcastBtn'),
        studentControlToggle: $('studentControlToggle'), studentControlStatus: $('studentControlStatus'),
        tabCode: $('tabCode'), tabBroadcasts: $('tabBroadcasts'),
        codePage: $('codePage'), broadcastsPage: $('broadcastsPage'),
        codeSettingsCard: $('codeSettingsCard'),
        networkModeSelect: $('networkModeSelect'),
        globalTeacherFields: $('globalTeacherFields'), globalTeacherUsername: $('globalTeacherUsername'),
        durationSelect: $('durationSelect'),
        generateBtn: $('generateBtn'), hostStatus: $('hostStatus'),
        generatedBox: $('generatedBox'), generatedCode: $('generatedCode'), generatedTitle: $('generatedTitle'),
        copyCodeBtn: $('copyCodeBtn'), globalLinkBox: $('globalLinkBox'),
        globalLinkText: $('globalLinkText'), copyGlobalLinkBtn: $('copyGlobalLinkBtn'),
        globalTokenText: $('globalTokenText'),
        hostTimer: $('hostTimer'), hostStateText: $('hostStateText'),
        selfShareBtn: $('selfShareBtn'), selfShareStatus: $('selfShareStatus'), deleteCodeBtn: $('deleteCodeBtn'),
        rosterCard: $('rosterCard'), studentRoster: $('studentRoster'), emptyRoster: $('emptyRoster'),
        rosterViewBtn: $('rosterViewBtn'),
        teacherControlsCard: $('teacherControlsCard'), teacherControlStatus: $('teacherControlStatus'),
        remoteKeyButtons: Array.from(document.querySelectorAll('[data-remote-key]')),
        videoBox: $('videoBox'), remoteVideo: $('remoteVideo'), freezeCanvas: $('freezeCanvas'),
        videoPlaceholder: $('videoPlaceholder'), viewerTitle: $('viewerTitle'),
        receiverPauseBtn: $('receiverPauseBtn'), selfBroadcastBtn: $('selfBroadcastBtn'),
        floatBtn: $('floatBtn'), fullscreenBtn: $('fullscreenBtn'),
        expandIcon: $('expandIcon'), compressIcon: $('compressIcon')
    };

    let role = 'student';
    let hostInfo = null;
    let inSocket = null;
    let hostStudents = [];
    let selectedStudentId = null;
    let hostTitle = 'جلسة الأستاذ';
    let teacherPage = 'code';
    let networkMode = 'local';
    let hostCountdownTimer = null;
    let incomingStudentId = null;
    let isIncomingPaused = false;
    let floatingWin = null;
    let isFullscreen = false;
    let hideControlsTimer = null;

    let outSocket = null;
    let outStream = null;
    let outPC = null;
    let outPendingIce = [];
    let outQualityTimer = null;
    let outQualityController = null;
    let outgoingGlobal = false;
    let receiverFound = false;
    let outgoingRequestId = 0;
    let joinedStudentId = null;
    let isSharingOutgoing = false;
    let isPausedOutgoing = false;
    let outgoingBusy = false;
    let isStudentControlEnabled = false;
    let permissionPending = false;
    let permissionRequestId = 0;

    const incoming = new Map(); // studentId -> { pc, pending: [], stream }
    const tileVideos = new Map(); // studentId -> HTMLVideoElement
    const studentCards = new Map(); // studentId -> card elements

    function setStatus(element, message, type = '') {
        if (!element) return;
        element.textContent = message;
        element.className = `status-text ${type}`;
    }

    function segmentedValue(element) {
        const active = element && element.querySelector('button.active');
        return active ? active.dataset.mode : 'local';
    }

    function bindSegmented(element, onChange) {
        if (!element) return;
        element.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-mode]');
            if (!button) return;
            element.querySelectorAll('button[data-mode]').forEach((item) => {
                item.classList.toggle('active', item === button);
            });
            if (onChange) onChange(button.dataset.mode);
        });
    }

    function activeTitle() {
        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        return selected?.title || hostTitle || 'Lab show';
    }

    // ---------- roles ----------

    function openTeacherPage(page) {
        teacherPage = page === 'broadcasts' ? 'broadcasts' : 'code';
        dom.codePage.hidden = teacherPage !== 'code';
        dom.broadcastsPage.hidden = teacherPage !== 'broadcasts';
        dom.tabCode.classList.toggle('active', teacherPage === 'code');
        dom.tabBroadcasts.classList.toggle('active', teacherPage === 'broadcasts');
        dom.tabCode.setAttribute('aria-selected', String(teacherPage === 'code'));
        dom.tabBroadcasts.setAttribute('aria-selected', String(teacherPage === 'broadcasts'));
    }

    function setRole(mode) {
        role = mode === 'teacher' ? 'teacher' : 'student';
        dom.roleScreen.hidden = true;
        dom.studentScreen.hidden = role !== 'student';
        dom.teacherScreen.hidden = role !== 'teacher';
        if (role === 'teacher') openTeacherPage(hostStudents.length ? 'broadcasts' : 'code');
        updateViewerLayout();
        updateTeacherControlUi();
    }

    function openWorkspace(mode) {
        dom.roleScreen.hidden = true;
        setRole(mode);
    }

    function showRoleScreen() {
        dom.roleScreen.hidden = false;
        dom.studentScreen.hidden = true;
        dom.teacherScreen.hidden = true;
        document.body.classList.remove('viewer-active');
    }

    dom.studentStartBtn.addEventListener('click', () => openWorkspace('student'));
    dom.teacherStartBtn.addEventListener('click', () => openWorkspace('teacher'));
    dom.backFromStudentBtn.addEventListener('click', showRoleScreen);
    dom.backFromTeacherBtn.addEventListener('click', showRoleScreen);
    dom.rosterViewBtn.addEventListener('click', () => {
        const isGrid = dom.studentRoster.classList.toggle('grid-view');
        dom.rosterViewBtn.textContent = isGrid ? 'عرض قائمة' : 'عرض شبكي';
    });
    dom.tabCode.addEventListener('click', () => openTeacherPage('code'));
    dom.tabBroadcasts.addEventListener('click', () => openTeacherPage('broadcasts'));

    bindSegmented(dom.studentConnectionMode, (mode) => {
        dom.globalStudentFields.hidden = mode !== 'global';
    });
    bindSegmented(dom.networkModeSelect, (mode) => {
        dom.globalTeacherFields.hidden = mode !== 'global';
    });
    dom.titleDisplayBtn.addEventListener('click', () => {
        dom.titleEditor.hidden = !dom.titleEditor.hidden;
        if (!dom.titleEditor.hidden) dom.broadcastTitleInput.focus();
    });

    async function copyText(text, statusElement, successMessage) {
        try {
            await navigator.clipboard.writeText(text);
            if (statusElement) statusElement.textContent = successMessage;
        } catch (error) {
            if (statusElement) statusElement.textContent = 'تعذر النسخ؛ حدد النص ونسخه يدوياً.';
        }
    }

    dom.copyCodeBtn.addEventListener('click', () => copyText(
        dom.generatedCode.textContent, dom.hostStatus, 'تم نسخ الرمز.'
    ));
    dom.copyGlobalLinkBtn.addEventListener('click', () => copyText(
        dom.globalLinkText.textContent, dom.hostStatus, 'تم نسخ رابط الجلسة.'
    ));

    // ---------- outgoing sharing ----------

    function setOutgoingNotice(message, type = '') {
        setStatus(dom.outgoingStatus, message, type);
        if (dom.studentControlStatus) dom.studentControlStatus.textContent = message;
    }

    function setLiveStatus(message, active = true) {
        dom.liveStatusBar.hidden = !active;
        dom.liveStatusText.textContent = message;
    }

    function syncOutgoingUi(message) {
        dom.codeCard.hidden = isSharingOutgoing;
        dom.broadcastCard.hidden = !isSharingOutgoing;
        if (!isSharingOutgoing) {
            receiverFound = false;
            setLiveStatus('', false);
        }
        dom.titleDisplayText.textContent = dom.broadcastTitleInput.value || '—';
        dom.broadcastStatusPill.textContent = isPausedOutgoing ? 'متوقف مؤقتاً' : 'يبث الآن';
        dom.studentControlToggle.disabled = !isSharingOutgoing || isPausedOutgoing || permissionPending;
        dom.studentControlToggle.setAttribute('aria-checked', String(isStudentControlEnabled));
        dom.studentControlToggle.textContent = isStudentControlEnabled
            ? 'إيقاف السماح بالتحكم بشاشتي'
            : 'السماح بالتحكم بشاشتي';

        if (message) {
            dom.studentControlStatus.textContent = message;
        } else if (isStudentControlEnabled) {
            dom.studentControlStatus.textContent = 'السماح مفعّل. يمكنك إيقافه في أي وقت.';
        } else if (isPausedOutgoing) {
            dom.studentControlStatus.textContent = 'البث متوقف مؤقتاً؛ أعد استئنافه أولاً.';
        } else if (isSharingOutgoing) {
            dom.studentControlStatus.textContent = 'التحكم متوقف حتى تسمح به.';
        } else {
            dom.studentControlStatus.textContent = 'التحكم متوقف. فعّله بعد بدء البث.';
        }

        dom.approveCodeBtn.textContent = isSharingOutgoing ? 'إيقاف مشاركة الشاشة' : 'موافقة';
        dom.pauseBroadcastBtn.textContent = isPausedOutgoing ? 'استئناف البث' : 'إيقاف مؤقت';
        dom.pauseBroadcastBtn.disabled = !isSharingOutgoing;
        dom.stopBroadcastBtn.disabled = !isSharingOutgoing;
        dom.selfShareBtn.textContent = isSharingOutgoing ? 'إيقاف مشاركة شاشتي' : 'مشاركة شاشتي أيضاً';
        dom.approveCodeBtn.disabled = outgoingBusy;
        dom.selfShareBtn.disabled = outgoingBusy;
        api.setOutgoingState({
            sharing: isSharingOutgoing,
            paused: isPausedOutgoing
        });
    }

    function setLocalPermission(enabled, message) {
        isStudentControlEnabled = Boolean(enabled);
        if (!isStudentControlEnabled) {
            permissionRequestId += 1;
            permissionPending = false;
        }
        api.setStudentControlEnabled(isStudentControlEnabled);
        syncOutgoingUi(message);
    }

    function requestStudentControl(enabled) {
        if (!enabled) {
            if (outSocket && outSocket.connected) outSocket.emit('student:permission', { enabled: false });
            setLocalPermission(false, 'تم إيقاف السماح بالتحكم.');
            return;
        }
        if (isStudentControlEnabled || permissionPending) return;
        if (!isSharingOutgoing || isPausedOutgoing || !outSocket || !outSocket.connected) {
            syncOutgoingUi('ابدأ بث الشاشة أولاً قبل تفعيل التحكم.');
            return;
        }

        const requestId = ++permissionRequestId;
        permissionPending = true;
        syncOutgoingUi('جارٍ تفعيل السماح...');
        outSocket.timeout(3000).emit('student:permission', { enabled: true }, (error, response) => {
            if (requestId !== permissionRequestId) return;
            permissionPending = false;
            if (error || !response || !response.ok) {
                setLocalPermission(false,
                    (response && response.message) || 'تعذر تفعيل السماح؛ تحقق من اتصال الشبكة.');
                return;
            }
            setLocalPermission(true, 'السماح مفعّل. يمكنك إيقافه في أي وقت.');
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
        setOutgoingNotice(
            isPausedOutgoing ? 'البث متوقف مؤقتاً' : 'جاري بث شاشتك الآن',
            isPausedOutgoing ? '' : 'ok');
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
        const pc = new RTCPeerConnection({ iceServers: [] });
        outPC = pc;
        outStream.getTracks().forEach((track) => pc.addTrack(track, outStream));

        const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
        const qualityApi = window.AdaptiveQuality;
        if (sender && qualityApi && qualityApi.createQualityController) {
            outQualityController = qualityApi.createQualityController({
                mode: outgoingGlobal ? 'global' : 'local'
            });
            const applyQuality = async (result) => {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    params.encodings[0].maxBitrate = result.maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = result.scaleResolutionDownBy;
                    await sender.setParameters(params);
                } catch (error) {
                    console.error('تعذر تطبيق جودة البث:', error);
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
                    console.error('تعذر قراءة إحصاءات البث:', error);
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
            console.error('تعذر إنشاء عرض البث:', error);
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
        permissionPending = false;
        permissionRequestId += 1;
        setLocalPermission(false);
        syncOutgoingUi();
    }

    function attachOutgoingHandlers(socket, code, broadcastTitle, statusElement, globalIdentity = null) {
        socket.on('connect', () => {
            socket.timeout(5000).emit('student:join', {
                code,
                title: broadcastTitle,
                username: globalIdentity ? globalIdentity.username : undefined,
                token: globalIdentity ? globalIdentity.token : undefined,
                protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
            }, async (error, response) => {
                if (error || !response || !response.ok) {
                    stopOutgoingShare(false);
                    setStatus(statusElement,
                        (response && response.message) || 'تعذر الانضمام إلى جلسة الأستاذ.', 'err');
                    return;
                }
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
                    const finalTitle = (broadcastTitle || '').trim() || 'بثك';
                    dom.joinTitleInput.value = finalTitle;
                    dom.broadcastTitleInput.value = finalTitle;
                    dom.titleDisplayText.textContent = finalTitle;
                    dom.titleEditor.hidden = true;
                    dom.studentIdentity.textContent = `${finalTitle} · ${joinedStudentId}`;
                    socket.emit('student:start');
                    isSharingOutgoing = true;
                    isPausedOutgoing = false;
                    outgoingBusy = false;
                    syncOutgoingUi();
                    receiverFound = false;
                    setLiveStatus('البث يعمل الآن · بانتظار المستقبل');
                    showRoleScreen();
                    outStream.getVideoTracks().forEach((track) => {
                        track.addEventListener('ended', () => {
                            if (outSocket === socket && isSharingOutgoing) {
                                stopOutgoingShare(true);
                                setStatus(statusElement, 'تم إيقاف مشاركة الشاشة.');
                            }
                        }, { once: true });
                    });
                } catch (captureError) {
                    console.error('تعذر التقاط الشاشة:', captureError);
                    stopOutgoingShare(true);
                    setStatus(statusElement, 'تعذر التقاط الشاشة.', 'err');
                }
            });
        });

        socket.on('connect_error', () => {
            if (outSocket !== socket) return;
            stopOutgoingShare(false);
            setStatus(statusElement, 'تعذر الاتصال بجهاز الأستاذ داخل الشبكة.', 'err');
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
                for (const candidate of outPendingIce) {
                    await outPC.addIceCandidate(new RTCIceCandidate(candidate));
                }
                outPendingIce = [];
            } catch (error) {
                console.error('خطأ في إجابة البث:', error);
            }
        });

        socket.on('webrtc:ice', async ({ candidate }) => {
            try {
                if (outPC && outPC.remoteDescription) await outPC.addIceCandidate(new RTCIceCandidate(candidate));
                else outPendingIce.push(candidate);
            } catch (error) {
                console.error('خطأ في مرشح الشبكة:', error);
            }
        });

        socket.on('control:key', async ({ key }) => {
            if (!isStudentControlEnabled || !isSharingOutgoing || isPausedOutgoing) return;
            try {
                const result = await api.applyControlKey(key);
                if (!result.ok) syncOutgoingUi(result.message || 'تعذر تنفيذ مفتاح التحكم.');
            } catch (error) {
                console.error('فشل التحكم بالمفاتيح:', error);
                syncOutgoingUi('تعذر تنفيذ مفتاح التحكم على هذا الجهاز.');
            }
        });

        socket.on('student:selected', () => {
            receiverFound = true;
            setLiveStatus('البث يعمل الآن · تم العثور على المستقبل');
        });

        socket.on('session:expiring', () => {
            setLiveStatus('البث سينتهي خلال 5 دقائق');
            setOutgoingNotice('البث سينتهي خلال 5 دقائق.', 'err');
        });

        socket.on('control:permission', ({ enabled }) => {
            if (!enabled && isStudentControlEnabled) setLocalPermission(false, 'تم سحب السماح بالتحكم.');
        });

        socket.on('host:pause', ({ paused }) => {
            setOutgoingPaused(paused);
            setOutgoingNotice(paused
                ? 'أوقف المستقبل بثك مؤقتاً.'
                : 'استأنف المستقبل عرض بثك.', paused ? '' : 'ok');
        });

        socket.on('session:ended', ({ message }) => {
            stopOutgoingShare(false);
            setStatus(statusElement, message || 'تم إيقاف الجلسة.', 'err');
        });

        socket.on('host:stop', () => {
            stopOutgoingShare(true);
            setStatus(statusElement, 'تم إيقاف بثك من قِبل الأستاذ.', 'err');
        });

        socket.on('disconnect', () => {
            if (outSocket !== socket) return;
            if (isSharingOutgoing || outgoingBusy) {
                stopOutgoingShare(false);
                setStatus(statusElement, 'انقطع الاتصال بجهاز الأستاذ.', 'err');
            }
        });
    }

    async function beginOutgoingShare(code, title, target, statusElement) {
        if (!hasBridge) {
            setStatus(statusElement, 'شغّل تطبيق Lab show المكتبي؛ فتح الملف في المتصفح لا يدعم مشاركة الشاشة.', 'err');
            return;
        }
        let cleanCode = String(code || '').trim();
        if (!/^\d{6}$/.test(cleanCode)) {
            setStatus(statusElement, 'أدخل رمز الأستاذ المكوّن من ستة أرقام.', 'err');
            return;
        }
        if (outgoingBusy) return;

        outgoingBusy = true;
        syncOutgoingUi();
        let resolvedTarget = target;
        let globalIdentity = null;
        outgoingGlobal = segmentedValue(dom.studentConnectionMode) === 'global';
        if (!resolvedTarget && segmentedValue(dom.studentConnectionMode) === 'global') {
            const rawLink = dom.globalLinkInput.value.trim();
            if (!rawLink) {
                outgoingBusy = false;
                syncOutgoingUi();
                setStatus(statusElement, 'أدخل رابط الجلسة العالمية الذي أرسله الأستاذ.', 'err');
                return;
            }
            let parsedLink = null;
            try {
                parsedLink = new URL(rawLink);
            } catch (error) {
                console.error('رابط الجلسة غير صالح:', error);
            }
            const linkCode = parsedLink ? parsedLink.searchParams.get('c') || '' : '';
            const username = parsedLink ? parsedLink.searchParams.get('u') || '' : '';
            const endpoint = parsedLink ? parsedLink.searchParams.get('e') || '' : '';
            const token = parsedLink ? parsedLink.searchParams.get('t') || '' : '';
            const match = /^([^:]+):(\d{2,5})$/.exec(endpoint);
            if (!/^\d{6}$/.test(linkCode) || !username || !token || !match) {
                outgoingBusy = false;
                syncOutgoingUi();
                setStatus(statusElement, 'رابط الجلسة العالمية غير صالح.', 'err');
                return;
            }
            cleanCode = linkCode;
            dom.codeInput.value = linkCode;
            dom.globalUsernameInput.value = username;
            resolvedTarget = { ip: match[1], port: Number(match[2]) };
            globalIdentity = { username, token };
        }
        setStatus(statusElement,
            resolvedTarget ? 'جارٍ الاتصال بخادم البث...' : 'جارٍ البحث عن صاحب الرمز...');
        if (!resolvedTarget) {
            try {
                resolvedTarget = await api.findHostByCode(cleanCode);
            } catch (error) {
                console.error('فشل اكتشاف الأستاذ:', error);
            }
        }
        if (!resolvedTarget || !resolvedTarget.port) {
            outgoingBusy = false;
            syncOutgoingUi();
            setStatus(statusElement, 'لم يُعثر على رمز الأستاذ في الشبكة المحلية.', 'err');
            return;
        }

        stopOutgoingShare(true);
        outgoingBusy = true;
        syncOutgoingUi();
        outSocket = io(`http://${resolvedTarget.ip}:${resolvedTarget.port}`, {
            timeout: 5000,
            reconnectionDelay: 500,
            reconnectionDelayMax: 2000
        });
        attachOutgoingHandlers(
            outSocket, cleanCode, broadcastTitle || dom.joinTitleInput.value, statusElement, globalIdentity
        );
    }

    dom.approveCodeBtn.addEventListener('click', () => {
        if (isSharingOutgoing) {
            stopOutgoingShare(true);
            setOutgoingNotice('تم إيقاف مشاركة الشاشة.');
            return;
        }
        beginOutgoingShare(dom.codeInput.value, dom.joinTitleInput.value, null, dom.outgoingStatus);
    });

    dom.cancelCodeBtn.addEventListener('click', () => {
        if (isSharingOutgoing) stopOutgoingShare(true);
        dom.codeInput.value = '';
        setOutgoingNotice('أدخل رمز الأستاذ لبدء مشاركة شاشتك');
    });

    dom.codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') dom.approveCodeBtn.click();
        if (event.key === 'Escape') dom.cancelCodeBtn.click();
    });

    dom.titleUpdateBtn.addEventListener('click', () => {
        if (!outSocket || !outSocket.connected || !isSharingOutgoing) return;
        const title = dom.broadcastTitleInput.value;
        dom.titleUpdateBtn.disabled = true;
        outSocket.timeout(3000).emit('student:update-title', { title }, (error, response) => {
            dom.titleUpdateBtn.disabled = false;
            if (error || !response || !response.ok) {
                setOutgoingNotice((response && response.message) || 'تعذر تحديث عنوان البث.', 'err');
                return;
            }
            dom.broadcastTitleInput.value = response.title;
            dom.titleDisplayText.textContent = response.title;
            dom.titleEditor.hidden = true;
            setOutgoingNotice('تم تحديث عنوان البث لدى الأستاذ.', 'ok');
        });
    });

    dom.pauseBroadcastBtn.addEventListener('click', toggleOutgoingPause);
    dom.stopBroadcastBtn.addEventListener('click', () => {
        if (!isSharingOutgoing) return;
        stopOutgoingShare(true);
        setOutgoingNotice('تم إيقاف البث.');
    });

    api.onTrayTogglePause(toggleOutgoingPause);
    api.onTrayToggleControl(() => requestStudentControl(!isStudentControlEnabled));
    api.onTrayStopBroadcast(() => {
        if (isSharingOutgoing) stopOutgoingShare(true);
        dom.codeInput.value = '';
        setOutgoingNotice('تم إيقاف البث.');
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
        const shouldShow = role === 'teacher' && Boolean(dom.remoteVideo.srcObject);
        document.body.classList.toggle('viewer-active', shouldShow);
        dom.videoPlaceholder.hidden = shouldShow;
        dom.receiverPauseBtn.textContent = isIncomingPaused ? '▶' : '⏸';
        dom.viewerTitle.textContent = shouldShow ? `البث الحالي: ${activeTitle()}` : '';
    }

    function updateTeacherControlUi() {
        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        const hasView = role === 'teacher' && Boolean(dom.remoteVideo.srcObject);
        dom.teacherControlsCard.hidden = !hasView;
        const canSend = hasView && Boolean(selected && selected.controlEnabled) &&
            !isIncomingPaused && !selected?.isPaused;
        dom.remoteKeyButtons.forEach((button) => { button.disabled = !canSend; });

        if (!hasView) {
            dom.teacherControlStatus.textContent = 'بانتظار بث الشاشة';
        } else if (selected?.isPaused || isIncomingPaused) {
            dom.teacherControlStatus.textContent = 'البث متوقف مؤقتاً؛ التحكم متوقف';
        } else if (selected && selected.controlEnabled) {
            dom.teacherControlStatus.textContent = 'الطالب سمح بالتحكم';
        } else {
            dom.teacherControlStatus.textContent = 'بانتظار موافقة الطالب';
        }
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
        if (isIncomingPaused) {
            captureFrozenFrame(dom.remoteVideo, dom.freezeCanvas);
            dom.freezeCanvas.classList.add('active');
            if (floatingWin && !floatingWin.closed) {
                const video = floatingWin.document.getElementById('pipVideo');
                const canvas = floatingWin.document.getElementById('pipFreezeCanvas');
                captureFrozenFrame(video || dom.remoteVideo, canvas);
                if (canvas) canvas.style.display = 'block';
            }
        } else {
            dom.freezeCanvas.classList.remove('active');
            if (floatingWin && !floatingWin.closed) {
                const canvas = floatingWin.document.getElementById('pipFreezeCanvas');
                if (canvas) canvas.style.display = 'none';
            }
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
        stopBtn.textContent = 'إيقاف';
        actions.append(selectBtn, stopBtn);

        card.append(preview, info, actions);
        selectBtn.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected) return;
            inSocket.timeout(3000).emit('host:select', { studentId: student.id }, (error, response) => {
                if (error || !response || !response.ok) {
                    setStatus(dom.hostStatus,
                        (response && response.message) || 'تعذر فتح بث الطالب.', 'err');
                }
            });
        });
        stopBtn.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected) return;
            inSocket.timeout(3000).emit('host:stop-student', { studentId: student.id }, (error, response) => {
                if (error || !response || !response.ok) {
                    setStatus(dom.hostStatus,
                        (response && response.message) || 'تعذر إيقاف بث الطالب.', 'err');
                }
            });
        });

        return { card, video, badge, title, status, selectBtn };
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
            refs.video.srcObject = (incoming.get(student.id) || {}).stream || null;
            refs.badge.textContent = student.id;
            refs.title.textContent = student.title;
            refs.status.textContent = student.isPaused
                ? 'متوقف مؤقتاً'
                : student.isSharing
                    ? (student.id === selectedStudentId ? 'البث محدد للعرض' : 'البث متاح')
                    : 'متصل - بانتظار بدء المشاركة';
            refs.card.classList.toggle('selected', student.id === selectedStudentId);
            refs.selectBtn.disabled = !student.isSharing || student.isPaused;
            refs.selectBtn.textContent = student.id === selectedStudentId ? 'محدد' : 'عرض';
            if (!refs.card.isConnected) dom.studentRoster.appendChild(refs.card);
        });

        dom.emptyRoster.hidden = students.length > 0;
    }

    function updateHostTimer(expiresAt) {
        if (hostCountdownTimer) clearInterval(hostCountdownTimer);
        if (!expiresAt) {
            dom.hostTimer.textContent = 'بدون مدة';
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
        if (!session) {
            hostTitle = 'جلسة الأستاذ';
            networkMode = 'local';
            hostStudents = [];
            selectedStudentId = null;
            dom.rosterCard.hidden = true;
            dom.generatedBox.hidden = true;
            dom.codeSettingsCard.hidden = false;
            dom.generatedTitle.textContent = '';
            dom.globalLinkBox.hidden = true;
            dom.globalLinkText.textContent = '';
            if (hostCountdownTimer) clearInterval(hostCountdownTimer);
            clearIncomingViewer();
            renderStudentRoster([]);
            if (role === 'teacher') openTeacherPage('code');
            return;
        }

        hostTitle = session.title || 'جلسة الأستاذ';
        networkMode = session.networkMode || 'local';
        hostStudents = session.students || [];
        selectedStudentId = session.selectedStudentId || null;
        dom.rosterCard.hidden = false;
        dom.codeSettingsCard.hidden = true;
        dom.generatedBox.hidden = false;
        dom.generatedCode.textContent = session.code;
        dom.generatedTitle.textContent = networkMode === 'global'
            ? 'شبكة عالمية'
            : 'شبكة محلية';
        dom.globalLinkBox.hidden = !(networkMode === 'global' && session.globalUrl);
        if (dom.globalLinkBox.hidden) {
            dom.globalLinkText.textContent = '';
            dom.globalTokenText.textContent = '';
        } else {
            dom.globalLinkText.textContent = session.globalUrl;
            try {
                dom.globalTokenText.textContent =
                    new URL(session.globalUrl).searchParams.get('t') || '';
            } catch (error) {
                dom.globalTokenText.textContent = '';
            }
        }
        updateHostTimer(session.expiresAt);
        renderStudentRoster(hostStudents);
        if (role === 'teacher' && hostStudents.length && teacherPage === 'code') {
            openTeacherPage('broadcasts');
        }

        const selected = hostStudents.find((student) => student.id === selectedStudentId);
        if (selected && (selected.isPaused || selected.isSharing)) {
            setViewerStudent(selected.id);
            if (selected.isPaused) applyIncomingFreeze(true, selected.id);
            else if (isIncomingPaused) applyIncomingFreeze(false, selected.id);
            dom.hostStateText.textContent = selected.isPaused
                ? 'متوقف مؤقتاً (صورة مجمدة)'
                : 'يبث الآن';
        } else {
            if (incomingStudentId) setViewerStudent(null);
            dom.hostStateText.textContent = hostStudents.length
                ? 'متصلون - اختر طالباً'
                : 'بانتظار الطلاب';
        }
        updateViewerLayout();
        updateTeacherControlUi();
    }

    // ---------- WebRTC receiver ----------

    async function handleWebrtcOffer(studentId, offer) {
        const student = hostStudents.find((item) => item.id === studentId);
        if (!student || !student.isSharing || student.isPaused || !inSocket) return;
        closeIncomingPeer(studentId);
        const pc = new RTCPeerConnection({ iceServers: [] });
        const entry = { pc, pending: [], stream: null };
        incoming.set(studentId, entry);

        pc.ontrack = (event) => {
            if (incoming.get(studentId) !== entry || !event.streams || !event.streams[0]) return;
            if (networkMode === 'global') {
                // تأخير مخبّأ بسيط في الوضع العالمي فقط لامتصاص التذبذب، دون تقطيع البث.
                pc.getReceivers().forEach((receiver) => {
                    try {
                        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 1500;
                    } catch (error) {
                        /* الخاصية غير مدعومة في هذا المتصفح */
                    }
                });
            }
            entry.stream = event.streams[0];
            const tile = tileVideos.get(studentId);
            if (tile) tile.srcObject = entry.stream;
            if (studentId === selectedStudentId) setViewerStudent(studentId);
        };
        pc.onicecandidate = (event) => {
            if (event.candidate && incoming.get(studentId) === entry) {
                inSocket.emit('webrtc:ice', { studentId, candidate: event.candidate });
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
            console.error('خطأ في استقبال بث الطالب:', error);
        }
    }

    async function handleWebrtcIce(studentId, candidate) {
        const entry = incoming.get(studentId);
        if (!entry) return;
        try {
            if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
            else entry.pending.push(candidate);
        } catch (error) {
            console.error('خطأ في مرشح شبكة الطالب:', error);
        }
    }

    // ---------- host connection ----------

    function attachHostHandlers(socket) {
        socket.on('connect', () => {
            socket.emit('host:register');
            setStatus(dom.hostStatus, 'أنشئ رمزاً لاستقبال البث الحي', 'ok');
            dom.generateBtn.disabled = false;
            dom.generateBtn.textContent = 'توليد رمز';
        });
        socket.on('disconnect', () => {
            setStatus(dom.hostStatus, 'انقطع الاتصال بخدمة الاستقبال؛ جارٍ إعادة الاتصال.', 'err');
        });
        socket.on('connect_error', () => {
            setStatus(dom.hostStatus, 'تعذر الاتصال بخدمة الاستقبال على هذا الحاسوب.', 'err');
        });
        socket.on('session:state', renderHostSession);
        socket.on('session:ended', ({ message }) => {
            setStatus(dom.hostStatus, message || 'تم إنهاء الجلسة.');
        });
        socket.on('session:expired', () => {
            setStatus(dom.hostStatus, 'انتهت مدة صلاحية الرمز.', 'err');
        });
        socket.on('session:expiring', () => {
            setStatus(dom.hostStatus, 'تحذير: ستنتهي صلاحية الرمز خلال 5 دقائق.', 'err');
        });
        socket.on('control:permission', ({ studentId, enabled }) => {
            if (studentId !== selectedStudentId) return;
            const selected = hostStudents.find((student) => student.id === studentId);
            if (selected) selected.controlEnabled = Boolean(enabled);
            updateTeacherControlUi();
        });
        socket.on('student:event', ({ studentId, type }) => {
            if (type === 'paused') applyIncomingFreeze(true, studentId);
            else if (type === 'resumed') applyIncomingFreeze(false, studentId);
            else if (type === 'stopped' || type === 'left') clearIncomingViewer(studentId);
        });
        socket.on('webrtc:offer', ({ studentId, offer }) => {
            handleWebrtcOffer(studentId, offer).catch(console.error);
        });
        socket.on('webrtc:ice', ({ studentId, candidate }) => {
            handleWebrtcIce(studentId, candidate).catch(console.error);
        });
    }

    dom.generateBtn.addEventListener('click', () => {
        if (!inSocket) {
            setStatus(dom.hostStatus, 'تعذر الاتصال بخدمة الاستقبال على هذا الحاسوب.', 'err');
            return;
        }
        dom.generateBtn.disabled = true;
        dom.generateBtn.textContent = 'جارٍ التحقق وتوليد الرمز...';
        setStatus(dom.hostStatus, 'جارٍ التحقق من الرمز على الشبكة المحلية...');
        networkMode = segmentedValue(dom.networkModeSelect) === 'global' ? 'global' : 'local';
        inSocket.timeout(10000).emit('host:create', {
            networkMode,
            durationMinutes: Number(dom.durationSelect.value),
            username: networkMode === 'global' ? dom.globalTeacherUsername.value.trim() : undefined,
            protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
        }, (error, response) => {
            if (error || !response || !response.ok) {
                setStatus(dom.hostStatus,
                    (response && response.message) || 'تعذر توليد الرمز؛ تحقق من اتصال التطبيق.', 'err');
            } else {
                setStatus(dom.hostStatus, 'تم إنشاء الرمز؛ أدخله على حاسوب الطالب.', 'ok');
            }
            dom.generateBtn.disabled = !inSocket;
            dom.generateBtn.textContent = 'توليد رمز';
        });
    });

    dom.deleteCodeBtn.addEventListener('click', () => {
        if (!inSocket || !inSocket.connected) {
            setStatus(dom.hostStatus, 'انقطع الاتصال بخدمة الاستقبال.', 'err');
            return;
        }
        inSocket.emit('host:delete');
        clearIncomingViewer();
    });

    dom.selfShareBtn.addEventListener('click', () => {
        if (isSharingOutgoing) {
            stopOutgoingShare(true);
            setStatus(dom.selfShareStatus, 'تم إيقاف مشاركة شاشتي.');
            return;
        }
        if (!hostInfo) {
            setStatus(dom.selfShareStatus, 'خدمة الاستقبال غير جاهزة بعد.', 'err');
            return;
        }
        beginOutgoingShare(
            dom.generatedCode.textContent,
            'بث الأستاذ',
            { ip: '127.0.0.1', port: hostInfo.port },
            dom.selfShareStatus
        );
    });

    dom.selfBroadcastBtn.addEventListener('click', () => {
        if (role !== 'teacher') return;
        openTeacherPage('code');
        if (isSharingOutgoing) {
            stopOutgoingShare(true);
            setStatus(dom.selfShareStatus, 'تم إيقاف مشاركة شاشتي.');
            return;
        }
        outgoingGlobal = networkMode === 'global';
        dom.selfShareBtn.click();
    });

    dom.receiverPauseBtn.addEventListener('click', () => {
        if (!inSocket || !inSocket.connected || !selectedStudentId || role !== 'teacher') return;
        inSocket.timeout(3000).emit('host:pause-student', {
            studentId: selectedStudentId,
            paused: !isIncomingPaused
        }, (error, response) => {
            if (error || !response || !response.ok) {
                dom.teacherControlStatus.textContent =
                    (response && response.message) || 'تعذر تغيير حالة البث.';
            }
        });
    });

    dom.remoteKeyButtons.forEach((button) => {
        button.addEventListener('click', () => {
            if (!inSocket || !inSocket.connected || role !== 'teacher' || !selectedStudentId) return;
            inSocket.timeout(3000).emit('host:key', {
                studentId: selectedStudentId,
                key: button.dataset.remoteKey
            }, (error, response) => {
                if (error || !response || !response.ok) {
                    dom.teacherControlStatus.textContent =
                        (response && response.message) || 'تعذر إرسال المفتاح؛ تحقق من الاتصال.';
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
            console.error('تعذر تحديث المشغّل العائم:', error);
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
        updateFloatingPlayer();
        if (isIncomingPaused) {
            const canvas = floatingWin.document.getElementById('pipFreezeCanvas');
            captureFrozenFrame(dom.remoteVideo, canvas);
            if (canvas) canvas.style.display = 'block';
        }
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
        if (event.data && event.data.type === 'labshow:restore') closeFloatingWindow(true);
    });

    // ---------- boot ----------

    async function boot() {
        if (!hasBridge) {
            dom.generateBtn.disabled = true;
            setStatus(dom.hostStatus, 'افتح تطبيق Lab show المكتبي؛ لا تفتح ملف HTML مباشرة في المتصفح.', 'err');
            return;
        }
        try {
            hostInfo = await api.getHostInfo();
            if (!hostInfo || !hostInfo.port) throw new Error('لم يُرجع الخادم المحلي منفذاً.');
            inSocket = io(`http://127.0.0.1:${hostInfo.port}`, {
                timeout: 5000,
                reconnectionDelay: 500,
                reconnectionDelayMax: 2000
            });
            attachHostHandlers(inSocket);
        } catch (error) {
            console.error('تعذر بدء خدمة الاستقبال:', error);
            dom.generateBtn.disabled = true;
            setStatus(dom.hostStatus, 'تعذر بدء خدمة الاستقبال؛ أعد تشغيل التطبيق.', 'err');
        }
    }

    syncOutgoingUi();
    boot();
})();
