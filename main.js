const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');
const { io: connectToRelay } = require('socket.io-client');
const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    ipcMain,
    session,
    desktopCapturer,
    nativeImage,
    screen
} = require('electron');

const { utilityProcess } = require('electron');
const crypto = require('node:crypto');
const { createNotificationGuard } = require('./src/notifications');
const { parseEnv } = require('./src/tunnel');
const { chooseDataRoot, dataPaths, migrateFrom } = require('./src/app-storage');
const fs = require('node:fs');

// Everything the installed app writes stays inside its own folder ("data" next to the
// program): settings, .env, browser caches, logs, crash reports, temporary files and the
// back end's work folder. Nothing else is installed on the system; uninstalling removes
// it all, and updates keep it (build/installer.nsh).
const DEFAULT_USER_DATA = app.getPath('userData');
const DATA_ROOT = chooseDataRoot({ isPackaged: app.isPackaged, execPath: process.execPath });
if (DATA_ROOT) {
    const paths = dataPaths(DATA_ROOT);
    for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', paths.userData);
    app.setPath('sessionData', paths.sessionData);
    app.setPath('temp', paths.temp);
    app.setPath('crashDumps', paths.crashDumps);
    app.setAppLogsPath(paths.logs);
    migrateFrom(DEFAULT_USER_DATA, paths.userData);
}
const WORK_DIR = path.join(app.getPath('userData'), 'work');
fs.mkdirSync(WORK_DIR, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = app.getPath('temp');

// Optional institution settings (.env): a fixed public domain through a Cloudflare named
// tunnel, its own TURN server, its own STUN servers, a fixed local port. Looked for
// next to the installed program, then in the user's app-data folder, then the source
// folder. Values already in the environment win. See .env.example.
(function loadEnvFile() {
    const candidates = [
        path.join(path.dirname(process.execPath), '.env'),
        path.join(app.getPath('userData'), '.env'),
        path.join(__dirname, '.env')
    ];
    for (const file of candidates) {
        try {
            const values = parseEnv(fs.readFileSync(file, 'utf8'));
            for (const [key, value] of Object.entries(values)) {
                if (key.startsWith('LABSHOW_') && process.env[key] === undefined) process.env[key] = value;
            }
            return;
        } catch (error) { /* not there: try the next place */ }
    }
}());
const { isAllowedControlKey, pressControlKey } = require('./src/keyboard-controls');
const {
    isInstallerShutdownRequest,
    shouldQuitOnWindowClose
} = require('./src/app-lifecycle');

let mainWindow = null;
let tray = null;
let floatingWindow = null;
let hostInfo = { port: 0, ips: [] };
let isQuitting = false;
let outgoingState = { sharing: false, paused: false, controlEnabled: false };
let roomOwnerWindow = null;
const roomWindows = new Set();
const notificationGuard = createNotificationGuard();

// Public STUN servers only tell each device its own internet address so the two can
// connect directly; the picture never passes through them. LABSHOW_STUN_URLS
// (comma-separated) replaces them, e.g. for a private network.
const STUN_URLS = String(process.env.LABSHOW_STUN_URLS ||
    'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((url) => url.trim()).filter(Boolean);

// An institution's own TURN server (for example on port 443 over TLS), handed to the
// devices that join this device's global sessions, in addition to this device's relay.
const INSTITUTION_TURN = process.env.LABSHOW_TURN_URLS ? [{
    urls: process.env.LABSHOW_TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean),
    username: process.env.LABSHOW_TURN_USERNAME || '',
    credential: process.env.LABSHOW_TURN_CREDENTIAL || ''
}] : [];

// The program cloudflared, shipped next to the app (resources/), or given in .env.
function cloudflaredPath() {
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const candidates = [
        process.env.LABSHOW_CLOUDFLARED,
        process.resourcesPath ? path.join(process.resourcesPath, exe) : null,
        path.join(__dirname, 'resources', exe)
    ].filter(Boolean);
    return candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || exe;
}

// ---------- the isolated back end (src/backend.js) ----------
// It runs in its own process with only a message channel to this one. If it stops, it
// is started again with the same secret and port, so the windows reconnect by themselves.
const HOST_SECRET = crypto.randomBytes(32).toString('hex');
let backend = null;
let backendPort = Number(process.env.LABSHOW_PORT) || 0;
let backendRestarts = 0;
let requestId = 0;
const pendingRequests = new Map();

function backendConfig() {
    return {
        secret: HOST_SECRET,
        port: backendPort,
        cloudflared: cloudflaredPath(),
        tunnelOff: process.env.LABSHOW_TUNNEL === 'off',
        tunnelToken: process.env.LABSHOW_TUNNEL_TOKEN || '',
        publicUrl: process.env.LABSHOW_PUBLIC_URL || '',
        extraIceServers: INSTITUTION_TURN,
        workDir: WORK_DIR
    };
}

function startBackend() {
    return new Promise((resolve, reject) => {
        const child = utilityProcess.fork(path.join(__dirname, 'src', 'backend.js'), [], {
            serviceName: 'Lab show back end',
            cwd: WORK_DIR,
            env: { ...process.env },
            stdio: 'inherit'
        });
        backend = child;
        let ready = false;
        child.on('message', (message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'ready') {
                ready = true;
                backendPort = message.info.port;
                resolve(message.info);
            } else if (message.type === 'reply' || (message.type === 'error' && message.id)) {
                const pending = pendingRequests.get(message.id);
                if (pending) {
                    pendingRequests.delete(message.id);
                    pending(message.type === 'reply' ? message.result : null);
                }
            } else if (message.type === 'error' && !ready) {
                reject(new Error(message.message));
            } else if (message.type === 'log') {
                console.log(message.message);
            }
        });
        child.on('exit', (code) => {
            if (backend === child) backend = null;
            for (const [id, pending] of pendingRequests) {
                pendingRequests.delete(id);
                pending(null);
            }
            if (!ready) reject(new Error(`back end exited (${code})`));
            else if (!isQuitting && backendRestarts < 20) {
                backendRestarts += 1;
                setTimeout(() => startBackend().catch((error) => console.error('back end', error)), 1000);
            }
        });
        child.postMessage({ type: 'start', config: backendConfig() });
    });
}

