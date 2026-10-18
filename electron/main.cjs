const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { watchCompositor } = require('./compositor.cjs');

const BACKEND_URL = 'http://127.0.0.1:3001';
// Token of this run: every API request and the WebSocket must carry it (server/backend-auth.js).
let backendToken = null;

// Same folder as the backend's profile (server/profile-store.js), where it writes its token.
function backendDataDir(env = process.env) {
  if (env.SIDENOTE_PROFILE_PATH) return path.dirname(env.SIDENOTE_PROFILE_PATH);
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Sidenote');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'sidenote');
}

function readBackendToken() {
  try {
    return fs.readFileSync(path.join(backendDataDir(), 'backend-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

let mainWindow = null;
let isAlwaysOnTop = true;
let currentMode = 'normal'; // 'normal' | 'compact'
const NORMAL_MIN_SIZE = [360, 440];
const COMPACT_MIN_SIZE = [280, 160];
const COMPACT_HEIGHT = 300;
let previousBounds = { width: 440, height: 620, x: undefined, y: undefined };
let serverProcess = null;
// Electron's native setOpacity is a no-op on Linux, so there the window is
// transparent and the renderer fades itself with CSS instead.
const useCssOpacity = process.platform === 'linux';
// Whether the X11 compositor that transparency needs was running when the window was
// made: false, true, or null when unknown (Wayland, or the check failed).
let compositorAtWindow = null;
let compositorWatch = null;
const managedByDevScript = process.argv.includes('--managed-backend');
const devRendererUrl = process.env.SIDENOTE_DEV_URL || 'http://localhost:5173';
const managedRenderer = process.argv.includes('--managed-renderer') || managedByDevScript;

// The app's own pages; nothing else may load in the window or read the token.
function isAppUrl(url) {
  try {
    const { origin } = new URL(url);
    return origin === new URL(BACKEND_URL).origin || origin === new URL(devRendererUrl).origin;
  } catch {
    return false;
  }
}

// Windows groups taskbar entries and notifications by this id; it must match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('io.github.rabpaulo.sidenote');

// The app was called InterviewAI: its folders move once to the current name. The backend
// folder goes first; on Windows it is also Electron's userData, which then already exists.
function moveLegacyFolder(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    console.warn(`[Electron] Could not move ${from} to ${to}:`, error.message);
  }
}
if (!process.env.SIDENOTE_PROFILE_PATH) {
  const dataDir = backendDataDir();
  moveLegacyFolder(path.join(path.dirname(dataDir), process.platform === 'win32' ? 'InterviewAI' : 'interviewai'), dataDir);
}
// userData is named after package.json: "sidenote" in development, "Sidenote" when packaged.
moveLegacyFolder(path.join(app.getPath('appData'), app.getName() === 'Sidenote' ? 'InterviewAI' : 'interviewai'), app.getPath('userData'));

function ensureServerRunning() {
  const isBackendRunning = () => new Promise((resolve) => {
    const request = http.get(`${BACKEND_URL}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });

    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(false));
  });

  const waitForBackend = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isBackendRunning()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Backend did not become ready on ${BACKEND_URL}`);
  };

  return (async () => {
    // A backend this window did not start wrote its token to the profile folder.
    // Another backend (an old run, or one with another profile) may hold the port with a
    // token this window cannot read: every request would fail with "Não autorizado".
    const reuseToken = async () => {
      backendToken = readBackendToken();
      if (backendToken && await tokenAccepted(backendToken)) return;
      const message = `Outro backend do Sidenote está usando a porta 3001 e não aceita o token deste app. `
        + `Feche-o (por exemplo: fuser -k 3001/tcp) e abra o app de novo.`;
      console.error(`[Electron] ${message}`);
      dialog.showErrorBox('Sidenote', message);
      throw new Error('The backend on port 3001 rejects this token');
    };
    const tokenAccepted = (token) => new Promise((resolve) => {
      const request = http.get(`${BACKEND_URL}/api/status`, { headers: { 'x-sidenote-token': token } }, (response) => {
        response.resume();
        resolve(response.statusCode !== 401);
      });
      request.setTimeout(2000, () => request.destroy());
      request.on('error', () => resolve(false));
    });

    if (await isBackendRunning()) {
      console.log('[Electron] Backend server is already running.');
      await reuseToken();
      return;
    }

    if (managedByDevScript) {
      console.log('[Electron] Waiting for the dev script backend...');
      await waitForBackend();
      await reuseToken();
      console.log('[Electron] Dev backend is ready!');
      return;
    }

    console.log('[Electron] Starting local backend server...');
    backendToken = crypto.randomBytes(32).toString('hex');
    const serverScript = path.join(__dirname, '../server/index.js');
    serverProcess = spawn(process.execPath || 'node', [serverScript], {
      cwd: path.join(__dirname, '..'),
      // The IPC channel lets the backend notice when this process dies (server/index.js).
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      env: { ...process.env, PORT: '3001', ELECTRON_RUN_AS_NODE: '1', SIDENOTE_TOKEN: backendToken },
    });

    await waitForBackend();
    console.log('[Electron] Local backend server is ready!');
  })();
}

// `bounds` reopens the window where it was (see reopenForCompositor).
function createWindow(bounds = null) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  const windowWidth = 440;
  const windowHeight = 620;
  const defaultX = Math.round(workArea.x + workArea.width - windowWidth - 28);
  const defaultY = Math.round(workArea.y + 40);
  const minSize = bounds && currentMode === 'compact' ? COMPACT_MIN_SIZE : NORMAL_MIN_SIZE;

  const iconPath = path.join(__dirname, '../build/icon.png');

  const win = new BrowserWindow({
    width: bounds?.width || windowWidth,
    height: bounds?.height || windowHeight,
    x: bounds?.x ?? defaultX,
    y: bounds?.y ?? defaultY,
    minWidth: minSize[0],
    minHeight: minSize[1],
    backgroundColor: useCssOpacity ? '#00000000' : '#0c0c11',
    title: 'Sidenote',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    frame: false, // frameless for sleek floating widget with custom draggable header
    transparent: useCssOpacity,
    alwaysOnTop: true, // starts pinned
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  // Links in agent answers open in the default browser, never inside the overlay.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // A file dropped outside a drop zone must never replace the app with the file, and a
  // link in an answer must not load another site in the window (it would get the token).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Ctrl +/-/0 zoom only the reading text. Intercepting them here also disables the
  // default menu's whole-page zoom; the keys only arrive while the window has focus.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    let action = null;
    if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') action = 'text_zoom_in';
    else if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') action = 'text_zoom_out';
    else if (input.key === '0' || input.code === 'Numpad0') action = 'text_zoom_reset';
    if (!action) return;
    event.preventDefault();
    mainWindow.webContents.send('sidenote:shortcut', action);
  });

  // Log renderer console messages to terminal
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${path.basename(sourceId || '')}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer Failed Load] code=${errorCode}: ${errorDescription} at ${validatedURL}`);
  });

  // Load URL with automatic retry until server is live
  const loadTargetUrl = () => {
    if (app.isPackaged) {
      const reqBackend = http.get(BACKEND_URL, (res) => {
        res.resume();
        console.log(`[Electron] Loading from Backend server ${BACKEND_URL}`);
        mainWindow.loadURL(BACKEND_URL);
      });
      reqBackend.on('error', () => {
        setTimeout(loadTargetUrl, 300);
      });
      return;
    }

    const reqVite = http.get(devRendererUrl, (res) => {
      res.resume();
      console.log(`[Electron] Loading from Vite dev server ${devRendererUrl}`);
      mainWindow.loadURL(devRendererUrl);
    });
    reqVite.on('error', () => {
      if (managedRenderer) {
        setTimeout(loadTargetUrl, 400);
        return;
      }

      const reqBackend = http.get(BACKEND_URL, (res) => {
        res.resume();
        console.log(`[Electron] Loading from Backend server ${BACKEND_URL}`);
        mainWindow.loadURL(BACKEND_URL);
      });
      reqBackend.on('error', () => {
        setTimeout(loadTargetUrl, 400);
      });
    });
  };

  loadTargetUrl();

  mainWindow.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
  });

  mainWindow.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// The compositor started after the window was made, which left it opaque: a new
// window gets the alpha channel. Same place and size; the page reloads.
function reopenForCompositor() {
  compositorAtWindow = true;
  const old = mainWindow;
  if (!old || old.isDestroyed()) return;
  console.log('[Electron] Compositor started: reopening the window so it can be transparent.');
  const bounds = old.getBounds();
  const visible = old.isVisible();
  createWindow(bounds);
  if (!visible) mainWindow.once('ready-to-show', () => mainWindow?.hide());
  old.destroy();
}

function setupShortcuts() {
  // Global Shortcut: Alt+Space -> Toggle mic recording
  globalShortcut.register('Alt+Space', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sidenote:shortcut', 'toggle_mic');
    }
  });

  // Global Shortcut: CommandOrControl+D -> Analyze / Ask Copilot (Sidenote keybinding)
  try {
    globalShortcut.register('CommandOrControl+D', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sidenote:shortcut', 'ask_copilot');
      }
    });
  } catch (err) {
    console.warn('[Electron] Could not register Ctrl+D:', err);
  }

  // Global Shortcut: CommandOrControl+B -> Toggle window show/hide
  try {
    globalShortcut.register('CommandOrControl+B', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (err) {
    console.warn('[Electron] Could not register Ctrl+B:', err);
  }

  // Developer Shortcuts: Ctrl+Shift+I / F12 to toggle DevTools, Ctrl+R / F5 to reload
  try {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    });
    globalShortcut.register('F12', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    });
    globalShortcut.register('CommandOrControl+R', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    });
    globalShortcut.register('F5', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    });
  } catch (err) {}

  // Global Shortcut: Ctrl+Alt+P -> Toggle PC audio listening
  globalShortcut.register('Control+Alt+P', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sidenote:shortcut', 'toggle_pc_audio');
    }
  });

  // Global Shortcut: Ctrl+Alt+M -> Toggle mic recording
  globalShortcut.register('Control+Alt+M', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sidenote:shortcut', 'toggle_mic');
    }
  });

  // Global Shortcut: Ctrl+Alt+S -> Send a screenshot to the agent
  if (!globalShortcut.register(SCREENSHOT_SHORTCUT, sendScreenshot)) {
    console.warn(`[Electron] Could not register ${SCREENSHOT_SHORTCUT}: it is taken by another application.`);
  }

  // Global Shortcut: Ctrl+Alt+N -> Nova Sessão
  globalShortcut.register('Control+Alt+N', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sidenote:shortcut', 'new_session');
    }
  });
}

// Long edge of screenshots sent to the agent: keeps text legible with a small payload.
const SCREENSHOT_MAX_EDGE = 1920;
// Alt+Shift is a common layout switch on Linux (grp:alt_shift_toggle) and swallows Shift there,
// so the global shortcuts use Ctrl+Alt instead.
const SCREENSHOT_SHORTCUT = 'Control+Alt+S';
const CURSOR_MONITOR = 'cursor';
const screenshotSettingsFile = path.join(app.getPath('userData'), 'screenshot.json');
let isCapturingScreen = false;

// Monitor captured by the shortcut: CURSOR_MONITOR or an output name such as "DP-2".
let screenshotMonitor = (() => {
  try {
    const { monitor } = JSON.parse(fs.readFileSync(screenshotSettingsFile, 'utf8'));
    return typeof monitor === 'string' && monitor ? monitor : CURSOR_MONITOR;
  } catch {
    return CURSOR_MONITOR;
  }
})();

// X11 output names (DP-2, HDMI-1) with their geometry in physical pixels.
function readXrandrOutputs() {
  if (process.platform !== 'linux') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('xrandr', ['--listmonitors'], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve([...stdout.matchAll(/(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)\s+(\S+)\s*$/gm)].map((match) => ({
        width: Number(match[1]), height: Number(match[2]), x: Number(match[3]), y: Number(match[4]), name: match[5],
      })));
    });
  });
}

async function listMonitors() {
  const outputs = await readXrandrOutputs();
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => {
    const scale = display.scaleFactor || 1;
    const { x, y, width, height } = display.bounds;
    const output = outputs.find((item) => Math.abs(item.x - x * scale) <= 1 && Math.abs(item.y - y * scale) <= 1
      && Math.abs(item.width - width * scale) <= 1 && Math.abs(item.height - height * scale) <= 1);
    return {
      id: display.id,
      name: output?.name || display.label || `Monitor ${index + 1}`,
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      primary: display.id === primaryId,
    };
  });
}

async function screenshotDisplay() {
  if (screenshotMonitor !== CURSOR_MONITOR) {
    const monitor = (await listMonitors()).find((item) => item.name === screenshotMonitor);
    const display = monitor && screen.getAllDisplays().find((item) => item.id === monitor.id);
    // A disconnected monitor falls back to the one under the cursor.
    if (display) return display;
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Keeps the overlay out of a capture of `display` without unmapping it: tiling window
// managers such as dwm re-place a remapped window on the focused monitor.
async function withoutOverlay(display, task) {
  const win = mainWindow;
  if (!win.isVisible() || win.isMinimized() || !intersects(win.getBounds(), display.bounds)) return task();
  const useShape = process.platform !== 'darwin';
  const opacity = win.getOpacity();
  // An empty shape draws nothing, even without a compositor; macOS has no shapes but honors opacity.
  if (useShape) win.setShape([]);
  else win.setOpacity(0);
  // Give the windows below time to repaint the area the overlay was covering.
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    return await task();
  } finally {
    if (!win.isDestroyed()) {
      // An oversized rectangle restores the full window and survives later resizes.
      if (useShape) win.setShape([{ x: 0, y: 0, width: 100000, height: 100000 }]);
      else win.setOpacity(opacity);
    }
  }
}

function captureDisplay(display) {
  return withoutOverlay(display, async () => {
    const scale = display.scaleFactor || 1;
    const capture = (width, height) => desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    const displays = screen.getAllDisplays();
    let sources = await capture(display.size.width, display.size.height);
    // On X11 the capturer's display_id is unrelated to Electron's display ids, but both list monitors in RandR order.
    const source = sources.find((item) => item.display_id === String(display.id))
      || (sources.length === displays.length ? sources[displays.findIndex((item) => item.id === display.id)] : null);
    if (source) return source.thumbnail;
    if (sources.length === 1 && displays.length > 1) {
      // Some X11 setups expose every monitor as one screen: crop the requested display.
      const desktop = displays.reduce((area, { bounds }) => ({
        width: Math.max(area.width, bounds.x + bounds.width),
        height: Math.max(area.height, bounds.y + bounds.height),
      }), { width: 0, height: 0 });
      sources = await capture(desktop.width, desktop.height);
      const shot = sources[0].thumbnail;
      const ratio = shot.getSize().width / desktop.width;
      return shot.crop({
        x: Math.round(display.bounds.x * ratio),
        y: Math.round(display.bounds.y * ratio),
        width: Math.round(display.bounds.width * ratio),
        height: Math.round(display.bounds.height * ratio),
      });
    }
    return sources[0]?.thumbnail;
  });
}

/** Captures the configured display, without the overlay, as base64 JPEG. */
async function captureScreen() {
  let image = await captureDisplay(await screenshotDisplay());
  if (!image || image.isEmpty()) throw new Error('Nenhuma tela disponível para captura');

  const size = image.getSize();
  const resize = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(size.width, size.height));
  if (resize < 1) {
    image = image.resize({ width: Math.round(size.width * resize), height: Math.round(size.height * resize), quality: 'best' });
  }
  return { mimeType: 'image/jpeg', data: image.toJPEG(85).toString('base64') };
}

async function sendScreenshot() {
  if (!mainWindow || mainWindow.isDestroyed() || isCapturingScreen) return;
  isCapturingScreen = true;
  try {
    const image = await captureScreen();
    mainWindow.webContents.send('sidenote:screenshot', { image });
  } catch (error) {
    console.error('[Electron] Screenshot failed:', error);
    mainWindow?.webContents.send('sidenote:screenshot', { error: error.message });
  } finally {
    isCapturingScreen = false;
  }
}

// 'compact' shrinks the window in place (only the agent answer is shown);
// 'normal' restores the size it had before, keeping wherever it was moved to.
function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === currentMode || (mode === 'normal' && currentMode !== 'compact')) {
    currentMode = mode;
    return;
  }

  currentMode = mode;
  try {
    const bounds = mainWindow.getBounds();
    const workArea = screen.getDisplayNearestPoint(bounds).workArea;

    if (mode === 'compact') {
      previousBounds = bounds;
      mainWindow.setMinimumSize(...COMPACT_MIN_SIZE);
      mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(bounds.height, COMPACT_HEIGHT) });
    } else {
      const width = Math.round(previousBounds?.width || 440);
      const height = Math.round(previousBounds?.height || 620);
      // Stay on screen when the compact window was moved close to an edge.
      const x = Math.min(bounds.x, workArea.x + workArea.width - width);
      const y = Math.min(bounds.y, workArea.y + workArea.height - height);
      mainWindow.setMinimumSize(...NORMAL_MIN_SIZE);
      mainWindow.setBounds({ x: Math.max(workArea.x, x), y: Math.max(workArea.y, y), width, height });
    }
  } catch (err) {
    console.error('[Electron] Error in setWindowMode:', err);
  }
}

ipcMain.handle('sidenote:toggle-always-on-top', () => {
  if (!mainWindow) return false;
  isAlwaysOnTop = !isAlwaysOnTop;
  mainWindow.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
  return isAlwaysOnTop;
});

ipcMain.handle('sidenote:get-always-on-top', () => {
  if (!mainWindow) return false;
  return mainWindow.isAlwaysOnTop();
});

ipcMain.handle('sidenote:get-screenshot-settings', async () => ({
  monitor: screenshotMonitor,
  monitors: await listMonitors(),
  shortcut: SCREENSHOT_SHORTCUT,
}));

ipcMain.handle('sidenote:set-screenshot-monitor', (_event, monitor) => {
  if (typeof monitor !== 'string' || !monitor || monitor.length > 64) return screenshotMonitor;
  screenshotMonitor = monitor;
  try {
    fs.writeFileSync(screenshotSettingsFile, JSON.stringify({ monitor }));
  } catch (error) {
    console.warn('[Electron] Could not save the screenshot monitor:', error.message);
  }
  return screenshotMonitor;
});

// Folder picker for the Obsidian vault; resolves to null when cancelled.
ipcMain.handle('sidenote:pick-directory', async (_event, title) => {
  const options = { title: typeof title === 'string' ? title.slice(0, 120) : undefined, properties: ['openDirectory'] };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.on('sidenote:set-mode', (_event, mode) => {
  setWindowMode(mode);
});

// False while transparency waits for a compositor (X11 without one); true or null otherwise.
ipcMain.handle('sidenote:get-compositor', () => compositorAtWindow);

ipcMain.on('sidenote:set-opacity', (_event, value) => {
  if (!mainWindow || mainWindow.isDestroyed() || useCssOpacity) return;
  const opacity = Number(value);
  if (Number.isFinite(opacity)) mainWindow.setOpacity(Math.min(1, Math.max(0.3, opacity)));
});

// Read synchronously by the preload script, before the page makes its first request.
ipcMain.on('sidenote:backend-token', (event) => {
  event.returnValue = isAppUrl(event.senderFrame?.url) ? backendToken : null;
});

ipcMain.on('sidenote:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('sidenote:close', () => {
  if (mainWindow) mainWindow.close();
});


app.whenReady().then(async () => {
  // Allow microphone and audio capture automatically in desktop app
  if (session.defaultSession) {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(true);
    });
  }

  try {
    await ensureServerRunning();
    if (useCssOpacity) {
      compositorWatch = watchCompositor({ onStart: () => { if (compositorAtWindow === false) reopenForCompositor(); } });
      compositorAtWindow = await compositorWatch.present;
    }
    createWindow();
    setupShortcuts();
  } catch (error) {
    console.error('[Electron] Failed to start the backend:', error.message);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  compositorWatch?.stop();
  if (serverProcess) {
    console.log('[Electron] Terminating local backend server...');
    try {
      // Windows has no SIGTERM for the backend to clean up with, so end its CLI children too.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        serverProcess.kill();
      }
    } catch {}
    serverProcess = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit());
}
