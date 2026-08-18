import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The sync agent's canonical source lives inside the component folder (it is
// half of the wire protocol — ADR 0001). It must be served from THIS app's
// origin because it derives HOST_ORIGIN from document.currentScript.src and
// pins postMessage to it. Do NOT copy it into public/ — duplicate copies drift.
const AGENT_PATH = fileURLToPath(
  new URL('./src/components/synced-preview/sync-agent.js', import.meta.url)
);

function serveSyncAgent() {
  return {
    name: 'serve-sync-agent',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/sync-agent.js') return next();
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.end(readFileSync(AGENT_PATH, 'utf8'));
      });
    },
    generateBundle() {
      // Emit unhashed so apps under test can hard-code the URL.
      this.emitFile({
        type: 'asset',
        fileName: 'sync-agent.js',
        source: readFileSync(AGENT_PATH, 'utf8'),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveSyncAgent()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // 'use client' stays in the component for Next.js App Router vendoring.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
});
