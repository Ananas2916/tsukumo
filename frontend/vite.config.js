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
    // public/ contiene solo l'avatar e le clip dell'utente, con licenze loro:
    // il backend le serve da li' (/models, /animations). Copiarle in dist le
    // farebbe finire nei pacchetti e nell'installer.
    copyPublicDir: false,
    target: 'es2022',
    // three.js + three-vrm superano i 500 kB: alziamo la soglia per non
    // riempire il log di warning inutili.
    chunkSizeWarningLimit: 1500,
    // Tre pagine: il personaggio e il pannello (chat + impostazioni) di Electron,
    // e la chat solo testo per il telefono (backend/phone.py).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./mobile.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // In sviluppo il frontend gira su 5173 e inoltra API e WebSocket al backend.
    // Host e Origin restano quelli della pagina (localhost:5173): per il
    // backend e' la stessa origine, quindi niente eccezioni in security.py.
    proxy: {
      '/api': { target: BACKEND },
      '/ws': { target: BACKEND, ws: true },
    },
  },
});
