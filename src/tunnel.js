const { spawn } = require('node:child_process');

// A public https address for this device, without opening any port: cloudflared makes an
// OUTBOUND connection to Cloudflare (port 443, allowed by almost every organization's
// firewall) and Cloudflare forwards requests for the public address back through it.
//
//  - quick tunnel (default, free, no account): a fresh https://<words>.trycloudflare.com
//    address each time the app starts it.
//  - named tunnel (when the institution provides a domain): a fixed address such as
//    https://live.example.edu, set in .env (LABSHOW_TUNNEL_TOKEN, LABSHOW_PUBLIC_URL).
//
// The device stays the server of its own sessions; Cloudflare only carries the bytes.
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

function createTunnel({
    binary,
    localPort,
    token = '',
    publicUrl = '',
    startTimeoutMs = 45000,
    cwd = undefined,
    spawnFn = spawn
}) {
    const named = Boolean(token && publicUrl);
    let child = null;
    let url = null;
    let stopping = false;
    let starting = null;

    function args() {
        return named
            ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
            : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
    }

    function start() {
        if (url) return Promise.resolve(url);
        if (starting) return starting;
        stopping = false;
        starting = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                starting = null;
                if (error) {
                    stop();
                    reject(error);
                } else {
                    url = value;
                    resolve(value);
                }
            };
            const timer = setTimeout(() => finish(new Error('tunnel did not start in time')), startTimeoutMs);
            try {
                child = spawnFn(binary, args(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd });
            } catch (error) {
                finish(error);
                return;
            }
            const onOutput = (chunk) => {
                const text = chunk.toString();
                if (!named) {
                    const match = QUICK_URL.exec(text);
                    if (match) finish(null, match[0]);
                } else if (REGISTERED.test(text)) {
                    finish(null, publicUrl.replace(/\/+$/, ''));
                }
            };
            child.stdout.on('data', onOutput);
            child.stderr.on('data', onOutput);
            child.on('error', (error) => finish(error));
            child.on('exit', (code) => {
                child = null;
                url = null;
                if (!settled) finish(new Error(`cloudflared exited (${code})`));
            });
        });
        return starting;
    }

    function stop() {
        stopping = true;
        url = null;
        if (child) {
            try { child.kill(); } catch { /* already gone */ }
            child = null;
        }
    }

    return {
        start,
        stop,
        get url() { return url; },
        get named() { return named; },
        get stopping() { return stopping; }
    };
}

// Reads KEY=VALUE lines (the .env format: # comments, optional quotes).
function parseEnv(text) {
    const values = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (/^[A-Z][A-Z0-9_]*$/.test(key)) values[key] = value;
    }
    return values;
}

module.exports = { createTunnel, parseEnv, QUICK_URL };
