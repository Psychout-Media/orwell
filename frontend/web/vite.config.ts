/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const classicDir = fileURLToPath(new URL('../static/js', import.meta.url));
const uiStub = fileURLToPath(new URL('./src/markdown/classicUiStub.ts', import.meta.url));

// The classic client's markdown.js is the ONE source of truth for the public-bubble wall (reasoning,
// engine-machinery and OOC scrubs, speaker chips). /play imports it instead of keeping a second copy.
// Its only heavy import, ui.js (the DOM kit), is replaced by a 3-line stub that provides `esc`.
function classicMarkdownUiStub(): Plugin {
  return {
    name: 'classic-markdown-ui-stub',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './ui.js' && importer && importer.replace(/\\/g, '/').endsWith('/static/js/markdown.js')) return uiStub;
      return null;
    },
  };
}

// The app is served by FastAPI under /play (see frontend/routes/play_routes.py). Hashed assets live
// under /play/assets/ so the server can give them a long cache and keep index.html no-cache.
export default defineConfig({
  base: '/play/',
  plugins: [classicMarkdownUiStub(), react()],
  resolve: { alias: { '@classic': classicDir } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 400,
  },
  server: {
    fs: { allow: ['..'] },
    // `npm run dev` proxies the API to a locally running Orwell front end.
    proxy: { '/api': { target: process.env.ORWELL_DEV_TARGET ?? 'http://127.0.0.1:7000', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
