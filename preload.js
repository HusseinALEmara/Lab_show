const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getHostInfo: () => ipcRenderer.invoke('host-info'),
    findHostByCode: (code) => ipcRenderer.invoke('find-host', code),
    findGlobalHost: (code, username, relayUrl) =>
        ipcRenderer.invoke('find-global-host', { code, username, relayUrl }),
    setFullScreen: (flag) => ipcRenderer.send('window:fullscreen', flag),
    setWindowSizeMode: (mode) => ipcRenderer.send('window:size-mode', mode),
    showWindow: () => ipcRenderer.send('window:show'),
    setOutgoingState: (state) => ipcRenderer.send('outgoing:state', state),
    setStudentControlEnabled: (enabled) => ipcRenderer.send('outgoing:control', enabled),
    applyControlKey: (key) => ipcRenderer.invoke('control:key', key),
    canStartOutgoing: () => ipcRenderer.invoke('outgoing:can-start'),
    openRoom: (params) => ipcRenderer.invoke('room:open', params),
    setNotificationsSuppressed: (suppressed) => ipcRenderer.invoke('notifications:set', Boolean(suppressed)),
    onRoomOwnerState: (callback) => ipcRenderer.on('room:owner-state', (_event, state) => callback(state)),

    onTrayStopBroadcast: (callback) => ipcRenderer.on('tray:stop-broadcast', () => callback()),
    onTrayTogglePause: (callback) => ipcRenderer.on('tray:toggle-pause', () => callback()),
    onTrayToggleControl: (callback) => ipcRenderer.on('tray:toggle-control', () => callback()),
    onFloatingClosed: (callback) => ipcRenderer.on('floating:closed', () => callback())
});
