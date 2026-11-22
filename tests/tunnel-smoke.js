// Real-internet check, run on GitHub's servers by the release workflow (this needs
// outbound access to Cloudflare): a device's server gets a free quick tunnel, and a
// client reaches it through the public https address - the landing page of a session
// link, and a Socket.IO session with binary media chunks, exactly as the app does.
// Usage: node tests/tunnel-smoke.js <path-to-cloudflared>
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createLocalHostNode } = require('../src/server');
const { createTunnel } = require('../src/tunnel');
const { parseLink, connectTargets } = require('../src/links');

async function main() {
    const binary = process.argv[2] || 'cloudflared';
    let tunnel = null;
    const node = createLocalHostNode({
        turn: false,
        resolveWebUrl: async (port) => {
            tunnel = createTunnel({ binary, localPort: port, startTimeoutMs: 90000 });
            return tunnel.start();
        }
    });
    const info = await node.start();
    const host = io(`http://127.0.0.1:${info.port}`, { transports: ['websocket'] });
    await new Promise((resolve) => host.once('connect', resolve));
    await host.timeout(5000).emitWithAck('host:register', { secret: info.hostSecret });
    const created = await host.timeout(120000).emitWithAck('host:create', { networkMode: 'global', durationMinutes: 20 });
    assert.equal(created.ok, true, created.message);
    const link = created.session.globalUrl;
    console.log('link:', link);
    assert.match(link, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/j\?/);
    assert.equal(created.session.reachability, 'tunnel');

    // DNS for a fresh quick-tunnel name can take a few seconds to spread.
    let page = null;
    for (let i = 0; i < 30 && !page; i++) {
        try {
            const response = await fetch(link);
            if (response.ok) page = await response.text();
        } catch (error) { /* not yet */ }
        if (!page) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.ok(page && page.includes('Lab show') && page.includes(created.session.code), 'the link opens the device\'s page');
    console.log('landing page reached through the public address');

    const parsed = parseLink(link);
    const web = connectTargets(parsed).find((url) => url.startsWith('https://'));
    const sender = io(web, { timeout: 20000 });
    await new Promise((resolve, reject) => {
        sender.once('connect', resolve);
        sender.once('connect_error', reject);
    });
    const joined = await sender.timeout(20000).emitWithAck('student:join', {
        code: parsed.code, title: 'over the tunnel', token: parsed.token, protocolVersion: 4
    });
    assert.equal(joined.ok, true, joined.message);
    sender.emit('student:start');
    sender.emit('student:transport', { mode: 'ws' });
    const chunk = Buffer.alloc(200 * 1024, 7); // a key-frame-sized chunk
    const received = new Promise((resolve) => host.once('media:video', (meta, data) => resolve({ meta, size: data.byteLength })));
    sender.emit('student:media', { type: 'key', ts: 1, codec: 'vp8' }, chunk);
    const got = await received;
    assert.equal(got.size, chunk.length);
    assert.equal(got.meta.type, 'key');
    console.log(`media chunk of ${got.size} bytes passed through the tunnel`);

    sender.close();
    host.close();
    tunnel.stop();
    await node.stop();
    console.log('tunnel smoke test passed');
}

main().then(() => process.exit(0)).catch((error) => {
    console.error('tunnel smoke test FAILED:', error.message);
    process.exit(1);
});
