/* ===========================================================================
 * SARA – Electron main process
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Enforce a single running instance.
 *   2. Use the existing StartupManager-owned backend when available.
 *   3. Start backend directly when Electron is running standalone.
 *   4. Show a splash window while backend boots.
 *   5. Create and maintain the SARA Electron UI.
 *   6. Recover from renderer crashes/failures without killing SARA.
 *   7. Provide native screen capture through desktopCapturer IPC.
 *   8. Provide secure external URL opening through IPC.
 *   9. Maintain tray integration.
 *  10. Clean up child processes when Electron actually exits.
 * =========================================================================== */

'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  desktopCapturer,
  session,
  ipcMain,
  screen: electronScreen,
  Notification,
} = require('electron');

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

let autoUpdater = null;

try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  autoUpdater = null;
}

/* ===========================================================================
 * Configuration
 * =========================================================================== */

const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const SERVER_READY_TIMEOUT_MS = 40_000;
const BACKEND_POLL_INTERVAL_MS = 400;

const NOTIFY_PORT = 43123;

const MAX_RENDERER_RESTARTS = 5;
const RENDERER_RESTART_WINDOW_MS = 60_000;

/*
 * IMPORTANT:
 *
 * Your original code uses localhost.
 * Using 127.0.0.1 avoids some Windows localhost/IPv6 resolution issues.
 */
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const FRONTEND_BUILD_PATH = path.join(
  APP_ROOT,
  'dist',
  'index.html',
);

const SERVER_ENTRY = path.join(
  APP_ROOT,
  'dist',
  'server.cjs',
);

/* ===========================================================================
 * State
 * =========================================================================== */

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {BrowserWindow | null} */
let splashWindow = null;

/** @type {Tray | null} */
let tray = null;

/** @type {import('http').Server | null} */
let notifyServer = null;

let isQuitting = false;
let bootstrapStarted = false;
let windowCreating = false;

let notifyToken =
  process.env.SARA_ELECTRON_NOTIFY_TOKEN || null;

let rendererRestartTimes = [];

/* ===========================================================================
 * Single instance
 * =========================================================================== */

const gotSingleInstanceLock =
  app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[electron] Second SARA instance detected.');

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }

      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });

  process.on('uncaughtException', (error) => {
    console.error(
      '[electron] Uncaught exception:',
      error,
    );

    /*
     * Do not immediately terminate Electron because of an
     * isolated exception. This was one of the dangerous parts
     * of the old lifecycle.
     */
    try {
      if (!isQuitting) {
        dialog.showErrorBox(
          'SARA Error',
          `Unexpected Electron error:\n\n${error.message}`,
        );
      }
    } catch {
      // best effort
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error(
      '[electron] Unhandled promise rejection:',
      reason,
    );
  });

  app.whenReady().then(bootstrap);
}

/* ===========================================================================
 * External URL IPC
 *
 * preload.ts calls:
 *
 * ipcRenderer.invoke('sara:open-external', url)
 *
 * Your old main.ts did NOT register this handler.
 * =========================================================================== */

ipcMain.handle(
  'sara:open-external',
  async (_event, url) => {
    try {
      const value = String(url || '').trim();

      if (
        !value.startsWith('https://') &&
        !value.startsWith('http://')
      ) {
        return {
          ok: false,
          error: 'Only HTTP and HTTPS URLs are allowed.',
        };
      }

      await shell.openExternal(value);

      return {
        ok: true,
      };
    } catch (error) {
      console.error(
        '[electron:open-external]',
        error,
      );

      return {
        ok: false,
        error: String(
          error?.message || error,
        ),
      };
    }
  },
);

/* ===========================================================================
 * Native screen source IPC
 * =========================================================================== */

ipcMain.handle(
  'sara:screen-sources',
  async (_event, opts = {}) => {
    try {
      const includeWindows =
        opts.includeWindows === true;

      const types = includeWindows
        ? ['screen', 'window']
        : ['screen'];

      /*
       * Do not use thumbnailSize 0x0.
       *
       * Some Electron/Windows combinations do not
       * behave correctly with zero-sized thumbnails.
       */
      const sources =
        await desktopCapturer.getSources({
          types,
          fetchWindowIcons: false,
          thumbnailSize: {
            width: 160,
            height: 90,
          },
        });

      return {
        ok: true,

        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          type: source.id.startsWith('screen:')
            ? 'screen'
            : 'window',
        })),
      };
    } catch (error) {
      console.error(
        '[electron:screen-sources]',
        error,
      );

      return {
        ok: false,
        error: String(
          error?.message || error,
        ),
        sources: [],
      };
    }
  },
);

