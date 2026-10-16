import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import type {IncomingMessage} from 'node:http';
import {defineConfig} from 'vite';
import {isPrivateStaticPath} from './src/security/privateStaticPaths';

export default defineConfig(() => {
  const previewHost = process.env.SARA_PREVIEW_HOST?.trim();
  const apiProxyTarget = process.env.SARA_UI_API_PROXY_TARGET?.trim();
  if (apiProxyTarget && !previewHost) {
    throw new Error('Set SARA_PREVIEW_HOST to an exact hostname when enabling the UI API proxy.');
  }
  const liveProxy = apiProxyTarget && previewHost
    ? {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
        bypass: (request: IncomingMessage): false | void => {
          try {
            const requestHostname = request.headers.host
              ? new URL(`http://${request.headers.host}`).hostname.toLowerCase().replace(/\.$/, '')
              : '';
            const origin = request.headers.origin;
            if (typeof origin !== 'string' || requestHostname !== previewHost.toLowerCase()) return false;
            const parsedOrigin = new URL(origin);
            const safeProtocol = parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:';
            return safeProtocol && parsedOrigin.hostname.toLowerCase() === previewHost.toLowerCase()
              ? undefined
              : false;
          } catch {
            return false;
          }
        },
      }
    : undefined;
  const proxy = apiProxyTarget
    ? {
        '/api': { target: apiProxyTarget, changeOrigin: true },
        ...(liveProxy ? { '/live': liveProxy } : {}),
      }
    : undefined;

  return {
    plugins: [react(), tailwindcss(), {
      name: 'sara-private-runtime-files',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!isPrivateStaticPath(request.url || '/')) return next();
          response.statusCode = 403;
          response.end('Private runtime files are not served.');
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!isPrivateStaticPath(request.url || '/')) return next();
          response.statusCode = 403;
          response.end('Private runtime files are not served.');
        });
      },
    }],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // In Vite 6 the WebSocket server is separate from HMR; disable both in
      // preview mode so middleware-mode startup does not open port 24678.
      ...(process.env.DISABLE_HMR === 'true' ? { ws: false as const } : {}),
      ...(previewHost ? { allowedHosts: [previewHost] } : {}),
      ...(proxy ? { proxy } : {}),
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // When watching is enabled, ignore datastore JSON files that are updated
      // at runtime so the browser doesn't reload during memory/agent actions.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: [
                '**/data/**',
                '**/conversations.json',
                '**/conversations_*.json',
                '**/conversations_mobile.json',
                '**/sessions.json',
                '**/memories.json',
                '**/tool_calls.json',
                '**/settings.json',
              ],
            },
    },
  };
});
