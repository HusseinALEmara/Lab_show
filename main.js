const path = require('path');
const os = require('os');
const zlib = require('zlib');
const dgram = require('dgram');
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

const { createLocalHostNode, UDP_DISCOVERY_PORT } = require('./server');

let mainWindow = null;
let tray = null;
let hostNode = null;
let hostInfo = { port: 0, ips: [] };
let isQuitting = false;
let isOutgoingSharing = false;
let isOutgoingPaused = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (!mainWindow.isVisible()) mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
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
    const compressed = zlib.deflateSync(raw);

    function crc32(buf) {
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
            }
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function makeChunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;

    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', compressed),
        makeChunk('IEND', Buffer.alloc(0))
    ]);

    return nativeImage.createFromBuffer(png);
}

function findHostByCodeOnLan(code) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch { }
            resolve(result);
        };

        const timer = setTimeout(() => finish(null), 1600);

        socket.on('message', (msg, rinfo) => {
            const text = msg.toString();
            const prefix = `LAB_SHOW_MATCH:${code}:`;
            if (text.startsWith(prefix)) {
                const port = parseInt(text.slice(prefix.length), 10);
                if (port > 0) {
                    clearTimeout(timer);
                    finish({ ip: rinfo.address, port });
                }
            }
        });

        socket.on('error', () => {
            clearTimeout(timer);
            finish(null);
        });

        socket.bind(() => {
            socket.setBroadcast(true);
            const packet = Buffer.from(`LAB_SHOW_FIND:${code}`);
            socket.send(packet, UDP_DISCOVERY_PORT, '255.255.255.255');

            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
                        const ipParts = iface.address.split('.').map(Number);
                        const maskParts = iface.netmask.split('.').map(Number);
                        const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
                        socket.send(packet, UDP_DISCOVERY_PORT, bcast);
                    }
                }
            }
        });
    });
}

function rebuildTrayMenu() {
    if (!tray) return;

    const menu = Menu.buildFromTemplate([
        {
            label: isOutgoingPaused ? 'استئناف البث' : 'إيقاف البث مؤقتاً',
            enabled: isOutgoingSharing,
            click: () => {
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('tray-toggle-pause');
                }
            }
        },
        {
            label: 'إيقاف البث',
            enabled: isOutgoingSharing,
            click: () => {
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('tray-stop-broadcast');
                }
            }
        },
        {
            label: 'الدخول للتطبيق',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'إغلاق التطبيق',
            click: async () => {
                isQuitting = true;
                if (hostNode) {
                    await hostNode.stop();
                }
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(menu);

    if (isOutgoingSharing && isOutgoingPaused) {
        tray.setToolTip('Lab show - البث متوقف مؤقتاً');
    } else if (isOutgoingSharing) {
        tray.setToolTip('Lab show - يبث الشاشة حالياً');
    } else {
        tray.setToolTip('Lab show - يعمل بالخلفية');
    }
}

function createWindowAndTray() {
    const icon = createAppIcon();

    mainWindow = new BrowserWindow({
        width: 470,
        height: 450,
        minWidth: 430,
        minHeight: 380,
        title: 'Lab show',
        icon,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
        if (frameName === 'FloatingPlayer') {
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: sw, height: sh } = primaryDisplay.workAreaSize;
            const fw = 420;
            const fh = 245;

            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: fw,
                    height: fh,
                    x: sw - fw - 20,
                    y: sh - fh - 20,
                    minWidth: 260,
                    minHeight: 160,
                    frame: false,
                    alwaysOnTop: true,
                    skipTaskbar: true,
                    resizable: true,
                    backgroundColor: '#000000',
                    webPreferences: {
                        sandbox: false,
                        contextIsolation: true,
                        nodeIntegration: false
                    }
                }
            };
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('did-create-window', (childWindow, details) => {
        if (details.frameName === 'FloatingPlayer') {
            // منع ظهور النافذة العائمة عند مشاركة الشاشة للطرف الآخر
            childWindow.setContentProtection(true);
            childWindow.setAlwaysOnTop(true, 'screen-saver');
        }
    });

    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            if (mainWindow.isFullScreen()) {
                mainWindow.setFullScreen(false);
            }
            mainWindow.hide();
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    tray = new Tray(icon);
    rebuildTrayMenu();

    tray.on('click', () => {
        tray.popUpContextMenu();
    });
}

app.whenReady().then(async () => {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
            .getSources({ types: ['screen'] })
            .then((sources) => {
                if (sources && sources.length > 0) {
                    callback({ video: sources[0] });
                } else {
                    callback({});
                }
            })
            .catch(() => callback({}));
    });

    hostNode = createLocalHostNode();
    hostInfo = await hostNode.start();
    createWindowAndTray();
    await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

ipcMain.handle('get-host-info', () => hostInfo);

ipcMain.handle('find-host-by-code', async (_e, code) => {
    return await findHostByCodeOnLan(code);
});

ipcMain.on('set-fullscreen', (_e, flag) => {
    if (!mainWindow) return;
    mainWindow.setFullScreen(Boolean(flag));
    mainWindow.setMenuBarVisibility(!flag);
});

ipcMain.on('set-window-size-mode', (_e, mode) => {
    if (!mainWindow || mainWindow.isFullScreen()) return;
    if (mode === 'viewer') {
        const [w, h] = mainWindow.getSize();
        if (w < 920 || h < 580) {
            mainWindow.setSize(1040, 660);
            mainWindow.center();
        }
    } else if (mode === 'compact') {
        mainWindow.setSize(470, 450);
        mainWindow.center();
    }
});

ipcMain.on('hide-to-background', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.on('show-window', () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    }
});

ipcMain.on('set-outgoing-state', (_e, state) => {
    if (typeof state === 'object' && state !== null) {
        isOutgoingSharing = Boolean(state.sharing);
        isOutgoingPaused = Boolean(state.paused);
    } else {
        isOutgoingSharing = Boolean(state);
        isOutgoingPaused = false;
    }
    rebuildTrayMenu();
});
