// قرارات الجودة تُحسب من متوسط 3 ثوانٍ، وتُغيَّر تدريجياً لتجنب التقطيع.
const WINDOW_MS = 3000;
const MIN_BITRATE = 400000;
const MAX_BITRATE = 6000000;
const INITIAL_BITRATE = 3000000;
const HIGH_LOSS = 0.04;
const HIGH_JITTER_MS = 45;

function createQualityController({
    mode = 'local',
    now = Date.now,
    initialBitrate = INITIAL_BITRATE
} = {}) {
    let bitrate = initialBitrate;
    let scale = 1;
    let lastChange = -Infinity;
    let samples = [];

    function update({ availableBitrate = null, lossRatio = 0, jitterMs = 0 } = {}) {
        const current = now();
        samples.push({ time: current, availableBitrate, lossRatio, jitterMs });
        samples = samples.filter((s) => current - s.time <= WINDOW_MS + 1000);
        if (samples.length < 2 || current - samples[0].time < WINDOW_MS || current - lastChange < WINDOW_MS) {
            return { maxBitrate: bitrate, scaleResolutionDownBy: scale, changed: false };
        }

        const avgAvailable = samples.reduce((sum, s) => sum + (s.availableBitrate || 0), 0) / samples.length;
        const avgLoss = samples.reduce((sum, s) => sum + s.lossRatio, 0) / samples.length;
        const avgJitter = samples.reduce((sum, s) => sum + s.jitterMs, 0) / samples.length;
        const global = mode === 'global';

        let next = bitrate;
        let nextScale = scale;
        const unstable = avgLoss > HIGH_LOSS || avgJitter > HIGH_JITTER_MS;

        if (unstable) {
            next = Math.max(MIN_BITRATE, Math.floor(bitrate * (global ? 0.7 : 0.8)));
            if (next < INITIAL_BITRATE * 0.5 && scale < 2) nextScale = Math.min(2, scale + 0.5);
        } else if (avgAvailable > 0 && avgAvailable > bitrate * 1.3) {
            next = Math.min(MAX_BITRATE, Math.floor(bitrate * 1.12));
            if (nextScale > 1 && avgAvailable > bitrate * 1.6) {
                nextScale = Math.max(1, nextScale - 0.5);
            }
        }

        if (next === bitrate && nextScale === scale) {
            return { maxBitrate: bitrate, scaleResolutionDownBy: scale, changed: false };
        }
        bitrate = next;
        scale = nextScale;
        lastChange = current;
        return { maxBitrate: bitrate, scaleResolutionDownBy: scale, changed: true };
    }

    return { update, get state() { return { maxBitrate: bitrate, scaleResolutionDownBy: scale }; } };
}

const qualityApi = {
    createQualityController,
    WINDOW_MS, MIN_BITRATE, MAX_BITRATE, INITIAL_BITRATE
};

if (typeof module !== 'undefined' && module.exports) module.exports = qualityApi;
else if (typeof window !== 'undefined') window.AdaptiveQuality = qualityApi;
