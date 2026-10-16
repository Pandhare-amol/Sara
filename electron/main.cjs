/* ===========================================================================
 * SARA â€” Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server_full.ts, bundled to dist/server.cjs)
 *      when running standalone. The production supervisor owns the backend
 *      when it launches Electron.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      from the configured loopback SERVER_ORIGIN into the main application window.
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
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const { backendDataDir, protectedDatastoreExists } = require('./nativeGuard.cjs');
const { canChooseScreen } = require('./screenPermission.cjs');

// --- Constants -------------------------------------------------------------
const SERVER_PORT = Number(process.env.SARA_ELECTRON_PORT || 3000);
if (!Number.isInteger(SERVER_PORT) || SERVER_PORT < 1 || SERVER_PORT > 65535) {
  throw new Error('Invalid SARA_ELECTRON_PORT; use an integer between 1 and 65535.');
}
// WebAuthn rejects numeric IP relying-party IDs; localhost is a secure-context
// exception and is required by the server's local passkey policy.
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;


// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');
// Native IPC handlers exist independently of Express. They must see the SAME
// protected flag as the backend before responding to any capture request.
require('dotenv').config({ path: path.join(APP_ROOT, '.env') });
const SUPERVISOR_MANAGES_BACKEND =
  process.env.SARA_SUPERVISOR === '1' ||
  process.env.SARA_SERVICE_MANAGER === '1';
const configuredAgentInternalToken = String(process.env.SARA_AGENT_INTERNAL_TOKEN || '').trim();
if (configuredAgentInternalToken && Buffer.byteLength(configuredAgentInternalToken, 'utf8') < 32) {
  throw new Error('SARA_AGENT_INTERNAL_TOKEN must contain at least 32 UTF-8 bytes.');
}
// Generated only in this Electron process and shared with its backend.
const SARA_AGENT_INTERNAL_TOKEN = configuredAgentInternalToken || crypto.randomBytes(32).toString('base64url');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
let backendStderrTail = '';
let backendFailureReported = false;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

function multiUserScreenLocked() {
  return protectedDatastoreExists({
    required: process.env.SARA_MULTIUSER_REQUIRED === 'true',
    appRoot: APP_ROOT,
    appUserData: app.getPath('userData'),
    configuredDataDir: process.env.SARA_DATA_DIR,
  });
}

// Retired IPC capture shortcuts bypassed user-selected display/window scope.
// Keep these channels deny-only for older renderer builds; only the native
// display-media picker below may approve a stream, after a fresh user gesture.
ipcMain.handle('sara:get-screen-sources', () => []);
ipcMain.handle('sara:get-primary-screen-source-id', () => null);
ipcMain.handle('sara:check-screen-permission', () => ({ ok: false, message: 'Use the Share Screen picker.' }));
ipcMain.handle('sara:capture-screen-frame', () => ({ ok: false, error: 'Use user-approved display media or scoped visual access.' }));

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
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      // Electron does not supply a Windows picker by default. Never pick the
      // first display silently: only approve an explicit choice from our own
      // foreground modal for a trusted app-origin, user-gesture request.
      if (!canChooseScreen(request, SERVER_ORIGIN, multiUserScreenLocked()) || !mainWindow || mainWindow.isDestroyed()) {
        callback({}); return;
      }
      try {
        const sources = (await desktopCapturer.getSources({
          types: ['window', 'screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false,
        })).slice(0, 12);
        if (!sources.length) { callback({}); return; }
        const cancel = sources.length;
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'SARA screen sharing',
          message: 'Choose one window or display to share with Live voice',
          detail: 'Visible frames can be sent to the configured Live model until you pause or stop sharing. A display can show other private windows. Cancel is the default.',
          buttons: [...sources.map((source) => source.name.slice(0, 65)), 'Cancel'],
          defaultId: cancel, cancelId: cancel, noLink: true,
        });
        if (choice.response === cancel || multiUserScreenLocked() || !mainWindow || mainWindow.isDestroyed()) {
          callback({}); return;
        }
        callback({ video: sources[choice.response] });
      } catch (error) {
        console.error('[Screen Capture] Display selection unavailable.');
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
  const dataDir = backendDataDir(APP_ROOT, app.getPath('userData'), process.env.SARA_DATA_DIR);

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'sara-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'sara-agent', 'sara-agent.exe');
  if (app.isPackaged && !fs.existsSync(agentExe)) {
    throw new Error(`Bundled desktop agent is missing at ${agentExe}. Rebuild the agent before packaging SARA.`);
  }

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    // Electron owns this backend port; ignore PORT/SARA_BIND_HOST from .env so
    // `npm run app` stays on a known, private loopback endpoint.
    PORT: String(SERVER_PORT),
    SARA_BIND_HOST: '127.0.0.1',
    SARA_LAUNCHED_BY: 'electron',
    SARA_DATA_DIR: dataDir,
    SARA_APP_ROOT: APP_ROOT,
    SARA_AGENT_INTERNAL_TOKEN,

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
  serverProcess.stderr?.on('data', (d) => {
    const text = String(d);
    backendStderrTail = `${backendStderrTail}${text}`.slice(-4000);
    process.stderr.write(`[server] ${text}`);
  });
  serverProcess.on('error', (error) => {
    if (!isQuitting && !backendFailureReported) {
      backendFailureReported = true;
      dialog.showErrorBox('SARA backend failed to launch', error?.message || String(error));
      app.quit();
    }
  });
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting && !backendFailureReported) {
      backendFailureReported = true;
      const detail = backendStderrTail.trim();
      dialog.showErrorBox(
        'SARA backend stopped',
        `The SARA backend process exited unexpectedly (code ${code}, signal ${signal}).${detail ? `\n\nLast backend output:\n${detail}` : ''}`,
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

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error?.code === 'ECONNREFUSED'));
    socket.setTimeout(1200, () => finish(false));
  });
}

/** Poll until the port serves SARA's config endpoint, not merely any HTTP app. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let finished = false;
    const retry = () => {
      if (finished) return;
      if (Date.now() >= deadline) {
        finished = true;
        reject(new Error(`SARA backend did not become ready at ${SERVER_ORIGIN}.`));
      } else {
        setTimeout(tryOnce, 400);
      }
    };
    const tryOnce = () => {
      if (finished) return;
      const req = http.get(`${SERVER_ORIGIN}/api/config`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body = `${body}${chunk}`.slice(0, 4096); });
        res.on('end', () => {
          try {
            const payload = JSON.parse(body);
            if (res.statusCode === 200 && typeof payload?.hasApiKey === 'boolean') {
              finished = true;
              resolve();
              return;
            }
          } catch { /* a different service is listening, so keep waiting */ }
          retry();
        });
      });
      req.on('error', retry);
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
      const available = await isPortAvailable(SERVER_PORT);
      if (!available) {
        throw new Error(`Port ${SERVER_PORT} on 127.0.0.1 is already occupied. SARA did not stop the existing process. Close the service that owns it, or launch with SARA_ELECTRON_PORT set to an unused port.`);
      }
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