/* ===========================================================================
 * Native screen capture IPC
 * =========================================================================== */

ipcMain.handle(
  'sara:screen-capture',
  async (_event, opts = {}) => {
    try {
      const quality = Math.max(
        10,
        Math.min(
          100,
          Number(opts.quality) || 65,
        ),
      );

      const maxWidth = Math.max(
        320,
        Math.min(
          1920,
          Number(opts.maxWidth) || 1280,
        ),
      );

      const primaryDisplay =
        electronScreen.getPrimaryDisplay();

      const displaySize =
        primaryDisplay.size;

      const screenWidth =
        Math.max(1, displaySize.width);

      const screenHeight =
        Math.max(1, displaySize.height);

      let thumbWidth = maxWidth;

      let thumbHeight = Math.round(
        (screenHeight / screenWidth) *
          thumbWidth,
      );

      /*
       * Protect against invalid dimensions.
       */
      thumbWidth = Math.max(
        320,
        Math.min(1920, thumbWidth),
      );

      thumbHeight = Math.max(
        180,
        Math.min(1920, thumbHeight),
      );

      const sources =
        await desktopCapturer.getSources({
          types: ['screen'],
          fetchWindowIcons: false,
          thumbnailSize: {
            width: thumbWidth,
            height: thumbHeight,
          },
        });

      if (
        !sources ||
        sources.length === 0
      ) {
        return {
          ok: false,
          error:
            'No screen sources were found.',
        };
      }

      let source = sources[0];

      if (opts.sourceId) {
        const requested =
          sources.find(
            (item) =>
              item.id === opts.sourceId,
          );

        if (requested) {
          source = requested;
        }
      }

      const thumbnail =
        source.thumbnail;

      if (
        !thumbnail ||
        thumbnail.isEmpty()
      ) {
        return {
          ok: false,
          error:
            'Screen thumbnail is empty.',
        };
      }

      const size =
        thumbnail.getSize();

      if (
        !size.width ||
        !size.height
      ) {
        return {
          ok: false,
          error:
            `Invalid screen frame size: ${size.width}x${size.height}`,
        };
      }

      const jpegBuffer =
        thumbnail.toJPEG(quality);

      return {
        ok: true,
        frame:
          jpegBuffer.toString('base64'),

        mime: 'image/jpeg',

        width: size.width,
        height: size.height,

        ts: Date.now(),

        sourceId: source.id,
        sourceName: source.name,
      };
    } catch (error) {
      console.error(
        '[electron:screen-capture]',
        error,
      );

      return {
        ok: false,
        error: String(
          error?.message || error,
        ),
      };
    }
  },
);

/* ===========================================================================
 * Monitor information
 * =========================================================================== */

ipcMain.handle(
  'sara:screen-monitors',
  async () => {
    try {
      const displays =
        electronScreen.getAllDisplays();

      const primary =
        electronScreen.getPrimaryDisplay();

      return {
        ok: true,

        monitors: displays.map(
          (display) => ({
            id: display.id,

            label:
              display.label ||
              `Display ${display.id}`,

            isPrimary:
              display.id === primary.id,

            bounds: display.bounds,

            workArea:
              display.workArea,

            scaleFactor:
              display.scaleFactor,
          }),
        ),
      };
    } catch (error) {
      return {
        ok: false,

        error: String(
          error?.message || error,
        ),

        monitors: [],
      };
    }
  },
);

/* ===========================================================================
 * Screen permission / capability check
 * =========================================================================== */