function backendRequest(type, payload, timeoutMs = 5000) {
    if (!backend) return Promise.resolve(null);
    const id = ++requestId;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            resolve(null);
        }, timeoutMs);
        pendingRequests.set(id, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        backend.postMessage({ type, id, ...payload });
    });
}

function stopBackend() {
    const child = backend;
    if (!child) return Promise.resolve();
    backend = null;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* gone */ }
            resolve();
        }, 3000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.postMessage({ type: 'stop' });
    });
}

app.setAppUserModelId('com.labshow.desktop');
// Remote voices in a public broadcast must play without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function isAppWindow(webContents) {
    if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) return true;
    for (const win of roomWindows) {
        if (!win.isDestroyed() && webContents === win.webContents) return true;
    }
    return false;
}

function createAppIcon() {
    const width = 32;
    const height = 32;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowStart = y * (1 + width * 4);
        raw[rowStart] = 0;
        for (let x = 0; x < width; x++) {
            const idx = rowStart + 1 + x * 4;
            const isBorder = x < 3 || x >= width - 3 || y < 3 || y >= height - 3;
            const isCenter = x >= 11 && x <= 20 && y >= 11 && y <= 20;
            if (isCenter) {
                raw[idx] = 52; raw[idx + 1] = 211; raw[idx + 2] = 153; raw[idx + 3] = 255;
            } else if (isBorder) {
                raw[idx] = 14; raw[idx + 1] = 165; raw[idx + 2] = 233; raw[idx + 3] = 255;
            } else {
                raw[idx] = 15; raw[idx + 1] = 23; raw[idx + 2] = 42; raw[idx + 3] = 255;
            }
        }
    }

    let crcTable = null;
    function crc32(buf) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function chunk(type, data) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const typeBuffer = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
        return Buffer.concat([length, typeBuffer, data, crc]);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;

    return nativeImage.createFromBuffer(Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]));
}

async function quitApplication() {
    if (isQuitting) return;
    isQuitting = true;
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.destroy();
    floatingWindow = null;
    for (const win of Array.from(roomWindows)) if (!win.isDestroyed()) win.destroy();
    await notificationGuard.restore();
    await stopBackend();
    app.quit();
}

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function rebuildTrayMenu(icon) {
    if (!tray) return;
    const { sharing, paused, controlEnabled } = outgoingState;
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: paused ? 'استئناف البث' : 'إيقاف البث مؤقتاً',
            enabled: sharing,
            click: () => sendToRenderer('tray:toggle-pause')
        },
        {
            label: controlEnabled ? 'إيقاف تحكم الأستاذ بالمفاتيح' : 'السماح للأستاذ بالمفاتيح',
            enabled: sharing && !paused,
            click: () => sendToRenderer('tray:toggle-control')
        },
        {
            label: 'إيقاف البث',
            enabled: sharing,
            click: () => sendToRenderer('tray:stop-broadcast')
        },
        { type: 'separator' },
        {
            label: 'فتح التطبيق',
            click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        },
        {
            label: 'تصغير التطبيق',
            enabled: Boolean(mainWindow && mainWindow.isVisible()),
            click: () => mainWindow && mainWindow.minimize()
        },
        { type: 'separator' },
        { label: 'إغلاق التطبيق', click: quitApplication }
    ]));

    tray.setToolTip(paused
        ? 'Lab show - البث متوقف مؤقتاً'
        : sharing
            ? 'Lab show - يبث الشاشة حالياً'
            : 'Lab show - التطبيق يعمل');
    tray.setImage(icon);
}

