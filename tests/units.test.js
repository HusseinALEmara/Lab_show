const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fields = require('../src/session-fields');
const { isAllowedControlKey, CONTROL_KEYS } = require('../src/keyboard-controls');
const lifecycle = require('../src/app-lifecycle');
const protocol = require('../src/protocol');
const { createQualityController, MIN_BITRATE, MAX_BITRATE, INITIAL_BITRATE } = require('../src/adaptive-quality');
const { safeResolve, ROOT } = require('../tools/preview-server');

test('generated session codes are 12 characters from the unambiguous alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const code = fields.generateSessionCode();
        assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
        assert.equal(fields.isValidCode(code), true);
        seen.add(code);
    }
    assert.equal(seen.size, 500, 'no repeated codes in 500 draws');
});

test('code validation accepts the 12-character and the legacy 6-digit forms only', () => {
    assert.equal(fields.isValidCode(' abcdefghjklm '), true);
    assert.equal(fields.isValidCode('123456'), true);
    assert.equal(fields.isValidCode('12345'), false);
    assert.equal(fields.isValidCode('ABCDEFGHJK10'), false, '0 and 1 are not in the alphabet');
    assert.equal(fields.isValidCode(42), false);
});

test('titles are single-line, bounded, and fall back when empty', () => {
    assert.equal(fields.normalizeTitle('  a\n\tb\u0000c  ', 'x'), 'a b c');
    assert.equal(fields.normalizeTitle('', 'fallback'), 'fallback');
    assert.equal(fields.normalizeTitle(null, 'fallback'), 'fallback');
    assert.equal(fields.normalizeTitle('x'.repeat(200), '').length, fields.MAX_TITLE_LENGTH);
    assert.equal(fields.normalizeTitle('<img src=x onerror=alert(1)>', ''), '<img src=x onerror=alert(1)>',
        'kept as text; the interface shows it through textContent');
});

test('durations are capped at 8 hours and invalid ones mean "no limit"', () => {
    assert.equal(fields.normalizeDurationMinutes(180), 180);
    assert.equal(fields.normalizeDurationMinutes(10_000), fields.MAX_DURATION_MINUTES);
    assert.equal(fields.normalizeDurationMinutes(0), null);
    assert.equal(fields.normalizeDurationMinutes('abc'), null);
});

test('only the 12 navigation keys are allowed', () => {
    assert.equal(Object.keys(CONTROL_KEYS).length, 12);
    for (const key of ['ArrowUp', 'Enter', 'Space', 'Escape', 'Tab', 'PageDown', 'Home', 'End']) {
        assert.equal(isAllowedControlKey(key), true, key);
    }
    for (const key of ['a', 'Meta', 'Delete', 'F4', 'toString', '__proto__', 'constructor', null, 7]) {
        assert.equal(isAllowedControlKey(key), false, String(key));
    }
});

test('installer shutdown argument and window-close rule', () => {
    assert.equal(lifecycle.isInstallerShutdownRequest(['app.exe', '--quit-for-update']), true);
    assert.equal(lifecycle.isInstallerShutdownRequest(['app.exe']), false);
    assert.equal(lifecycle.isInstallerShutdownRequest(null), false);
    assert.equal(lifecycle.shouldQuitOnWindowClose(false), true);
    assert.equal(lifecycle.shouldQuitOnWindowClose(true), false);
});

test('protocol compatibility', () => {
    assert.equal(protocol.isCompatible(3, 3), true);
    assert.equal(protocol.isCompatible(2, 3), true);
    assert.equal(protocol.isCompatible(1, 3), false);
    assert.equal(protocol.isCompatible(undefined, 3), true, 'older clients without a version');
});

test('adaptive quality lowers the bitrate on loss and raises it on spare bandwidth, within bounds', () => {
    let clock = 0;
    const q = createQualityController({ now: () => clock });
    assert.equal(q.state.maxBitrate, INITIAL_BITRATE);
    let result;
    for (let i = 0; i < 40; i++) {
        clock += 1000;
        result = q.update({ lossRatio: 0.2, jitterMs: 100 });
    }
    assert.equal(result.maxBitrate, MIN_BITRATE);
    assert.equal(result.scaleResolutionDownBy, 2);
    for (let i = 0; i < 200; i++) {
        clock += 1000;
        result = q.update({ availableBitrate: 50_000_000 });
    }
    assert.equal(result.maxBitrate, MAX_BITRATE);
    assert.equal(result.scaleResolutionDownBy, 1);
});

test('adaptive quality never changes more than once per 3-second window', () => {
    let clock = 0;
    const q = createQualityController({ now: () => clock });
    let changes = 0;
    for (let i = 0; i < 10; i++) {
        clock += 500;
        if (q.update({ lossRatio: 0.5 }).changed) changes++;
    }
    assert.ok(changes <= 1, `changed ${changes} times in 5 seconds`);
});

test('preview server only serves files inside the project folder', () => {
    assert.equal(safeResolve('/renderer/index.html'), path.join(ROOT, 'renderer', 'index.html'));
    assert.equal(safeResolve('/../etc/passwd'), null);
    assert.equal(safeResolve('/../' + path.basename(ROOT) + '-secret/file'), null,
        'a sibling folder sharing the name prefix is outside');
});

test('the interface loads the files the installer ships', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
        const target = path.resolve(__dirname, '..', 'renderer', src);
        assert.ok(fs.existsSync(target), `${src} exists`);
    }
});
