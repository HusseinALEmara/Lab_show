const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildLink, parseLink, connectTargets } = require('../src/links');
const { generateSessionCode } = require('../src/session-fields');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('links: what a device builds, another device parses back exactly', () => {
    const code = generateSessionCode();
    const token = generateSessionCode(12);
    for (const kind of ['send', 'room']) {
        for (const mode of ['local', 'global']) {
            const link = buildLink({ kind, mode, code, endpoint: '203.0.113.7:51234', token });
            const parsed = parseLink(link);
            assert.deepEqual(parsed, {
                kind, mode, code, host: '203.0.113.7', port: 51234, webUrl: 'http://203.0.113.7:51234', token, username: ''
            }, `${kind}/${mode}`);
        }
    }
    assert.ok(buildLink({ code, endpoint: '1.2.3.4:5000' }).startsWith('http://1.2.3.4:5000/j?'),
        'without a tunnel the link is the device\'s own public address');
});

test('links: with a tunnel the link is the device\'s https address, and the direct one is tried first', () => {
    const code = generateSessionCode();
    const token = generateSessionCode(12);
    const link = buildLink({
        kind: 'send', mode: 'global', code, endpoint: '203.0.113.7:51234', token,
        webUrl: 'https://brave-blue-river.trycloudflare.com/'
    });
    assert.ok(link.startsWith('https://brave-blue-river.trycloudflare.com/j?'), link);
    const parsed = parseLink(link);
    assert.equal(parsed.webUrl, 'https://brave-blue-river.trycloudflare.com');
    assert.deepEqual(connectTargets(parsed), ['http://203.0.113.7:51234', 'https://brave-blue-river.trycloudflare.com']);
    // A tunnel-only link (no direct address) still works.
    const tunnelOnly = parseLink(`https://live.university.edu/j?k=r&m=g&c=${code}&t=${token}`);
    assert.deepEqual(connectTargets(tunnelOnly), ['https://live.university.edu']);
    assert.equal(parseLink(`https://live.university.edu/other?c=${code}&t=${token}`), null, 'only /j links');
    assert.equal(parseLink(`ftp://x/j?c=${code}&e=1.2.3.4:5000`), null);
});

test('links: older global links (no kind or mode, with a token) still work', () => {
    const parsed = parseLink('https://labshow.link/j?c=ABCDEFGHJKLM&u=teacher_1&e=192.168.1.4:5000&t=ABCDEFGHJKLM');
    assert.equal(parsed.kind, 'send');
    assert.equal(parsed.mode, 'global');
    assert.equal(parsed.username, 'teacher_1');
});

test('links: malformed or incomplete links are refused', () => {
    const code = 'ABCDEFGHJKLM';
    const bad = [
        '',
        'not a url',
        `https://labshow.link/j?c=${code}`,
        `https://labshow.link/j?c=bad&e=1.2.3.4:5000`,
        `https://labshow.link/j?c=${code}&e=1.2.3.4:99999`,
        `https://labshow.link/j?c=${code}&e=evil.com/x:5000`,
        `https://labshow.link/j?k=r&c=${code}&e=1.2.3.4:5000`,
        `https://labshow.link/j?m=g&c=${code}&e=1.2.3.4:5000`,
        `https://labshow.link/j?c=${code}&e=1.2.3.4:5000&t=short`
    ];
    for (const link of bad) assert.equal(parseLink(link), null, link);
    assert.ok(parseLink(`https://labshow.link/j?c=${code}&e=10.0.0.2:5000`), 'a local send link needs no token');
});

function loadI18n() {
    const storage = new Map();
    const context = {
        window: {},
        localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
        location: { search: '' },
        URLSearchParams,
        document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
        JSON
    };
    vm.runInNewContext(read('renderer/i18n.js'), context);
    return context.window.LabShowI18n;
}

test('i18n: Arabic and English have the same keys, and no text is empty by mistake', () => {
    const { dictionaries } = loadI18n();
    const arKeys = Object.keys(dictionaries.ar).sort();
    const enKeys = Object.keys(dictionaries.en).sort();
    assert.deepEqual(arKeys, enKeys);
    for (const key of arKeys) {
        if (key === 'reach.lan') continue;
        assert.ok(dictionaries.ar[key].trim(), `ar ${key}`);
        assert.ok(dictionaries.en[key].trim(), `en ${key}`);
    }
});

test('i18n: every key used by the pages and scripts exists', () => {
    const { dictionaries } = loadI18n();
    const used = new Set();
    for (const file of ['renderer/index.html', 'renderer/room.html']) {
        for (const [, key] of read(file).matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) used.add(key);
    }
    const keyLiteral = /'((?:send|control|recv|reach|card|keys|key|video|pub|join|room|err|net|dur|lang|app|settings|theme)\.[\w.-]+)'/g;
    for (const file of ['renderer/app.js', 'renderer/room.js', 'renderer/settings.js']) {
        for (const [, key] of read(file).matchAll(keyLiteral)) used.add(key);
    }
    for (const key of used) assert.ok(key in dictionaries.ar, `missing key ${key}`);
    assert.ok(used.size > 100, `checked ${used.size} keys`);
});

test('i18n: every server error has a translation in both languages', () => {
    const { MESSAGES } = require('../src/server');
    const { dictionaries } = loadI18n();
    for (const key of Object.keys(MESSAGES)) {
        assert.ok(dictionaries.ar[`err.${key}`], `ar err.${key}`);
        assert.ok(dictionaries.en[`err.${key}`], `en err.${key}`);
    }
});

test('the interface no longer names roles: no teacher or student wording is shown', () => {
    const { dictionaries } = loadI18n();
    const shown = [...Object.values(dictionaries.ar), ...Object.values(dictionaries.en)].join('\n');
    for (const word of ['أستاذ', 'الأستاذ', 'طالب', 'الطالب', 'طلاب', 'teacher', 'Teacher', 'student', 'Student']) {
        assert.ok(!shown.includes(word), `"${word}" appears in the interface text`);
    }
    for (const file of ['renderer/index.html', 'renderer/room.html']) {
        const visible = read(file).replace(/<[^>]+>/g, ' ');
        for (const word of ['أستاذ', 'طالب', 'teacher', 'student']) {
            assert.ok(!visible.includes(word), `"${word}" in ${file}`);
        }
    }
});

test('the receive pane and the send pane are both on the main screen', () => {
    const html = read('renderer/index.html');
    assert.match(html, /class="pane send-pane"/);
    assert.match(html, /class="pane receive-pane"/);
    assert.doesNotMatch(html, /roleScreen/, 'no role-choice screen any more');
});