ipcMain.handle(
  'sara:screen-permission-check',
  async () => {
    try {
      const sources =
        await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: 32,
            height: 32,
          },
        });

      const hasSource =
        Array.isArray(sources) &&
        sources.length > 0;

      const thumbnail =
        hasSource
          ? sources[0].thumbnail
          : null;

      const thumbnailOk =
        !!thumbnail &&
        !thumbnail.isEmpty();

      return {
        ok:
          hasSource &&
          thumbnailOk,

        sourcesFound:
          sources?.length || 0,

        thumbnailOk,

        message:
          hasSource && thumbnailOk
            ? 'Screen capture is available.'
            : hasSource
              ? 'Screen source exists but thumbnail is empty.'
              : 'No screen source found.',
      };
    } catch (error) {
      console.error(
        '[electron:screen-permission-check]',
        error,
      );

      return {
        ok: false,

        error: String(
          error?.message || error,
        ),

        message: String(
          error?.message || error,
        ),
      };
    }
  },
);

/* ===========================================================================
 * Backend lifecycle
 * =========================================================================== */

function startBackend() {
  if (
    serverProcess &&
    !serverProcess.killed
  ) {
    console.log(
      '[electron] Backend already running.',
    );

    return;
  }

  const dataDir =
    app.getPath('userData');

  const isDev =
    process.env.SARA_FORCE_PROD === '1'
      ? false
      : !app.isPackaged;

  const agentExe =
    app.isPackaged
      ? path.join(
          process.resourcesPath,
          'agent',
          'sara-agent.exe',
        )
      : path.join(
          APP_ROOT,
          'agent_dist',
          'sara-agent',
          'sara-agent.exe',
        );

  const baseEnv = {
    ...process.env,

    SARA_LAUNCHED_BY:
      'electron',

    SARA_DATA_DIR:
      dataDir,

    SARA_APP_ROOT:
      APP_ROOT,
  };

  if (
    !baseEnv.SARA_ELECTRON_NOTIFY_TOKEN
  ) {
    baseEnv.SARA_ELECTRON_NOTIFY_TOKEN =
      crypto
        .randomBytes(16)
        .toString('hex');
  }

  notifyToken =
    baseEnv.SARA_ELECTRON_NOTIFY_TOKEN;

  if (
    fs.existsSync(agentExe)
  ) {
    baseEnv.SARA_AGENT_EXE =
      agentExe;
  }

  console.log(
    '[electron] Starting backend...',
  );

  try {
    if (isDev) {
      serverProcess = spawn(
        process.platform === 'win32'
          ? 'npm.cmd'
          : 'npm',
        ['run', 'dev'],
        {
          cwd: APP_ROOT,

          env: {
            ...baseEnv,

            NODE_ENV:
              'development',

            ELECTRON_RUN_AS_NODE:
              '1',
          },

          stdio: 'inherit',

          windowsHide: false,

          shell: false,
        },
      );
    } else {
      if (
        !fs.existsSync(
          SERVER_ENTRY,
        )
      ) {
        throw new Error(
          `Backend bundle not found:\n${SERVER_ENTRY}\n\nRun npm run build first.`,
        );
      }

      serverProcess = spawn(
        process.execPath,
        [SERVER_ENTRY],
        {
          cwd: APP_ROOT,

          env: {
            ...baseEnv,

            NODE_ENV:
              'production',

            ELECTRON_RUN_AS_NODE:
              '1',
          },

          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],

          windowsHide: true,
        },
      );
    }
  } catch (error) {
    console.error(
      '[electron] Backend spawn failed:',
      error,
    );

    throw error;
  }

  if (!serverProcess) {
    throw new Error(
      'Backend process was not created.',
    );
  }

  console.log(
    `[electron] Backend PID: ${serverProcess.pid}`,
  );

  serverProcess.on(
    'error',
    (error) => {
      console.error(
        '[electron] Backend process error:',
        error,
      );
    },
  );

  serverProcess.stdout?.on(
    'data',
    (data) => {
      process.stdout.write(
        `[server] ${data}`,
      );
    },
  );

  serverProcess.stderr?.on(
    'data',
    (data) => {
      process.stderr.write(
        `[server:err] ${data}`,
      );
    },
  );

  serverProcess.on(
    'exit',
    (code, signal) => {
      console.log(
        `[electron] Backend exited. code=${code} signal=${signal}`,
      );

      serverProcess = null;

      /*
       * Do not automatically kill the Electron UI just
       * because the backend restarted/exited.
       *
       * StartupManager owns the backend in supervisor mode.
       */
      if (
        !isQuitting &&
        !isSupervisorManaged()
      ) {
        console.error(
          '[electron] Backend exited unexpectedly.',
        );

        /*
         * Give the backend a chance to restart externally.
         * Do not immediately destroy the UI.
         */
      }
    },
  );
}

