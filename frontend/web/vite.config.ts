/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served by FastAPI under /play (see frontend/routes/play_routes.py). Hashed assets live
// under /play/assets/ so the server can give them a long cache and keep index.html no-cache.
export default defineConfig({
  base: '/play/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 400,
  },
  server: {
    // `npm run dev` proxies the API to a locally running Orwell front end.
    proxy: { '/api': { target: process.env.ORWELL_DEV_TARGET ?? 'http://127.0.0.1:7000', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
