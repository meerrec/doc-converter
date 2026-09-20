import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Адрес API-сервера для прокси в режиме разработки.
 *
 * Прокси выбран вместо опоры на CORS: в production CORS у API выключен
 * (он включается только при NODE_ENV=development), а через прокси запросы
 * уходят с того же origin в обоих режимах — код путей одинаковый.
 */
const API_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

/** Пути, которые обслуживает API и которые нужно проксировать. */
const API_ROUTES = ['/convert', '/health'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_ROUTES.map((route) => [route, { target: API_TARGET }])
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
