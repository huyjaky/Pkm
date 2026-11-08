import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// mGBA-wasm needs SharedArrayBuffer -> the page must be cross-origin isolated.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@thenick775/mgba-wasm'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: {
    headers: isolation,
    proxy: {
      '/api': backend,
      '/game': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { headers: isolation },
});
