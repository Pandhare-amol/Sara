/* ===========================================================================
 * SARA â€” Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      when running standalone. The production supervisor owns the backend
 *      when it launches Electron.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim â€” nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  desktopCapturer,
  ipcMain,
  session,
} = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// --- Constants -------------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;
const SUPERVISOR_MANAGES_BACKEND =
  process.env.SARA_SUPERVISOR === '1' ||
  process.env.SARA_SERVICE_MANAGER === '1';

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

ipcMain.handle('sara:get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1280, height: 720 },
    fetchWindowIcons: false,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    display_id: source.display_id,
  }));
});

ipcMain.handle('sara:get-primary-screen-source-id', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });

  return sources[0]?.id ?? null;
});

ipcMain.handle('sara:check-screen-permission', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    const thumbnail = sources[0]?.thumbnail;
    const thumbnailOk = Boolean(thumbnail && !thumbnail.isEmpty());
    return {
      ok: sources.length > 0 && thumbnailOk,
      sourcesFound: sources.length,
      thumbnailOk,
      message:
        sources.length > 0 && thumbnailOk
          ? undefined
          : 'No screen capture source is available.',
    };
  } catch (error) {
    return {
      ok: false,
      sourcesFound: 0,
      thumbnailOk: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('sara:capture-screen-frame', async (_event, options = {}) => {
  const maxWidth = Number.isFinite(options.maxWidth) ? options.maxWidth : 960;
  const quality = Number.isFinite(options.quality) ? options.quality : 55;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: Math.round(maxWidth * 0.5625) },
    fetchWindowIcons: false,
  });
  const thumbnail = sources[0]?.thumbnail;
  if (!thumbnail || thumbnail.isEmpty()) {
    return { ok: false, error: 'No screen source available.' };
  }

  const size = thumbnail.getSize();
  return {
    ok: true,
    frame: thumbnail.toJPEG(Math.max(1, Math.min(100, quality))).toString('base64'),
    width: size.width,
    height: size.height,
  };
});

// ---------------------------------------------------------------------------
// Single-instance guard â€” second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });
        callback(sources[0] ? { video: sources[0] } : {});
      } catch (error) {
        console.error('[Screen Capture] Failed to resolve display media source:', error);
        callback({});
      }
    });
    bootstrap();
  });
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder â€” the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'sara-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'sara-agent', 'sara-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    SARA_LAUNCHED_BY: 'electron',
    SARA_DATA_DIR: dataDir,
    SARA_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.SARA_AGENT_EXE = agentExe;
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      dialog.showErrorBox(
        'SARA backend stopped',
        `The SARA backend process exited unexpectedly (code ${code}, signal ${signal}).`,
      );
      app.quit();
    }
  });
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(SERVER_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'SARA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const revealMainWindow = () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  };

  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', revealMainWindow);
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[electron] UI failed to load (${errorCode}: ${errorDescription}) ${validatedURL}`,
        );
        dialog.showErrorBox(
          'SARA UI failed to load',
          `${errorDescription} (${errorCode})\n\n${validatedURL}`,
        );
      }
    },
  );

  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.loadURL(SERVER_ORIGIN);
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.sara.desktop');
  createSplashWindow();

  try {
    if (!SUPERVISOR_MANAGES_BACKEND) {
      startBackend();
    }
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
  } catch (err) {
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'SARA failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);

