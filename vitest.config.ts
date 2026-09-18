/**
 * Конфигурация Vitest.
 *
 * Заменяет Jest, который работал на ESM без транспиляции и требовал двух
 * обходных путей: `NODE_OPTIONS=--experimental-vm-modules` для запуска
 * и `--forceExit` для завершения процесса с открытыми хендлами. Оба больше
 * не нужны.
 *
 * Тесты читают **исходники** на TypeScript, а не собранный `dist`: сборка перед
 * прогоном (`pretest`) уходит вместе с Jest. Это же снимает `moduleNameMapper`
 * для `rxjs`, который был нужен потому, что Jest не применял условие `node`
 * из карты экспорта пакета.
 */

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    /**
     * Транспиляция через SWC.
     *
     * Нужна не ради TypeScript как такового — его снимает сам Vite, — а ради
     * метаданных декораторов. NestJS разрешает зависимости конструктора через
     * `design:paramtypes`, а esbuild, на котором работает Vite, эту метаинформацию
     * не порождает: без неё внедрение зависимостей в тестах падает.
     *
     * SWC читает `experimentalDecorators` и `emitDecoratorMetadata` из tsconfig.
     */
    swc.vite(),
  ],

  test: {
    environment: 'node',

    // Тесты лежат в tests/
    include: ['tests/**/*.test.js'],

    // Таймаут на тест: zip-бомбы собираются небыстро
    testTimeout: 30000,
  },
});
