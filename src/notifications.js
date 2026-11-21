const { execFile } = require('node:child_process');

// Hides pop-up notifications (toasts) on this computer while it broadcasts, so they
// do not appear in the shared screen, and restores the user's own setting afterwards.
//
// Windows offers no public API for an app to turn on "Do not disturb". This uses the
// per-user switch behind Settings > System > Notifications ("Get notifications from
// apps and other senders"): HKCU\...\PushNotifications\ToastEnabled (1 on, 0 off).
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
const VALUE = 'ToastEnabled';

function defaultRunner(args) {
    return new Promise((resolve, reject) => {
        execFile('reg', args, { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

function createNotificationGuard({ platform = process.platform, run = defaultRunner } = {}) {
    let saved = null; // the user's value before suppression: 0, 1, or 'absent'

    async function readValue() {
        try {
            const output = await run(['query', KEY, '/v', VALUE]);
            const match = /ToastEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
            return match ? parseInt(match[1], 16) : 'absent';
        } catch (error) {
            return 'absent';
        }
    }

    function writeValue(value) {
        return run(['add', KEY, '/v', VALUE, '/t', 'REG_DWORD', '/d', String(value), '/f']);
    }

    async function suppress() {
        if (platform !== 'win32') return { ok: false, error: 'unsupported' };
        if (saved !== null) return { ok: true, active: true };
        saved = await readValue();
        try {
            await writeValue(0);
            return { ok: true, active: true };
        } catch (error) {
            saved = null;
            return { ok: false, error: 'failed' };
        }
    }

    async function restore() {
        if (platform !== 'win32' || saved === null) return { ok: true, active: false };
        const previous = saved;
        saved = null;
        try {
            if (previous === 'absent') await run(['delete', KEY, '/v', VALUE, '/f']);
            else await writeValue(previous);
            return { ok: true, active: false };
        } catch (error) {
            return { ok: false, error: 'failed' };
        }
    }

    return { suppress, restore, get active() { return saved !== null; } };
}

module.exports = { createNotificationGuard, KEY, VALUE };