function stopBackend() {
  if (
    !serverProcess ||
    serverProcess.killed
  ) {
    serverProcess = null;
    return;
  }

  const pid =
    serverProcess.pid;

  console.log(
    `[electron] Stopping backend PID ${pid}...`,
  );

  try {
    if (
      process.platform === 'win32'
    ) {
      spawn(
        'taskkill',
        [
          '/pid',
          String(pid),
          '/T',
          '/F',
        ],
        {
          windowsHide: true,
        },
      );
    } else {
      serverProcess.kill(
        'SIGTERM',
      );
    }
  } catch (error) {
    console.warn(
      '[electron] Backend cleanup warning:',
      error,
    );
  }

  serverProcess = null;
}

function isSupervisorManaged() {
  return (
    process.env.SARA_SUPERVISOR === '1' ||
    process.env.SARA_SERVICE_MANAGER === '1'
  );
}

/* ===========================================================================
 * Notification server
 * =========================================================================== */

function startNotifyServer() {
  if (notifyServer) {
    return;
  }

  try {
    if (!notifyToken) {
      notifyToken =
        crypto
          .randomBytes(16)
          .toString('hex');
    }

    notifyServer =
      http.createServer(
        (req, res) => {
          if (
            req.method !== 'POST' ||
            req.url !==
              '/_electron_notify'
          ) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }

          const provided =
            req.headers[
              'x-sara-notify-token'
            ] || '';

          if (
            !provided ||
            String(provided) !==
              String(notifyToken)
          ) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }

          let body = '';

          req.on(
            'data',
            (chunk) => {
              body +=
                chunk.toString();
            },
          );

          req.on(
            'end',
            () => {
              try {
                const data =
                  JSON.parse(
                    body || '{}',
                  );

                const title =
                  data.title ||
                  'SARA';

                const message =
                  data.message ||
                  data.body ||
                  '';

                try {
                  new Notification({
                    title,
                    body: String(
                      message,
                    ),
                  }).show();
                } catch (error) {
                  console.warn(
                    '[electron] Notification failed:',
                    error,
                  );
                }

                res.statusCode = 200;

                res.setHeader(
                  'Content-Type',
                  'application/json',
                );

                res.end(
                  JSON.stringify({
                    ok: true,
                  }),
                );
              } catch (error) {
                res.statusCode = 400;
                res.end(
                  String(error),
                );
              }
            },
          );
        },
      );

    notifyServer.on(
      'error',
      (error) => {
        console.warn(
          '[electron] Notification server error:',
          error,
        );

        notifyServer = null;
      },
    );

    notifyServer.listen(
      NOTIFY_PORT,
      '127.0.0.1',
      () => {
        console.log(
          `[electron] notify server listening on 127.0.0.1:${NOTIFY_PORT}`,
        );
      },
    );
  } catch (error) {
    console.warn(
      '[electron] notify server not started:',
      error,
    );

    notifyServer = null;
  }
}

function stopNotifyServer() {
  if (!notifyServer) {
    return;
  }

  try {
    notifyServer.close();
  } catch {
    // best effort
  }

  notifyServer = null;
}

/* ===========================================================================
 * Backend readiness
 * =========================================================================== */

function waitForBackend(
  timeoutMs,
) {
  const deadline =
    Date.now() + timeoutMs;

  return new Promise(
    (resolve, reject) => {
      const tryOnce = () => {
        if (
          Date.now() >
          deadline
        ) {
          reject(
            new Error(
              `Backend did not become ready within ${timeoutMs}ms.`,
            ),
          );

          return;
        }

        const req =
          http.get(
            SERVER_ORIGIN,
            (res) => {
              const status =
                res.statusCode || 0;

              res.resume();

              /*
               * Any HTTP response proves that something
               * is listening. We don't require 200 here
               * because SARA's root route may change.
               */
              if (
                status >= 200 &&
                status < 500
              ) {
                resolve();
                return;
              }

              setTimeout(
                tryOnce,
                BACKEND_POLL_INTERVAL_MS,
              );
            },
          );

        req.setTimeout(
          2000,
          () => {
            req.destroy();
          },
        );

        req.on(
          'error',
          () => {
            setTimeout(
              tryOnce,
              BACKEND_POLL_INTERVAL_MS,
            );
          },
        );
      };

      tryOnce();
    },
  );
}

