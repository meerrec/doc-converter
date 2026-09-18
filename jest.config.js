/**
 * Конфигурация Jest для ESM-проекта.
 *
 * Проект использует "type": "module", поэтому:
 * - transform отключён (Jest не должен транспилировать ESM в CJS)
 * - сам Jest запускается с NODE_OPTIONS=--experimental-vm-modules
 *
 * Все комментарии на русском языке.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Каталог пакета rxjs.
 *
 * Нужен, чтобы принудительно направить Jest в CJS-сборку: см. комментарий
 * к moduleNameMapper ниже.
 */
const rxjsDir = path.dirname(require.resolve('rxjs/package.json'));

export default {
  testEnvironment: 'node',

  // ESM: Jest не транспилирует файлы, Node делает это сам
  transform: {},

  /**
   * Принудительное разрешение rxjs в CJS-сборку.
   *
   * У rxjs карта экспорта: `node` → CJS, `es2015` → ESM, `default` → esm5.
   * Node применяет условие `node` и получает CommonJS. Jest это условие
   * не учитывает и добирается до `default` — сборки esm5, которую не умеет
   * разбирать без транспиляции и падает на `export` в первой же строке.
   *
   * Прямое сопоставление снимает вопрос. Правка временная: на этапе перехода
   * на Vitest (этап 5) она не понадобится — Vitest разрешает модули как Node.
   */
  moduleNameMapper: {
    '^rxjs$': path.join(rxjsDir, 'dist/cjs/index.js'),
    '^rxjs/operators$': path.join(rxjsDir, 'dist/cjs/operators/index.js'),
  },

  // Тесты лежат в tests/
  testMatch: ['**/tests/**/*.test.js'],

  // Игнорируем node_modules
  testPathIgnorePatterns: ['/node_modules/'],

  // Таймаут на тест (zip-бомбы собираются небыстро)
  testTimeout: 30000,
};
