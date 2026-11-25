// Media over WebSocket, for networks with no direct WebRTC path (UDP blocked, as in
// many organizations). Video: VP8 through WebCodecs, key frames every 2 s or on request,
// frames skipped while the connection is backed up. Audio: Opus, 20 ms frames.
// Decoded video is drawn on a canvas whose captureStream() is an ordinary MediaStream,
// so the rest of the interface (tiles, viewer, floating player) works unchanged.
(function () {
    'use strict';

    const VIDEO_CODEC = 'vp8';
    const KEY_INTERVAL_MS = 2000;

    function evenSize(width, height, maxWidth) {
        const scale = Math.min(1, maxWidth / width);
        return {
            width: Math.max(2, Math.round((width * scale) / 2) * 2),
            height: Math.max(2, Math.round((height * scale) / 2) * 2)
        };
    }

    // send(meta, arrayBuffer); isBacklogged() -> true while the socket still has a queue.
    function createVideoSender({ track, send, isBacklogged = () => false, maxWidth = 1280, fps = 15, bitrate = 1500000 }) {
        const processor = new MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader();
        let encoder = null;
        let size = null;
        let canvas = null;
        let ctx = null;
        let stopped = false;
        let paused = false;
        let lastKey = 0;
        let wantKey = true;
        let lastFrameAt = 0;
        let skipping = false;

        function configure(width, height) {
            size = evenSize(width, height, maxWidth);
            canvas = new OffscreenCanvas(size.width, size.height);
            ctx = canvas.getContext('2d');
            encoder = new VideoEncoder({
                output: (chunk) => {
                    const data = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(data);
                    send({ type: chunk.type, ts: chunk.timestamp, codec: VIDEO_CODEC }, data);
                },
                error: (error) => console.error('video encoder', error)
            });
            encoder.configure({
                codec: VIDEO_CODEC, width: size.width, height: size.height,
                bitrate, framerate: fps, latencyMode: 'realtime'
            });
        }

        async function pump() {
            while (!stopped) {
                const { value: frame, done } = await reader.read();
                if (done) break;
                try {
                    const now = performance.now();
                    if (paused || now - lastFrameAt < 1000 / fps) continue;
                    if (isBacklogged()) {
                        // Do not pile up delay: wait, then restart from a key frame.
                        skipping = true;
                        continue;
                    }
                    if (skipping) {
                        skipping = false;
                        wantKey = true;
                    }
                    lastFrameAt = now;
                    if (!encoder) configure(frame.displayWidth, frame.displayHeight);
                    if (encoder.encodeQueueSize > 2) continue;
                    ctx.drawImage(frame, 0, 0, size.width, size.height);
                    const scaled = new VideoFrame(canvas, { timestamp: frame.timestamp });
                    const keyFrame = wantKey || now - lastKey >= KEY_INTERVAL_MS;
                    if (keyFrame) {
                        lastKey = now;
                        wantKey = false;
                    }
                    encoder.encode(scaled, { keyFrame });
                    scaled.close();
                } finally {
                    frame.close();
                }
            }
        }
        pump().catch((error) => console.error('video sender', error));

        return {
            requestKeyframe() { wantKey = true; },
            setPaused(value) { paused = Boolean(value); if (!paused) wantKey = true; },
            stop() {
                stopped = true;
                reader.cancel().catch(() => {});
                if (encoder && encoder.state !== 'closed') encoder.close();
            }
        };
    }

    // push(meta, data); onNeedKeyframe() is called when decoding must restart.
    function createVideoReceiver({ onNeedKeyframe = () => {} } = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        let decoder = null;
        let waitingForKey = true;

        function reset() {
            if (decoder && decoder.state !== 'closed') decoder.close();
            decoder = new VideoDecoder({
                output: (frame) => {
                    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                        canvas.width = frame.displayWidth;
                        canvas.height = frame.displayHeight;
                    }
                    ctx.drawImage(frame, 0, 0);
                    frame.close();
                },
                error: () => {
                    waitingForKey = true;
                    reset();
                    onNeedKeyframe();
                }
            });
            decoder.configure({ codec: VIDEO_CODEC, optimizeForLatency: true });
        }
        reset();
        onNeedKeyframe();

        return {
            stream,
            push(meta, data) {
                if (!decoder || decoder.state === 'closed') return;
                if (waitingForKey && meta.type !== 'key') return;
                waitingForKey = false;
                try {
                    decoder.decode(new EncodedVideoChunk({ type: meta.type, timestamp: meta.ts, data }));
                } catch (error) {
                    waitingForKey = true;
                    onNeedKeyframe();
                }
            },
            stop() {
                if (decoder && decoder.state !== 'closed') decoder.close();
                stream.getTracks().forEach((t) => t.stop());
            }
        };
    }

    function createAudioSender({ track, send, isBacklogged = () => false }) {
        const processor = new MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader();
        let stopped = false;
        let encoder = null;

        async function pump() {
            while (!stopped) {
                const { value: data, done } = await reader.read();
                if (done) break;
                try {
                    if (!encoder) {
                        encoder = new AudioEncoder({
                            output: (chunk) => {
                                const buffer = new ArrayBuffer(chunk.byteLength);
                                chunk.copyTo(buffer);
                                send({ type: 'audio', ts: chunk.timestamp, sr: data.sampleRate, ch: data.numberOfChannels }, buffer);
                            },
                            error: (error) => console.error('audio encoder', error)
                        });
                        encoder.configure({ codec: 'opus', sampleRate: data.sampleRate, numberOfChannels: data.numberOfChannels, bitrate: 32000 });
                    }
                    if (!isBacklogged()) encoder.encode(data);
                } finally {
                    data.close();
                }
            }
        }
        pump().catch((error) => console.error('audio sender', error));

        return {
            stop() {
                stopped = true;
                reader.cancel().catch(() => {});
                if (encoder && encoder.state !== 'closed') encoder.close();
            }
        };
    }

    // Plays received Opus into `output` (a GainNode of the given AudioContext) with a
    // small jitter buffer.
    function createAudioReceiver({ ctx }) {
        const output = ctx.createGain();
        let playhead = 0;
        const decoder = new AudioDecoder({
            output: (audio) => {
                const buffer = ctx.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
                for (let channel = 0; channel < audio.numberOfChannels; channel++) {
                    const plane = new Float32Array(audio.numberOfFrames);
                    audio.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
                    buffer.copyToChannel(plane, channel);
                }
                audio.close();
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(output);
                const now = ctx.currentTime;
                if (playhead < now + 0.04 || playhead > now + 0.5) playhead = now + 0.08;
                source.start(playhead);
                playhead += buffer.duration;
            },
            error: (error) => console.error('audio decoder', error)
        });
        let configured = false;
        return {
            output,
            push(meta, data) {
                if (decoder.state === 'closed') return;
                if (!configured) {
                    decoder.configure({ codec: 'opus', sampleRate: meta.sr || 48000, numberOfChannels: meta.ch || 1 });
                    configured = true;
                }
                try {
                    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: meta.ts, data }));
                } catch (error) { /* skip a bad packet */ }
            },
            stop() {
                if (decoder.state !== 'closed') decoder.close();
                try { output.disconnect(); } catch { /* done */ }
            }
        };
    }

    // True while the socket.io client still has unsent packets queued.
    function backlogOf(socket, limit = 20) {
        return () => {
            const engine = socket && socket.io && socket.io.engine;
            return Boolean(engine && engine.writeBuffer && engine.writeBuffer.length > limit);
        };
    }

    window.LabShowWsMedia = { createVideoSender, createVideoReceiver, createAudioSender, createAudioReceiver, backlogOf };
}());
