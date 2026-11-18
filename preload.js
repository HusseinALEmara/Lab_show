const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getHostInfo: () => ipcRenderer.invoke('get-host-info'),
    findHostByCode: (code) => ipcRenderer.invoke('find-host-by-code', code),

    setFullScreen: (flag) => ipcRenderer.send('set-fullscreen', flag),
    setWindowSizeMode: (mode) => ipcRenderer.send('set-window-size-mode', mode),
    hideToBackground: () => ipcRenderer.send('hide-to-background'),
    showWindow: () => ipcRenderer.send('show-window'),
    setOutgoingState: (state) => ipcRenderer.send('set-outgoing-state', state),
    setStudentControlEnabled: (enabled) => ipcRenderer.send('set-student-control-enabled', enabled),
    applyStudentControlKey: (key) => ipcRenderer.invoke('apply-student-control-key', key),

    onTrayStopBroadcast: (cb) => {
        ipcRenderer.on('tray-stop-broadcast', () => cb());
    },
    onTrayTogglePause: (cb) => {
        ipcRenderer.on('tray-toggle-pause', () => cb());
    },
    onTrayToggleStudentControl: (cb) => {
        ipcRenderer.on('tray-toggle-student-control', () => cb());
    }
});
