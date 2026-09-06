import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Базовый путь сайта. Для GitHub Pages сборка идёт с VITE_BASE=/football-tv/,
// иначе index.html будет ссылаться на /assets/… в корне домена.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  root: 'web',
  base,
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
});
