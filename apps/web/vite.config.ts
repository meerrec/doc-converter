import { fileURLToPath } from 'node:url';
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

/**
 * Конфигурация страницы конвертера: серверный маршрут и браузерный — на одном
 * документе, потому что пользователь выбирает не место работы, а способ
 * для конкретного файла.
 *
 * Браузерный движок (BetterOffice) попадает в сборку как динамический чанк
 * с wasm-ассетами: отдельных файлов для раздачи нет, и dev-сервер отдаёт
 * их так же, как остальные ассеты Vite.
 */
export default defineConfig({
  plugins: [react()],

  // Абсолютный путь, а не умолчание: корень Vite отсчитывает от рабочего
  // каталога процесса, и запуск сервера (или сборки) не из `apps/web` увёл бы
  // его мимо `index.html`
  root: fileURLToPath(new URL('.', import.meta.url)),

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
