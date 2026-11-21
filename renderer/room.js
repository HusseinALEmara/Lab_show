// Public broadcast window. The owner streams its screen to every viewer over a direct
// WebRTC connection (this device is the server of its own broadcast). Voices: each
// viewer sends its microphone to the owner; the owner sends every viewer one audio
// track mixed from the owner's microphone and all other viewers' microphones (a
// "mix-minus": everyone hears everyone except themselves).
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const I18n = window.LabShowI18n;
    const { t } = I18n;
    const api = window.electronAPI;
    const params = new URLSearchParams(location.search);
    const role = params.get('role') === 'owner' ? 'owner' : 'viewer';
    const mode = params.get('mode') === 'global' ? 'global' : 'local';
    const OWNER_ID = 'owner';

    const dom = Object.fromEntries([
        'roomTitle', 'roomMeta', 'livePill', 'langToggle', 'stageVideo', 'waitingNote', 'mixAudio',
        'shareCard', 'roomCode', 'copyRoomCode', 'roomLink', 'copyRoomLink', 'roomReach',
        'commentList', 'noComments', 'commentForm', 'commentInput', 'micBtn', 'notifBtn', 'endBtn',
        'roomStatus', 'participantsHeading', 'participantList'
    ].map((id) => [id, $(id)]));

    let hostInfo = null;
    let socket = null;
    let myId = role === 'owner' ? OWNER_ID : null;
    let participants = [];
    let micStream = null;
    let micOn = false;
    let notificationsBlocked = false;
    let ended = false;

    // owner state
    let screenStream = null;
    let audioCtx = null;
    let ownerMicGain = null;
    const peers = new Map(); // viewerId -> { pc, dest, source, sink, pending }

    // viewer state
    let viewerPc = null;
    let viewerPending = [];

    function setStatus(key, type = '') {
        I18n.setText(dom.roomStatus, key);
        dom.roomStatus.className = `status-text ${type}`;
    }

    function iceServers() {
        return mode === 'global' && hostInfo && Array.isArray(hostInfo.iceServers) ? hostInfo.iceServers : [];
    }

    // ---------- shared rendering ----------

    function renderParticipants(list) {
        participants = Array.isArray(list) ? list : participants;
        I18n.setText(dom.participantsHeading, 'room.participants', { n: participants.length });
        dom.participantList.replaceChildren(...participants.map((p) => {
            const item = document.createElement('li');
            item.className = 'participant';
            const mic = document.createElement('span');
            mic.className = `mic-dot ${p.micOn ? 'on' : ''}`;
            mic.textContent = p.micOn ? '🎙' : '·';
            const name = document.createElement('span');
            name.className = 'participant-name';
            name.textContent = p.name;
            item.append(mic, name);
            if (p.isOwner) {
                const tag = document.createElement('small');
                tag.className = 'participant-tag';
                tag.textContent = t('room.owner');
                item.append(tag);
            }
            if (p.id === myId) {
                const you = document.createElement('small');
                you.className = 'participant-tag';
                you.textContent = t('room.you');
                item.append(you);
            }
            if (role === 'owner' && !p.isOwner) {
                const kick = document.createElement('button');
                kick.type = 'button';
                kick.className = 'btn-ghost small';
                kick.textContent = t('room.kick');
                kick.addEventListener('click', () => socket.emit('room:kick', { viewerId: p.id }));
                item.append(kick);
            }
            return item;
        }));
    }

    function appendComment(comment) {
        const item = document.createElement('div');
        item.className = `comment ${comment.isOwner ? 'owner' : ''}`;
        const head = document.createElement('div');
        head.className = 'comment-head';
        const name = document.createElement('strong');
        name.textContent = comment.name;
        const time = document.createElement('small');
        time.textContent = new Date(comment.at).toLocaleTimeString(I18n.lang === 'ar' ? 'ar' : 'en', {
            hour: '2-digit', minute: '2-digit'
        });
        head.append(name, time);
        const text = document.createElement('p');
        text.textContent = comment.text;
        item.append(head, text);
        dom.commentList.append(item);
        dom.noComments.hidden = true;
        dom.commentList.scrollTop = dom.commentList.scrollHeight;
    }

    function renderComments(list) {
        dom.commentList.replaceChildren();
        (list || []).forEach(appendComment);
        dom.noComments.hidden = Boolean(list && list.length);
    }

    function updateMicButton() {
        I18n.setText(dom.micBtn, micOn ? 'room.micOff' : 'room.micOn');
        dom.micBtn.classList.toggle('active', micOn);
    }

    function updateNotifButton() {
        I18n.setText(dom.notifBtn, notificationsBlocked ? 'room.notifOn' : 'room.notifOff');
    }

    function setLive(on) {
        dom.livePill.hidden = !on;
        dom.waitingNote.hidden = on;
    }

    dom.langToggle.addEventListener('click', () => I18n.toggle());
    I18n.onChange(() => {
        renderParticipants();
        updateMicButton();
        updateNotifButton();
    });
    dom.copyRoomCode.addEventListener('click', () => navigator.clipboard.writeText(dom.roomCode.textContent)
        .then(() => setStatus('recv.copied', 'ok'), () => setStatus('recv.copyFailed', 'err')));
    dom.copyRoomLink.addEventListener('click', () => navigator.clipboard.writeText(dom.roomLink.textContent)
        .then(() => setStatus('recv.copied', 'ok'), () => setStatus('recv.copyFailed', 'err')));

    dom.commentForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = dom.commentInput.value;
        if (!text.trim() || !socket) return;
        socket.timeout(3000).emit('room:comment', { text }, (error, response) => {
            if (error || !response || !response.ok) {
                return setStatus(I18n.errorKey(response, 'room.disconnected'), 'err');
            }
            dom.commentInput.value = '';
        });
    });
    dom.commentInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            dom.commentForm.requestSubmit();
        }
    });

    // ---------- microphone ----------

    async function openMic() {
        if (micStream) return micStream;
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });
        return micStream;
    }

    async function setMic(on) {
        try {
            if (on) {
                const stream = await openMic();
                const track = stream.getAudioTracks()[0];
                track.enabled = true;
                if (role === 'owner') {
                    if (!ownerMicGain.__source) {
                        ownerMicGain.__source = audioCtx.createMediaStreamSource(stream);
                        ownerMicGain.__source.connect(ownerMicGain);
                    }
                    ownerMicGain.gain.value = 1;
                } else if (viewerPc) {
                    const sender = viewerAudioSender();
                    if (sender) await sender.replaceTrack(track);
                }
            } else if (micStream) {
                if (role === 'owner') ownerMicGain.gain.value = 0;
                else {
                    const sender = viewerAudioSender();
                    if (sender) await sender.replaceTrack(null);
                }
                micStream.getAudioTracks().forEach((track) => { track.enabled = false; });
            }
            micOn = Boolean(on);
            socket.emit('room:mic', { on: micOn });
        } catch (error) {
            console.error('mic', error);
            micOn = false;
            setStatus('room.micDenied', 'err');
        }
        updateMicButton();
    }

    dom.micBtn.addEventListener('click', () => setMic(!micOn));

    // ---------- owner ----------

    function connectVoice(source, dest) {
        try { source.connect(dest); } catch (error) { /* already connected */ }
    }

    async function ownerAddViewer(viewerId) {
        ownerRemoveViewer(viewerId);
        const pc = new RTCPeerConnection({ iceServers: iceServers() });
        const dest = audioCtx.createMediaStreamDestination();
        ownerMicGain.connect(dest);
        for (const other of peers.values()) if (other.source) connectVoice(other.source, dest);
        const peer = { pc, dest, source: null, sink: null, pending: [] };
        peers.set(viewerId, peer);

        const outStream = new MediaStream([screenStream.getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
        outStream.getTracks().forEach((track) => pc.addTrack(track, outStream));

        pc.ontrack = (event) => {
            if (event.track.kind !== 'audio' || peers.get(viewerId) !== peer) return;
            const stream = event.streams[0] || new MediaStream([event.track]);
            // Chromium only feeds a remote WebRTC stream into Web Audio while a media
            // element also plays it; a muted element is enough.
            peer.sink = new Audio();
            peer.sink.muted = true;
            peer.sink.srcObject = stream;
            peer.source = audioCtx.createMediaStreamSource(stream);
            peer.source.connect(audioCtx.destination); // the owner hears this viewer
            for (const [otherId, other] of peers) {
                if (otherId !== viewerId) connectVoice(peer.source, other.dest); // and so does everyone else
            }
        };
        pc.onicecandidate = (event) => {
            if (event.candidate) socket.emit('room:signal', { to: viewerId, data: { candidate: event.candidate } });
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') applyOwnerBitrates();
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('room:signal', { to: viewerId, data: { sdp: pc.localDescription } });
    }

    function ownerRemoveViewer(viewerId) {
        const peer = peers.get(viewerId);
        if (!peer) return;
        peers.delete(viewerId);
        try { peer.pc.close(); } catch { /* closed */ }
        if (peer.source) try { peer.source.disconnect(); } catch { /* done */ }
        if (peer.sink) peer.sink.srcObject = null;
        try { ownerMicGain.disconnect(peer.dest); } catch { /* done */ }
        applyOwnerBitrates();
    }

    // The owner's upload is shared by every viewer: split a budget between them.
    function applyOwnerBitrates() {
        const each = Math.max(300000, Math.min(3000000, Math.floor(12000000 / Math.max(1, peers.size))));
        for (const { pc } of peers.values()) {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (!sender) continue;
            const p = sender.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = each;
            sender.setParameters(p).catch(() => {});
        }
    }

    async function ownerSignal(from, data) {
        const peer = peers.get(from);
        if (!peer) return;
        try {
            if (data.sdp) {
                await peer.pc.setRemoteDescription(data.sdp);
                for (const candidate of peer.pending) await peer.pc.addIceCandidate(candidate);
                peer.pending = [];
            } else if (data.candidate) {
                if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
                else peer.pending.push(data.candidate);
            }
        } catch (error) {
            console.error('owner signal', error);
        }
    }

    function renderOwnerRoom(room) {
        if (!room) return;
        dom.shareCard.hidden = false;
        dom.roomTitle.textContent = room.title;
        dom.roomCode.textContent = room.code;
        dom.roomLink.textContent = room.link;
        const reachKey = `reach.${room.reachability || 'lan'}`;
        dom.roomReach.hidden = !t(reachKey);
        dom.roomReach.className = `reach-note ${room.reachability === 'internet' ? 'ok' : 'warn'}`;
        I18n.setText(dom.roomReach, reachKey);
        I18n.setText(dom.roomMeta, mode === 'global' ? 'recv.modeGlobal' : 'recv.modeLocal');
        renderParticipants(room.participants);
        renderComments(room.comments);
    }

    async function endAsOwner() {
        if (ended) return;
        ended = true;
        if (socket) socket.emit('room:end');
        for (const id of Array.from(peers.keys())) ownerRemoveViewer(id);
        if (screenStream) screenStream.getTracks().forEach((track) => track.stop());
        if (micStream) micStream.getTracks().forEach((track) => track.stop());
        if (notificationsBlocked) await api.setNotificationsSuppressed(false);
        setTimeout(() => window.close(), 150);
    }

    async function startOwner() {
        I18n.setText(dom.endBtn, 'room.end');
        dom.notifBtn.hidden = false;
        updateNotifButton();
        setStatus('room.creating');
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
                audio: false
            });
        } catch (error) {
            setStatus('room.captureFailed', 'err');
            return;
        }
        dom.stageVideo.srcObject = screenStream;
        setLive(true);
        screenStream.getVideoTracks()[0].addEventListener('ended', () => endAsOwner(), { once: true });

        audioCtx = new AudioContext();
        ownerMicGain = audioCtx.createGain();
        ownerMicGain.gain.value = 0;
        audioCtx.resume().catch(() => {});

        let created = false;
        socket = io(`http://127.0.0.1:${hostInfo.port}`, { timeout: 5000, reconnectionDelay: 500 });
        socket.on('connect', () => {
            socket.timeout(5000).emit('room:owner', { secret: hostInfo.hostSecret }, (error, response) => {
                if (error || !response || !response.ok) return setStatus(I18n.errorKey(response, 'room.joinFailed'), 'err');
                if (created) return;
                created = true;
                socket.timeout(15000).emit('room:create', {
                    title: params.get('title'),
                    networkMode: mode,
                    durationMinutes: Number(params.get('duration')) || 180,
                    ownerName: params.get('name')
                }, (createError, reply) => {
                    if (createError || !reply || !reply.ok) {
                        return setStatus(I18n.errorKey(reply, 'room.joinFailed'), 'err');
                    }
                    renderOwnerRoom(reply.room);
                    setStatus('room.share', 'ok');
                });
            });
        });
        socket.on('room:state', (room) => {
            if (room) renderOwnerRoom(room);
            else if (created && !ended) {
                setStatus('room.ended', 'err');
                setLive(false);
            }
        });
        socket.on('room:participants', renderParticipants);
        socket.on('room:comment', appendComment);
        socket.on('room:viewer-joined', ({ viewerId }) => ownerAddViewer(viewerId).catch(console.error));
        socket.on('room:viewer-left', ({ viewerId }) => ownerRemoveViewer(viewerId));
        socket.on('room:signal', ({ from, data }) => ownerSignal(from, data || {}));
        socket.on('disconnect', () => setStatus('room.disconnected', 'err'));
    }

    dom.notifBtn.addEventListener('click', async () => {
        const next = !notificationsBlocked;
        const result = await api.setNotificationsSuppressed(next);
        if (!result || !result.ok) {
            setStatus(result && result.error === 'unsupported' ? 'room.notifUnsupported' : 'room.notifFailed', 'err');
            return;
        }
        notificationsBlocked = next;
        updateNotifButton();
        setStatus(next ? 'room.notifActive' : 'room.notifRestored', 'ok');
    });

    // ---------- viewer ----------

    function viewerAudioSender() {
        if (!viewerPc) return null;
        const transceiver = viewerPc.getTransceivers().find((tr) => tr.receiver.track && tr.receiver.track.kind === 'audio');
        return transceiver ? transceiver.sender : null;
    }

    async function viewerSignal(data) {
        try {
            if (data.sdp && data.sdp.type === 'offer') {
                if (viewerPc) viewerPc.close();
                viewerPc = new RTCPeerConnection({ iceServers: iceServers() });
                viewerPending = [];
                viewerPc.ontrack = (event) => {
                    const stream = event.streams[0] || new MediaStream([event.track]);
                    if (event.track.kind === 'video') {
                        dom.stageVideo.srcObject = stream;
                        setLive(true);
                        setStatus('room.live', 'ok');
                    } else {
                        dom.mixAudio.srcObject = new MediaStream([event.track]);
                        dom.mixAudio.play().catch(() => {});
                    }
                };
                viewerPc.onicecandidate = (event) => {
                    if (event.candidate) socket.emit('room:signal', { data: { candidate: event.candidate } });
                };
                viewerPc.onconnectionstatechange = () => {
                    if (viewerPc && viewerPc.connectionState === 'failed') setStatus('room.connectFailed', 'err');
                };
                await viewerPc.setRemoteDescription(data.sdp);
                // Answer the audio line as send-and-receive so the microphone can be
                // switched on later with replaceTrack, without a new negotiation.
                viewerPc.getTransceivers().forEach((tr) => {
                    if (tr.receiver.track && tr.receiver.track.kind === 'audio') tr.direction = 'sendrecv';
                });
                if (micOn && micStream) {
                    const sender = viewerAudioSender();
                    if (sender) await sender.replaceTrack(micStream.getAudioTracks()[0]);
                }
                for (const candidate of viewerPending) await viewerPc.addIceCandidate(candidate);
                viewerPending = [];
                const answer = await viewerPc.createAnswer();
                await viewerPc.setLocalDescription(answer);
                socket.emit('room:signal', { data: { sdp: viewerPc.localDescription } });
            } else if (data.candidate) {
                if (viewerPc && viewerPc.remoteDescription) await viewerPc.addIceCandidate(data.candidate);
                else viewerPending.push(data.candidate);
            }
        } catch (error) {
            console.error('viewer signal', error);
        }
    }

    function leaveAsViewer() {
        if (ended) return;
        ended = true;
        if (socket) socket.emit('room:leave');
        if (viewerPc) viewerPc.close();
        if (micStream) micStream.getTracks().forEach((track) => track.stop());
        setTimeout(() => window.close(), 150);
    }

    function startViewer() {
        I18n.setText(dom.endBtn, 'room.leave');
        setStatus('room.connecting');
        const host = params.get('host');
        const port = Number(params.get('port'));
        socket = io(`http://${host}:${port}`, { timeout: 6000, reconnection: false });
        socket.on('connect', () => {
            socket.timeout(6000).emit('room:join', {
                code: params.get('code'),
                token: params.get('token'),
                name: params.get('name'),
                protocolVersion: window.LabShowProtocol ? window.LabShowProtocol.PROTOCOL_VERSION : undefined
            }, (error, response) => {
                if (error || !response || !response.ok) {
                    return setStatus(I18n.errorKey(response, 'room.joinFailed'), 'err');
                }
                myId = response.viewerId;
                dom.roomTitle.textContent = response.room.title;
                I18n.setText(dom.roomMeta, response.room.networkMode === 'global' ? 'recv.modeGlobal' : 'recv.modeLocal');
                renderParticipants(response.room.participants);
                renderComments(response.room.comments);
                setStatus('room.waiting');
            });
        });
        socket.on('connect_error', () => setStatus('room.connectFailed', 'err'));
        socket.on('room:participants', renderParticipants);
        socket.on('room:comment', appendComment);
        socket.on('room:signal', ({ data }) => viewerSignal(data || {}));
        socket.on('room:ended', ({ reason } = {}) => {
            ended = true;
            if (viewerPc) viewerPc.close();
            viewerPc = null;
            dom.stageVideo.srcObject = null;
            setLive(false);
            setStatus(reason === 'removed' ? 'room.removed' : reason === 'owner-left' ? 'room.ownerLeft' : 'room.ended', 'err');
        });
        socket.on('disconnect', () => {
            if (!ended) setStatus('room.disconnected', 'err');
        });
    }

    dom.endBtn.addEventListener('click', () => (role === 'owner' ? endAsOwner() : leaveAsViewer()));
    window.addEventListener('beforeunload', () => {
        if (role === 'owner' && notificationsBlocked) api.setNotificationsSuppressed(false);
    });

    // A read-only view of the connections, used by the end-to-end tests.
    window.labshowRoomDebug = {
        role,
        get viewerId() { return myId; },
        peerConnections: () => (role === 'owner' ? Array.from(peers.values(), (p) => p.pc) : [viewerPc].filter(Boolean))
    };

    async function boot() {
        I18n.apply();
        updateMicButton();
        renderParticipants([]);
        dom.noComments.hidden = false;
        setLive(false);
        if (!api) return setStatus('recv.desktopOnly', 'err');
        hostInfo = await api.getHostInfo();
        if (!hostInfo) return setStatus('recv.registerFailed', 'err');
        if (role === 'owner') startOwner();
        else startViewer();
    }

    boot();
})();
