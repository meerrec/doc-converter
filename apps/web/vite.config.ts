import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { officeDev } from './dev/office-dev.ts';

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
 * Сборка одна: сборку LibreOffice и мост к ней собирает тот же `vite`, что
 * и страницу (`vite.bridge.config.ts`), а файлы вендорской сборки кладёт
 * в образ Dockerfile. Файлов браузерной конвертации в dev-режиме нет вовсе,
 * и их раздачу заменяет плагин `dev/office-dev.ts` — в проде то же самое
 * делает nginx.
 *
 * Заголовки изоляции стоят здесь, а не в отдельном конфиге: `SharedArrayBuffer`
 * нужен сборке, а документ у страницы один. Значения обязаны совпадать
 * с локацией документа в `nginx.conf` — совпадение проверяет
 * `tests/office-dev.test.js`, потому что расхождение видно только в браузере
 * и только в одном из двух режимов.
 */
export default defineConfig({
  plugins: [react(), officeDev()],

  // Абсолютный путь, а не умолчание: корень Vite отсчитывает от рабочего
  // каталога процесса, и запуск сервера (или сборки) не из `apps/web` увёл бы
  // его мимо `index.html`
  root: fileURLToPath(new URL('.', import.meta.url)),

  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_ROUTES.map((route) => [route, { target: API_TARGET }])
    ),

    // Заголовки изоляции документа: без них браузер не даёт `SharedArrayBuffer`,
    // и сборка, собранная с pthread, не стартует вовсе. На подресурсах они
    // инертны, поэтому раздача файлов сборки и моста (`dev/office-dev.ts`)
    // своих заголовков изоляции не добавляет
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