/* ===========================================================================
 * Tray
 * =========================================================================== */

function createTray() {
  if (tray) {
    return;
  }

  try {
    const iconPath =
      path.join(
        APP_ROOT,
        'assets',
        'icon.png',
      );

    const icon =
      fs.existsSync(iconPath)
        ? nativeImage.createFromPath(
            iconPath,
          )
        : nativeImage.createEmpty();

    tray = new Tray(icon);

    tray.setToolTip(
      'SARA - Always-On Assistant',
    );

    const contextMenu =
      Menu.buildFromTemplate([
        {
          label:
            'Open SARA UI',

          click: () => {
            showMainWindow();
          },
        },

        {
          label:
            'Security & Audit Dashboard',

          click: () => {
            showMainWindow();

            shell.openExternal(
              `${SERVER_ORIGIN}/admin/security`,
            );
          },
        },

        {
          type: 'separator',
        },

        {
          label:
            'Exit SARA',

          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]);

    tray.setContextMenu(
      contextMenu,
    );

    tray.on(
      'double-click',
      () => {
        showMainWindow();
      },
    );
  } catch (error) {
    console.warn(
      '[electron] Tray creation warning:',
      error,
    );

    tray = null;
  }
}

function destroyTray() {
  if (!tray) {
    return;
  }

  try {
    tray.destroy();
  } catch {
    // best effort
  }

  tray = null;
}

/* ===========================================================================
 * Splash
 * =========================================================================== */

function createSplashWindow() {
  if (
    splashWindow &&
    !splashWindow.isDestroyed()
  ) {
    return;
  }

  splashWindow =
    new BrowserWindow({
      width: 420,
      height: 300,

      frame: false,

      transparent: true,

      resizable: false,

      center: true,

      show: true,

      alwaysOnTop: true,

      skipTaskbar: true,

      backgroundColor:
        '#00000000',

      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,

        backgroundThrottling:
          false,
      },
    });

  splashWindow.loadFile(
    path.join(
      __dirname,
      'splash.html',
    ),
  );

  splashWindow.on(
    'closed',
    () => {
      splashWindow = null;
    },
  );
}

function closeSplashWindow() {
  if (
    splashWindow &&
    !splashWindow.isDestroyed()
  ) {
    try {
      splashWindow.close();
    } catch {
      // best effort
    }
  }

  splashWindow = null;
}

/* ===========================================================================
 * Auto start
 * =========================================================================== */

function configureAutoStart() {
  try {
    const isEnabled =
      process.env.SARA_AUTO_START !==
      'false';

    app.setLoginItemSettings({
      openAtLogin:
        isEnabled,

      path:
        app.getPath('exe'),

      args: [],
    });

    console.log(
      `[electron] Windows login startup ${
        isEnabled
          ? 'enabled'
          : 'disabled'
      }.`,
    );
  } catch (error) {
    console.warn(
      '[electron] Unable to configure Windows login startup:',
      error,
    );
  }
}

/* ===========================================================================
 * Auto updater
 * =========================================================================== */

function checkForUpdates() {
  if (
    !autoUpdater ||
    !app.isPackaged
  ) {
    return;
  }

  try {
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((error) => {
        console.warn(
          '[electron] Update check failed:',
          error,
        );
      });

    autoUpdater.on(
      'update-downloaded',
      () => {
        if (
          process.platform ===
          'win32' &&
          !isQuitting
        ) {
          autoUpdater.quitAndInstall(
            true,
            true,
          );
        }
      },
    );
  } catch (error) {
    console.warn(
      '[electron] updater check unavailable:',
      error,
    );
  }
}

/* ===========================================================================
 * Main window helpers
 * =========================================================================== */

function showMainWindow() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    createMainWindow();
    return;
  }

  if (
    mainWindow.isMinimized()
  ) {
    mainWindow.restore();
  }

  if (
    !mainWindow.isVisible()
  ) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function canRestartRenderer() {
  const now =
    Date.now();

  rendererRestartTimes =
    rendererRestartTimes.filter(
      (time) =>
        now - time <
        RENDERER_RESTART_WINDOW_MS,
    );

  if (
    rendererRestartTimes.length >=
    MAX_RENDERER_RESTARTS
  ) {
    return false;
  }

  rendererRestartTimes.push(
    now,
  );

  return true;
}