function createWindowAndTray() {
    const icon = createAppIcon();
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 640,
        minHeight: 520,
        title: 'Lab show',
        icon,
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    mainWindow.setContentProtection(true);

    mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
        if (frameName === 'FloatingPlayer') {
            const { width, height } = screen.getPrimaryDisplay().workAreaSize;
            const fw = 480;
            const fh = 300;
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: fw,
                    height: fh,
                    x: width - fw - 20,
                    y: height - fh - 20,
                    minWidth: 260,
                    minHeight: 160,
                    frame: false,
                    alwaysOnTop: true,
                    skipTaskbar: true,
                    resizable: true,
                    backgroundColor: '#000000',
                    webPreferences: {
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: false
                    }
                }
            };
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('did-create-window', (child, details) => {
        if (details.frameName !== 'FloatingPlayer') return;
        floatingWindow = child;
        child.setContentProtection(true);
        child.setAlwaysOnTop(true, 'screen-saver');
        child.on('closed', () => {
            floatingWindow = null;
            if (!isQuitting) sendToRenderer('floating:closed');
        });
    });

    mainWindow.on('close', (event) => {
        if (shouldQuitOnWindowClose(isQuitting)) {
            event.preventDefault();
            quitApplication();
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    tray = new Tray(icon);
    rebuildTrayMenu(icon);

    tray.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
    tray.on('right-click', () => tray.popUpContextMenu());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else if (isInstallerShutdownRequest(process.argv)) {
    isQuitting = true;
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        if (isInstallerShutdownRequest(commandLine)) {
            isQuitting = true;
            app.quit();
            return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (!mainWindow.isVisible()) mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

app.on('before-quit', () => {
    isQuitting = true;
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
    loadSettings();
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then(
            (sources) => callback(sources && sources.length ? { video: sources[0] } : {}),
            () => callback({})
        );
    });

    const info = await startBackend();
    hostInfo = { ...info, hostSecret: HOST_SECRET, iceServers: [{ urls: STUN_URLS }, ...INSTITUTION_TURN] };
    createWindowAndTray();
    // pathToFileURL encodes spaces in paths such as "C:\Users\Alwand Center\...".
    const entryUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
    await mainWindow.loadURL(entryUrl);
}).catch((error) => {
    console.error('فشل تشغيل التطبيق:', error);
    app.quit();
});

// hostInfo carries the host secret: hand it to this app's own windows only, never to the
// floating player.
ipcMain.handle('host-info', (event) => (isAppWindow(event.sender) ? hostInfo : null));

// A device sends its screen to one place at a time: either privately to one receiver
// (main window) or publicly to many viewers (the owner's room window).
ipcMain.handle('outgoing:can-start', () => (
    roomOwnerWindow && !roomOwnerWindow.isDestroyed()
        ? { ok: false, error: 'room-active' }
        : { ok: true }
));

function sendRoomOwnerState() {
    sendToRenderer('room:owner-state', { active: Boolean(roomOwnerWindow && !roomOwnerWindow.isDestroyed()) });
}

const ROOM_QUERY_KEYS = ['role', 'lang', 'host', 'port', 'web', 'code', 'token', 'mode', 'name', 'title', 'duration'];

ipcMain.handle('room:open', (event, params = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'host-only' };
    const role = params.role === 'owner' ? 'owner' : 'viewer';
    if (role === 'owner') {
        if (roomOwnerWindow && !roomOwnerWindow.isDestroyed()) {
            roomOwnerWindow.focus();
            return { ok: true, existing: true };
        }
        if (outgoingState.sharing) return { ok: false, error: 'sending-active' };
    }
    const win = new BrowserWindow({
        width: 1200,
        height: 780,
        minWidth: 720,
        minHeight: 520,
        title: 'Lab show',
        icon: createAppIcon(),
        autoHideMenuBar: true,
        backgroundColor: '#050707',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    // Keep the room window itself out of the shared screen (no picture-in-picture loop).
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    roomWindows.add(win);
    if (role === 'owner') roomOwnerWindow = win;
    win.on('closed', () => {
        roomWindows.delete(win);
        if (roomOwnerWindow === win) {
            roomOwnerWindow = null;
            updateNotificationGuard();
            sendRoomOwnerState();
        }
    });
    const query = {};
    for (const key of ROOM_QUERY_KEYS) {
        if (params[key] !== undefined && params[key] !== null) query[key] = String(params[key]);
    }
    query.role = role;
    win.loadURL(`${pathToFileURL(path.join(__dirname, 'renderer', 'room.html')).href}?${new URLSearchParams(query)}`);
    sendRoomOwnerState();
    updateNotificationGuard();
    return { ok: true };
});

// ---------- settings (kept in the user's app-data folder) ----------

const SETTINGS_DEFAULTS = { blockNotifications: false };
let settings = { ...SETTINGS_DEFAULTS };

function settingsFile() {
    return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
    try {
        const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        settings = { ...SETTINGS_DEFAULTS, blockNotifications: Boolean(saved.blockNotifications) };
    } catch (error) {
        settings = { ...SETTINGS_DEFAULTS };
    }
}

function saveSettings() {
    try {
        fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error('settings', error);
    }
}

// Pop-up notifications are hidden while this device shares its screen (privately or
// in a public broadcast), when the user asked for it, and restored afterwards.
function updateNotificationGuard() {
    const broadcasting = outgoingState.sharing || Boolean(roomOwnerWindow && !roomOwnerWindow.isDestroyed());
    if (settings.blockNotifications && broadcasting) notificationGuard.suppress();
    else notificationGuard.restore();
}

ipcMain.handle('settings:get', (event) => {
    if (!isAppWindow(event.sender)) return null;
    return { ...settings, notificationsSupported: process.platform === 'win32' };
});

ipcMain.handle('settings:set', (event, changes = {}) => {
    if (!isAppWindow(event.sender)) return null;
    if (typeof changes.blockNotifications === 'boolean') settings.blockNotifications = changes.blockNotifications;
    saveSettings();
    updateNotificationGuard();
    return { ...settings, notificationsSupported: process.platform === 'win32' };
});
ipcMain.handle('find-host', (_event, code) => backendRequest('find-host', { code: String(code || '') }));

ipcMain.handle('find-global-host', async (_event, { code, username, relayUrl } = {}) => {
    const url = String(relayUrl || process.env.LABSHOW_RELAY_URL || 'http://127.0.0.1:4477');
    const client = connectToRelay(url, {
        transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000
    });
    try {
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('connect_error', reject);
        });
        const result = await new Promise((resolve) => {
            client.timeout(5000).emit('relay:find', {
                code: String(code || '').trim(),
                username: String(username || '').trim()
            }, (error, reply) => resolve(
                error ? { ok: false, message: 'خادم المطابقة لم يستجب.' } : reply
            ));
        });
        return result;
    } catch (error) {
        return { ok: false, message: 'تعذر الاتصال بخادم المطابقة العالمية.' };
    } finally {
        client.disconnect();
    }
});

ipcMain.on('window:fullscreen', (_event, flag) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(Boolean(flag));
    mainWindow.setMenuBarVisibility(!flag);
});

// الواجهة تتكيف مع حجم النافذة الذي يختاره المستخدم؛ لا نفرض أحجاماً عند تبديل الشاشات.
ipcMain.on('window:size-mode', () => {});

ipcMain.on('window:show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
});

ipcMain.on('outgoing:state', (_event, state) => {
    if (!state || typeof state !== 'object') return;
    outgoingState.sharing = Boolean(state.sharing);
    outgoingState.paused = Boolean(state.paused);
    if (!outgoingState.sharing || outgoingState.paused) outgoingState.controlEnabled = false;
    if (tray) rebuildTrayMenu(createAppIcon());
    updateNotificationGuard();
});

ipcMain.on('outgoing:control', (_event, enabled) => {
    outgoingState.controlEnabled = Boolean(enabled) && outgoingState.sharing && !outgoingState.paused;
    if (tray) rebuildTrayMenu(createAppIcon());
});

ipcMain.handle('control:key', async (event, key) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
        return { ok: false, message: 'التحكم متاح من نافذة التطبيق فقط.' };
    }
    if (!outgoingState.controlEnabled || !outgoingState.sharing || outgoingState.paused) {
        return { ok: false, message: 'التحكم غير مفعّل على هذا الجهاز.' };
    }
    if (!isAllowedControlKey(key)) return { ok: false, message: 'هذا المفتاح غير مسموح.' };
    await pressControlKey(key);
    return { ok: true };
});
