const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const zlib = require('node:zlib');
const dgram = require('node:dgram');
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

const { createLocalHostNode, UDP_DISCOVERY_PORT } = require('./src/server');
const { isAllowedControlKey, pressControlKey } = require('./src/keyboard-controls');
const {
    isInstallerShutdownRequest,
    shouldQuitOnWindowClose
} = require('./src/app-lifecycle');

let mainWindow = null;
let tray = null;
let floatingWindow = null;
let hostNode = null;
let hostInfo = { port: 0, ips: [] };
let isQuitting = false;
let outgoingState = { sharing: false, paused: false, controlEnabled: false };

app.setAppUserModelId('com.labshow.desktop');

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
    if (hostNode) {
        await hostNode.stop();
        hostNode = null;
    }
    app.quit();
}

function findHostByCodeOnLan(code) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), 1600);

        socket.on('message', (msg, rinfo) => {
            const text = msg.toString();
            const prefix = `LAB_SHOW_MATCH:${code}:`;
            if (text.startsWith(prefix)) {
                const port = Number(text.slice(prefix.length));
                if (Number.isInteger(port) && port > 0) finish({ ip: rinfo.address, port });
            }
        });
        socket.on('error', () => finish(null));
        socket.bind(() => {
            socket.setBroadcast(true);
            const packet = Buffer.from(`LAB_SHOW_FIND:${code}`);
            socket.send(packet, UDP_DISCOVERY_PORT, '255.255.255.255');
            for (const interfaces of Object.values(os.networkInterfaces())) {
                for (const iface of interfaces || []) {
                    if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
                    const ip = iface.address.split('.').map(Number);
                    const mask = iface.netmask.split('.').map(Number);
                    socket.send(packet, UDP_DISCOVERY_PORT,
                        ip.map((part, i) => (part | (~mask[i] & 255))).join('.'));
                }
            }
        });
    });
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
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then(
            (sources) => callback(sources && sources.length ? { video: sources[0] } : {}),
            () => callback({})
        );
    });

    hostNode = createLocalHostNode();
    hostInfo = await hostNode.start();
    createWindowAndTray();
    // pathToFileURL encodes spaces in paths such as "C:\Users\Alwand Center\...".
    const entryUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
    await mainWindow.loadURL(entryUrl);
}).catch((error) => {
    console.error('فشل تشغيل التطبيق:', error);
    app.quit();
});

// hostInfo carries the host secret: hand it to the main window only, never to the floating player.
ipcMain.handle('host-info', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    return hostInfo;
});
ipcMain.handle('find-host', (_event, code) => findHostByCodeOnLan(String(code || '')));

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
