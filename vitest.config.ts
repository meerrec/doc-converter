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

import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Ссылка на исходники пакета.
 *
 * @param path - путь к `src/index.ts` относительно корня репозитория
 * @returns абсолютный путь
 */
const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Пакеты workspace резолвятся в свои **исходники**, а не в собранный `dist`.
     *
     * Без этого тесты требовали бы предварительной сборки: импорт
     * `@doc-converter/config` из проверяемого кода пошёл бы по `main`
     * в `dist/index.js`, которого до `pnpm -r build` не существует. Тесты
     * намеренно читают исходники — так прогон остаётся быстрым и не зависит
     * от того, собирали ли проект перед ним.
     */
    alias: {
      '@doc-converter/config': src('./packages/config/src/index.ts'),
      '@doc-converter/contract': src('./packages/contract/src/index.ts'),
      '@doc-converter/observability': src('./packages/observability/src/index.ts'),
      '@doc-converter/queue': src('./packages/queue/src/index.ts'),
      '@doc-converter/storage': src('./packages/storage/src/index.ts'),
    },
  },

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