function recoverRenderer(reason) {
  console.error(
    `[electron] Recovering renderer. Reason: ${reason}`,
  );

  if (!canRestartRenderer()) {
    console.error(
      '[electron] Renderer restart limit reached.',
    );

    /*
     * Do NOT silently quit SARA.
     *
     * Keep the backend alive and show an
     * error dialog instead.
     */
    try {
      dialog.showErrorBox(
        'SARA UI Error',
        'The SARA interface encountered repeated renderer failures.\n\n' +
          'The SARA backend is still running.\n\n' +
          'Please restart the SARA application.',
      );
    } catch {
      // best effort
    }

    return;
  }

  try {
    if (
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.destroy();
    }
  } catch {
    // best effort
  }

  mainWindow = null;

  setTimeout(
    () => {
      if (
        !isQuitting
      ) {
        createMainWindow();
      }
    },
    500,
  );
}

/* ===========================================================================
 * Main window
 * =========================================================================== */

function createMainWindow() {
  if (windowCreating) {
    return mainWindow;
  }

  if (
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    showMainWindow();
    return mainWindow;
  }

  windowCreating = true;

  console.log(
    '[electron] Creating main window...',
  );

  try {
    mainWindow =
      new BrowserWindow({
        width: 1280,
        height: 800,

        minWidth: 940,
        minHeight: 600,

        show: false,

        backgroundColor:
          '#0a0a0f',

        autoHideMenuBar: true,

        title: 'SARA',

        /*
         * Prevent renderer throttling while the
         * window is hidden during startup.
         */
        backgroundThrottling: false,

        webPreferences: {
          preload:
            path.join(
              __dirname,
              'preload.cjs',
            ),

          contextIsolation:
            true,

          nodeIntegration:
            false,

          sandbox:
            false,

          spellcheck:
            true,

          backgroundThrottling:
            false,

          webSecurity:
            true,
        },
      });

    Menu.setApplicationMenu(
      null,
    );

    /*
     * Renderer starts loading.
     */
    mainWindow.webContents.on(
      'did-start-loading',
      () => {
        console.log(
          '[electron] Renderer started loading the UI.',
        );
      },
    );

    /*
     * Renderer successfully loaded.
     *
     * IMPORTANT:
     * We explicitly show the window here rather than
     * relying only on ready-to-show.
     */
    mainWindow.webContents.on(
      'did-finish-load',
      () => {
        console.log(
          '[electron] Renderer finished loading successfully.',
        );

        if (
          mainWindow &&
          !mainWindow.isDestroyed()
        ) {
          setTimeout(
            () => {
              if (
                mainWindow &&
                !mainWindow.isDestroyed()
              ) {
                if (
                  !mainWindow.isVisible()
                ) {
                  mainWindow.show();
                }

                mainWindow.focus();

                closeSplashWindow();
              }
            },
            50,
          );
        }
      },
    );

    /*
     * IMPORTANT:
     *
     * The old code immediately called reloadIgnoringCache()
     * every time a load failed.
     *
     * That can create an infinite reload loop.
     */
    mainWindow.webContents.on(
      'did-fail-load',
      (
        event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      ) => {
        if (!isMainFrame) {
          return;
        }

        console.error(
          '[electron] Renderer failed to load:',
          {
            errorCode,
            errorDescription,
            validatedURL,
          },
        );

        /*
         * -3 is ERR_ABORTED.
         * It commonly happens when a navigation is
         * intentionally cancelled.
         */
        if (errorCode === -3) {
          return;
        }

        recoverRenderer(
          `did-fail-load ${errorCode}: ${errorDescription}`,
        );
      },
    );

    /*
     * Renderer crashed.
     */
    mainWindow.webContents.on(
      'render-process-gone',
      (_event, details) => {
        console.error(
          '[electron] Renderer process gone:',
          details,
        );

        if (
          details.reason ===
          'clean-exit'
        ) {
          return;
        }

        recoverRenderer(
          `render-process-gone: ${details.reason}`,
        );
      },
    );

    mainWindow.webContents.on(
      'unresponsive',
      () => {
        console.warn(
          '[electron] Renderer became unresponsive.',
        );
      },
    );

    mainWindow.webContents.on(
      'responsive',
      () => {
        console.log(
          '[electron] Renderer is responsive again.',
        );
      },
    );

    /*
     * Open external HTTP/HTTPS links in Windows browser.
     */
    mainWindow.webContents.setWindowOpenHandler(
      ({ url }) => {
        try {
          if (
            url.startsWith(
              'https://',
            ) ||
            url.startsWith(
              'http://',
            )
          ) {
            if (
              !url.startsWith(
                SERVER_ORIGIN,
              )
            ) {
              shell.openExternal(
                url,
              );

              return {
                action:
                  'deny',
              };
            }
          }
        } catch (error) {
          console.error(
            '[electron] External URL error:',
            error,
          );
        }

        return {
          action: 'allow',
        };
      },
    );

    /*
     * Also handle normal navigation attempts.
     */
    mainWindow.webContents.on(
      'will-navigate',
      (event, url) => {
        if (
          url.startsWith(
            SERVER_ORIGIN,
          )
        ) {
          return;
        }

        if (
          url.startsWith(
            'http://',
          ) ||
          url.startsWith(
            'https://',
          )
        ) {
          event.preventDefault();

          shell.openExternal(
            url,
          );
        }
      },
    );

    /*
     * ready-to-show remains as a fallback.
     */
    mainWindow.once(
      'ready-to-show',
      () => {
        console.log(
          '[electron] Main window ready-to-show.',
        );

        if (
          mainWindow &&
          !mainWindow.isDestroyed()
        ) {
          if (
            !mainWindow.isVisible()
          ) {
            mainWindow.show();
          }

          mainWindow.focus();

          closeSplashWindow();
        }
      },
    );

    /*
     * IMPORTANT:
     *
     * Clicking X does NOT kill SARA.
     * It hides the UI into the tray.
     *
     * Only "Exit SARA" or app.quit()
     * actually terminates Electron.
     */
    mainWindow.on(
      'close',
      (event) => {
        if (!isQuitting) {
          event.preventDefault();

          mainWindow?.hide();

          console.log(
            '[electron] Main window hidden. SARA remains running.',
          );
        }
      },
    );

    mainWindow.on(
      'closed',
      () => {
        console.log(
          '[electron] Main window destroyed.',
        );

        mainWindow = null;
      },
    );

    /*
     * Development:
     *     http://127.0.0.1:3000
     *
     * Packaged:
     *     dist/index.html if it exists.
     */
    const shouldLoadBuiltFrontend =
      app.isPackaged &&
      fs.existsSync(
        FRONTEND_BUILD_PATH,
      );

    if (
      shouldLoadBuiltFrontend
    ) {
      console.log(
        '[electron] Loading built frontend:',
        FRONTEND_BUILD_PATH,
      );

      mainWindow.loadFile(
        FRONTEND_BUILD_PATH,
      );
    } else {
      console.log(
        '[electron] Loading renderer from backend:',
        SERVER_ORIGIN,
      );

      mainWindow.loadURL(
        SERVER_ORIGIN,
      );
    }

    /*
     * Safety fallback:
     *
     * If did-finish-load/ready-to-show somehow does not
     * make the window visible, show it after 10 seconds.
     */
    setTimeout(
      () => {
        if (
          mainWindow &&
          !mainWindow.isDestroyed() &&
          !mainWindow.isVisible()
        ) {
          console.warn(
            '[electron] Main window was still hidden after timeout. Showing it manually.',
          );

          mainWindow.show();
          mainWindow.focus();

          closeSplashWindow();
        }
      },
      10_000,
    );

    console.log(
      '[electron] Main window creation completed.',
    );

    return mainWindow;
  } catch (error) {
    console.error(
      '[electron] createMainWindow failed:',
      error,
    );

    try {
      if (
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        mainWindow.destroy();
      }
    } catch {
      // best effort
    }

    mainWindow = null;

    throw error;
  } finally {
    windowCreating = false;
  }
}

