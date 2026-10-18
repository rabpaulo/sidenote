const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sidenoteDesktop', {
  isElectron: true,
  platform: process.platform,

  // Token the backend requires on every request of this run.
  backendToken: () => ipcRenderer.sendSync('sidenote:backend-token'),

  // Window Controls
  minimize: () => ipcRenderer.send('sidenote:minimize'),
  close: () => ipcRenderer.send('sidenote:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('sidenote:toggle-always-on-top'),
  getAlwaysOnTop: () => ipcRenderer.invoke('sidenote:get-always-on-top'),
  setMode: (mode) => ipcRenderer.send('sidenote:set-mode', mode),
  setOpacity: (value) => ipcRenderer.send('sidenote:set-opacity', value),
  usesCssOpacity: process.platform === 'linux',
  // False while an X11 desktop has no compositor, so the window cannot be transparent yet.
  getCompositor: () => ipcRenderer.invoke('sidenote:get-compositor'),

  // Native folder picker (Obsidian vault); resolves to a path or null.
  pickDirectory: (title) => ipcRenderer.invoke('sidenote:pick-directory', title),

  // Events from Main Process (shortcuts, etc.)
  onShortcut: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('sidenote:shortcut', handler);
    return () => ipcRenderer.removeListener('sidenote:shortcut', handler);
  },

  // Screenshot shortcut: settings hold the monitor ("cursor" or an output name) and the connected monitors.
  getScreenshotSettings: () => ipcRenderer.invoke('sidenote:get-screenshot-settings'),
  setScreenshotMonitor: (monitor) => ipcRenderer.invoke('sidenote:set-screenshot-monitor', monitor),

  // Screen captures from the screenshot shortcut: { image } or { error }.
  onScreenshot: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('sidenote:screenshot', handler);
    return () => ipcRenderer.removeListener('sidenote:screenshot', handler);
  },
});
