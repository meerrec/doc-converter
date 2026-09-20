/**
 * Версия сервиса.
 *
 * Читается из корневого `package.json`, а не из `npm_package_version`:
 * переменная заполняется только при запуске через npm/pnpm-скрипт, а при
 * прямом `node apps/api/dist/main.js` (так работает CMD в Dockerfile)
 * в окружении может оказаться значение от постороннего пакета.
 *
 * Путь `../../../package.json` одинаков для `src/` и для `dist/`: оба лежат
 * на одном уровне под `apps/api/`, поэтому сборка не меняет разрешение.
 * Раньше константа жила в общем конфиге, но из `packages/config` этот путь
 * указал бы в `packages/`, а нужна она только API — заголовку ответа
 * и `/health`.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Версия сервиса. */
export const CONVERTER_VERSION: string = (() => {
  try {
    const pkg = require('../../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