/* ===========================================================================
 * Bootstrap
 * =========================================================================== */

async function bootstrap() {
  if (bootstrapStarted) {
    console.log(
      '[electron] Bootstrap already started.',
    );

    return;
  }

  bootstrapStarted = true;

  console.log(
    '[electron] Electron bootstrap starting...',
  );

  try {
    app.setAppUserModelId(
      'com.sara.desktop',
    );

    /*
     * Do not disable GPU by default.
     *
     * If the renderer continues crashing on the target
     * Windows machine, enable the fallback through:
     *
     * SARA_DISABLE_GPU=1
     *
     * before launching SARA.
     */
    if (
      process.env.SARA_DISABLE_GPU ===
      '1'
    ) {
      console.warn(
        '[electron] GPU disabled by environment.',
      );

      app.disableHardwareAcceleration();
    }

    configureAutoStart();
    checkForUpdates();

    /*
     * Native screen capture is handled through:
     *
     * desktopCapturer -> IPC -> preload -> renderer
     *
     * We intentionally do NOT force getDisplayMedia().
     *
     * This avoids the problematic video source path.
     */
    console.log(
      '[electron] Native screen capture IPC enabled.',
    );

    createSplashWindow();

    startNotifyServer();

    if (isSupervisorManaged()) {
      console.log(
        '[electron] StartupManager owns backend lifecycle.',
      );

      console.log(
        '[electron] Waiting for supervised backend...',
      );

      await waitForBackend(
        SERVER_READY_TIMEOUT_MS,
      );

      console.log(
        '[electron] Backend confirmed healthy.',
      );
    } else {
      let alreadyRunning =
        false;

      try {
        await waitForBackend(
          1000,
        );

        alreadyRunning =
          true;

        console.log(
          '[electron] Backend already running.',
        );
      } catch {
        console.log(
          '[electron] Backend not ready. Starting backend.',
        );
      }

      if (!alreadyRunning) {
        startBackend();

        console.log(
          '[electron] Waiting for backend...',
        );

        await waitForBackend(
          SERVER_READY_TIMEOUT_MS,
        );

        console.log(
          '[electron] Backend is ready.',
        );
      }
    }

    console.log(
      '[electron] Creating SARA main window...',
    );

    createMainWindow();

    console.log(
      '[electron] Creating tray...',
    );

    createTray();

    console.log(
      '[electron] Electron bootstrap complete.',
    );
  } catch (error) {
    console.error(
      '[electron] Bootstrap failed:',
      error,
    );

    closeSplashWindow();

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    try {
      dialog.showErrorBox(
        'SARA failed to start',
        `Electron bootstrap failed:\n\n${message}`,
      );
    } catch {
      // best effort
    }

    /*
     * Only bootstrap failure should terminate Electron.
     */
    isQuitting = true;

    app.quit();
  }
}

