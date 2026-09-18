/**
 * Конфигурация Jest для ESM-проекта.
 *
 * Проект использует "type": "module", поэтому:
 * - transform отключён (Jest не должен транспилировать ESM в CJS)
 * - сам Jest запускается с NODE_OPTIONS=--experimental-vm-modules
 *
 * Все комментарии на русском языке.
 */

export default {
  testEnvironment: 'node',

  // ESM: Jest не транспилирует файлы, Node делает это сам
  transform: {},

  // Тесты лежат в tests/
  testMatch: ['**/tests/**/*.test.js'],

  // Игнорируем node_modules
  testPathIgnorePatterns: ['/node_modules/'],

  // Таймаут на тест (zip-бомбы собираются небыстро)
  testTimeout: 30000,
};
