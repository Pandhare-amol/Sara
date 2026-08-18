# SARA Electron Preload — Fixed `preload.ts`

```ts
/* ===========================================================================
 * SARA – Electron preload
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Expose a minimal, safe API through contextBridge.
 *   2. Never expose ipcRenderer directly to the renderer.
 *   3. Provide native screen-capture APIs.
 *   4. Provide monitor information.
 *   5. Provide external URL opening through the main process.
 *   6. Return predictable error objects instead of silently failing.
 * =========================================================================== */

'use strict';

import { contextBridge, ipcRenderer } from 'electron';

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

type ScreenSource = {
  id: string;
  name: string;
  type: 'screen' | 'window';
};

type ScreenCaptureOptions = {
  sourceId?: string;
  quality?: number;
  maxWidth?: number;
};

type ScreenCaptureResult = {
  ok: boolean;
  frame?: string;
  mime?: string;
  width?: number;
  height?: number;
  ts?: number;
  sourceId?: string;
  sourceName?: string;
  error?: string;
};

type MonitorInfo = {
  id: number | string;
  label: string;
  isPrimary: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scaleFactor: number;
};

type MonitorResult = {
  ok: boolean;
  monitors: MonitorInfo[];
  error?: string;
};

type PermissionResult = {
  ok: boolean;
  sourcesFound?: number;
  thumbnailOk?: boolean;
  message: string;
  error?: string;
};

type OpenExternalResult = {
  ok: boolean;
  error?: string;
};

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/**
 * Safely convert an unknown error into a readable message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Validate external URLs before sending them to the main process.
 *
 * Only HTTP and HTTPS URLs are allowed.
 */
function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const url = value.trim();

  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

/**
 * Clamp a number into a safe range.
 */
function clamp(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numberValue =
    typeof value === 'number'
      ? value
      : Number(value);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numberValue));
}

/* ---------------------------------------------------------------------------
 * Expose SARA API
 * ------------------------------------------------------------------------- */

contextBridge.exposeInMainWorld('sara', {
  /* -------------------------------------------------------------------------
   * Runtime information
   * ----------------------------------------------------------------------- */

  isDesktop: true,

  platform: process.platform,

  version: process.versions.electron,

  /* -------------------------------------------------------------------------
   * External URL
   * ----------------------------------------------------------------------- */

  /**
   * Open an HTTP/HTTPS URL using the operating system's default browser.
   *
   * IMPORTANT:
   * The actual shell.openExternal() call happens in main.ts.
   */
  openExternal: async (
    url: string,
  ): Promise<OpenExternalResult> => {
    try {
      if (!isSafeExternalUrl(url)) {
        return {
          ok: false,
          error: 'Only valid HTTP/HTTPS URLs are allowed.',
        };
      }

      const result = await ipcRenderer.invoke(
        'sara:open-external',
        url.trim(),
      );

      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          error: 'Invalid response from Electron main process.',
        };
      }

      return result;
    } catch (error) {
      const message = errorMessage(error);

      console.error(
        '[SARA preload] openExternal failed:',
        message,
      );

      return {
        ok: false,
        error: message,
      };
    }
  },

  /* -------------------------------------------------------------------------
   * Screen sources
   * ----------------------------------------------------------------------- */

  /**
   * Get available screen/window sources.
   */
  getScreenSources: async (): Promise<ScreenSource[]> => {
    try {
      const result = await ipcRenderer.invoke(
        'sara:screen-sources',
        {
          includeWindows: true,
        },
      );

      if (
        !result ||
        !Array.isArray(result.sources)
      ) {
        return [];
      }

      return result.sources;
    } catch (error) {
      console.error(
        '[SARA preload] getScreenSources failed:',
        errorMessage(error),
      );

      return [];
    }
  },

  /* -------------------------------------------------------------------------
   * Primary screen source
   * ----------------------------------------------------------------------- */

  /**
   * Get the primary screen source ID.
   */
  getPrimaryScreenSourceId: async (): Promise<string | null> => {
    try {
      const result = await ipcRenderer.invoke(
        'sara:screen-sources',
        {
          includeWindows: false,
        },
      );

      if (
        !result ||
        !Array.isArray(result.sources)
      ) {
        return null;
      }

      const primaryScreen = result.sources.find(
        (source: ScreenSource) =>
          source.type === 'screen',
      );

      return primaryScreen?.id ?? null;
    } catch (error) {
      console.error(
        '[SARA preload] getPrimaryScreenSourceId failed:',
        errorMessage(error),
      );

      return null;
    }
  },

  /* -------------------------------------------------------------------------
   * Native screen capture
   * ----------------------------------------------------------------------- */

  /**
   * Capture a native JPEG frame using Electron desktopCapturer.
   *
   * This avoids navigator.mediaDevices.getDisplayMedia()
   * for SARA's screenshot/vision pipeline.
   */
  captureScreenFrame: async (
    options: ScreenCaptureOptions = {},
  ): Promise<ScreenCaptureResult> => {
    try {
      const opts: ScreenCaptureOptions = {
        sourceId:
          typeof options.sourceId === 'string'
            ? options.sourceId
            : undefined,

        quality: clamp(
          options.quality,
          10,
          100,
          65,
        ),

        maxWidth: clamp(
          options.maxWidth,
          320,
          1920,
          1280,
        ),
      };

      const result = await ipcRenderer.invoke(
        'sara:screen-capture',
        opts,
      );

      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          error:
            'Invalid response from Electron screen-capture handler.',
        };
      }

      return result;
    } catch (error) {
      const message = errorMessage(error);

      console.error(
        '[SARA preload] captureScreenFrame failed:',
        message,
      );

      return {
        ok: false,
        error: message,
      };
    }
  },

  /* -------------------------------------------------------------------------
   * Monitor information
   * ----------------------------------------------------------------------- */

  /**
   * Get all connected monitors.
   */
  getScreenMonitors: async (): Promise<MonitorResult> => {
    try {
      const result = await ipcRenderer.invoke(
        'sara:screen-monitors',
      );

      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          monitors: [],
          error:
            'Invalid response from Electron monitor handler.',
        };
      }

      return result;
    } catch (error) {
      const message = errorMessage(error);

      console.error(
        '[SARA preload] getScreenMonitors failed:',
        message,
      );

      return {
        ok: false,
        monitors: [],
        error: message,
      };
    }
  },

  /* -------------------------------------------------------------------------
   * Screen capture permission/availability
   * ----------------------------------------------------------------------- */

  /**
   * Check whether Electron can obtain screen sources and pixels.
   */
  checkScreenPermission: async (): Promise<PermissionResult> => {
    try {
      const result = await ipcRenderer.invoke(
        'sara:screen-permission-check',
      );

      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          sourcesFound: 0,
          thumbnailOk: false,
          message:
            'Invalid response from Electron permission handler.',
        };
      }

      return result;
    } catch (error) {
      const message = errorMessage(error);

      console.error(
        '[SARA preload] checkScreenPermission failed:',
        message,
      );

      return {
        ok: false,
        sourcesFound: 0,
        thumbnailOk: false,
        message,
        error: message,
      };
    }
  },
});

/* ---------------------------------------------------------------------------
 * Preload startup diagnostic
 * ------------------------------------------------------------------------- */

console.log(
  `[SARA preload] Loaded successfully — Electron ${process.versions.electron}, platform ${process.platform}`,
);
```