/* ===========================================================================
 * App lifecycle
 * =========================================================================== */

app.on(
  'activate',
  () => {
    console.log(
      '[electron] App activated.',
    );

    showMainWindow();
  },
);

app.on(
  'render-process-gone',
  (_event, details) => {
    console.error(
      '[electron] Application render process gone:',
      details,
    );
  },
);

app.on(
  'child-process-gone',
  (_event, details) => {
    console.error(
      '[electron] Child process gone:',
      details,
    );
  },
);

app.on(
  'window-all-closed',
  () => {
    /*
     * On Windows we intentionally keep SARA alive
     * in the tray.
     */
    console.log(
      '[electron] Window-all-closed event.',
    );

    if (
      process.platform ===
        'darwin'
    ) {
      return;
    }

    if (!isQuitting) {
      console.log(
        '[electron] Keeping SARA alive in tray.',
      );
    }
  },
);

app.on(
  'before-quit',
  () => {
    if (isQuitting) {
      return;
    }

    isQuitting = true;

    console.log(
      '[electron] SARA quitting...',
    );

    closeSplashWindow();

    destroyTray();

    stopNotifyServer();

    /*
     * StartupManager owns backend in normal
     * production startup.
     */
    if (
      !isSupervisorManaged()
    ) {
      stopBackend();
    }
  },
);

app.on(
  'will-quit',
  () => {
    isQuitting = true;

    stopNotifyServer();

    if (
      !isSupervisorManaged()
    ) {
      stopBackend();
    }
  },
);

process.on(
  'exit',
  () => {
    /*
     * Do not spawn taskkill from process exit.
     * The before-quit/will-quit handlers handle
     * normal cleanup.
     */
  },
);