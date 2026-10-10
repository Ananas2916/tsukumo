import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Python backend's port (must match DC_PORT).
const BACKEND_PORT = process.env.DC_PORT ?? '8770';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  // relative base: the build works both served by FastAPI and from file://
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ is not used: nothing to copy (an old checkout may still hold
    // personal files there, and they must never end up in the installer).
    copyPublicDir: false,
    target: 'es2022',
    // three.js exceeds 500 kB: we raise the threshold so as not to fill the
    // log with useless warnings.
    chunkSizeWarningLimit: 1500,
    // Four pages: Tsukumo, the panel (chat + settings) and Electron's
    // dashboard, and the text-only chat for the phone (backend/phone.py).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./mobile.html', import.meta.url)),
        dashboard: fileURLToPath(new URL('./dashboard.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // In development the frontend runs on 5173 and forwards API and WebSocket to the backend.
    // Host and Origin stay those of the page (localhost:5173): for the
    // backend it's the same origin, so no exceptions in security.py.
    proxy: {
      '/api': { target: BACKEND },
      '/ws': { target: BACKEND, ws: true },
    },
  },
});
