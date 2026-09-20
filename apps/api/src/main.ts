/**
 * Точка входа API-сервера на NestJS.
 *
 * Запускается только при прямом вызове файла (`node dist/nest/main.js`):
 * импорт модуля в тестах не должен поднимать слушающий сокет.
 */

import { pathToFileURL } from 'node:url';
import { startServer } from './bootstrap.js';

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startServer().catch((err: unknown) => {
    console.error('[main] Не удалось запустить сервер:', err);
    process.exit(1);
  });
}
