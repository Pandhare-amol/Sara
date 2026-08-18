import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
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
