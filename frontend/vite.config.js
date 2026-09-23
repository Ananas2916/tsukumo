import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Porta del backend Python (deve combaciare con DC_PORT).
const BACKEND_PORT = process.env.DC_PORT ?? '8770';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  // base relativa: la build funziona sia servita da FastAPI sia da file://
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // three.js + three-vrm superano i 500 kB: alziamo la soglia per non
    // riempire il log di warning inutili.
    chunkSizeWarningLimit: 1500,
    // Due pagine: il personaggio e il pannello (chat + impostazioni) di Electron.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // In sviluppo il frontend gira su 5173 e inoltra API e WebSocket al backend.
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true },
    },
  },
});
