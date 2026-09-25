/**
 * Плагин dev-сервера для файлов браузерной конвертации.
 *
 * В проде их отдаёт nginx: сборку LibreOffice — из `/opt/app-root/src/lowa`,
 * мост — как отдельный скрипт. В dev-режиме этого нет, и плагин заменяет
 * недостающее: раздаёт `apps/web/lowa/assets` по `/lowa/` и собирает мост
 * тем же конфигом, что и продакшн-сборка.
 *
 * **Заголовки изоляции здесь не выдаются.** Они заданы в `server.headers`
 * (`vite.config.ts`) и означают ровно то же, что локация документа в nginx:
 * изоляцию документа. Раздача отсюда — файл сборки и мост — отвечает своими
 * заголовками, без изоляции; на подресурсах `COOP` и `COEP` браузер
 * игнорирует, и навешивать их здесь было бы только расхождением с продом.
 *
 * Все комментарии на русском языке.
 */

import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin, ViteDevServer } from 'vite';
import { respondText } from './http.ts';
import { LOWA_PATH, MISSING_BUILD_HINT, lowaAssetsMiddleware } from './lowa-assets.ts';

/**
 * Каталог веб-приложения.
 *
 * Через `import.meta.url`, а не `process.cwd()`: относительные пути и Vite,
 * и вложенная сборка моста отсчитывают от рабочего каталога процесса,
 * а он зависит от того, откуда запущен сервер.
 */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Скачанная сборка LibreOffice.
 *
 * Тот же каталог, который копирует в образ `apps/web/Dockerfile`.
 */
const LOWA_DIR = path.join(APP_DIR, 'lowa', 'assets');

/** Файлы, без которых сборка не запустится (остальные — сжатые копии для nginx). */
const LOWA_REQUIRED_FILES = ['soffice.js', 'soffice.wasm', 'soffice.data'];

/**
 * Конфигурация моста — единственный источник его настроек.
 *
 * Формат сборки (IIFE, а не модуль), имя файла и выключенная минификация заданы
 * там, и повторять их здесь значило бы завести вторую копию: разойдясь, копии
 * дали бы мост, который страница не загрузит, — а отказ этот виден не сразу
 * (см. `bridgeMiddleware`).
 */
const BRIDGE_CONFIG = path.join(APP_DIR, 'vite.bridge.config.ts');

/**
 * Исходники моста: по ним ловятся правки, требующие пересборки.
 *
 * Мост живёт в пакете движка (`packages/office/src/bridge`), а собирает его
 * приложение — поэтому путь ведёт наружу из каталога веб-приложения.
 */
const BRIDGE_SOURCE_DIR = fileURLToPath(new URL('../../../packages/office/src/bridge', import.meta.url)) + path.sep;

/** Имя файла с мостом — его просит страница (`LocalApp.tsx`). */
export const BRIDGE_FILE_NAME = 'bridge.js';

/**
 * Создаёт плагин dev-сервера.
 *
 * @returns плагин для секции `plugins` в конфигурации
 */
export function officeDev(): Plugin {
  return {
    name: 'doc-converter:office-dev',
    // Плагин существует только для режима разработки: сборка страницы
    // обходится без него — там всё то же самое делает nginx
    apply: 'serve',

    configureServer(server) {
      const base = server.config.base;

      warnIfBuildMissing(server);

      server.middlewares.use(
        lowaAssetsMiddleware({
          assetsDir: LOWA_DIR,
          urlPrefix: base + LOWA_PATH,
          logger: server.config.logger,
        })
      );

      server.middlewares.use(bridgeMiddleware(server, base + BRIDGE_FILE_NAME));
    },
  };
}

/**
 * Предупреждает при старте, если сборки на диске нет.
 *
 * Проверка при старте, а не при первом обращении: без неё отсутствие сборки
 * обнаружилось бы только в браузере — отказом загрузки на сотни мегабайт
 * и без внятного объяснения (страница сообщит «сервер ответил 404»).
 *
 * @param server - dev-сервер
 */
function warnIfBuildMissing(server: ViteDevServer): void {
  const missing = LOWA_REQUIRED_FILES.filter((name) => !existsSync(path.join(LOWA_DIR, name)));

  if (missing.length > 0) {
    server.config.logger.warn(
      `[office-dev] нет файлов сборки LibreOffice (${missing.join(', ')}): ` +
        `страница откроется, но офис не запустится. ${MISSING_BUILD_HINT}`
    );
  }
}

/**
 * Создаёт middleware моста.
 *
 * Мост — скрипт, который сборка LibreOffice исполняет в своём воркере через
 * `importScripts`, поэтому модулем он быть не может: в проде его собирает
 * отдельная конфигурация (`vite.bridge.config.ts`) в IIFE. Здесь та же
 * конфигурация вызывается в память — `write: false` оставляет `dist/local`
 * нетронутым, чтобы режим разработки не менял результат сборки приложения.
 *
 * Сборка отложена до первого запроса: ошибка в мосте не должна мешать
 * поднимать страницу, а правят мост как раз с ошибками.
 *
 * @param server - dev-сервер (наблюдение за файлами и лог)
 * @param bridgeUrl - адрес, по которому страница просит мост
 * @returns обработчик для `server.middlewares`
 */
function bridgeMiddleware(
  server: ViteDevServer,
  bridgeUrl: string
): Connect.NextHandleFunction {
  let pending: Promise<string> | null = null;

  const invalidate = (file: string): void => {
    if (file.startsWith(BRIDGE_SOURCE_DIR) || file === BRIDGE_CONFIG) {
      pending = null;
    }
  };

  server.watcher.on('change', invalidate);
  server.watcher.on('add', invalidate);
  server.watcher.on('unlink', invalidate);

  // Конфигурация моста лежит вне корня страницы, и сама по себе в наблюдение
  // не попадает: без этой строки её правка не пересобрала бы мост
  server.watcher.add(BRIDGE_CONFIG);

  return (req, res, next) => {
    if (pathOf(req.url) !== bridgeUrl) {
      next();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondText(res, 405, 'мост отдаётся только по GET и HEAD');
      return;
    }

    // Сборка начинается один раз на версию исходников: страница перезагружается
    // часто, и каждый запрос собирал бы мост заново
    pending ??= compileBridge(server).catch((error: unknown) => {
      // Отказ сбрасывает кеш: иначе опечатка залипла бы до перезапуска сервера
      pending = null;
      throw error;
    });

    pending.then(
      (code) => respondBridge(req, res, code),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        server.config.logger.error(`[office-dev] мост не собрался: ${message}`);
        respondText(res, 500, `мост не собрался: ${message}`);
      }
    );
  };
}

/**
 * Собирает мост в память.
 *
 * @param server - dev-сервер (для записи в лог)
 * @returns код моста
 */
async function compileBridge(server: ViteDevServer): Promise<string> {
  // Импорт по требованию: на верхнем уровне он тянул бы сборщик в момент
  // чтения конфигурации, то есть всегда, а нужен он только при первом запросе
  const { build } = await import('vite');
  const startedAt = Date.now();

  const result = await build({
    // Пути только абсолютные: и конфигурацию, и корень Vite отсчитывает
    // от рабочего каталога процесса, а он зависит от того, откуда запущен сервер
    configFile: BRIDGE_CONFIG,
    root: APP_DIR,
    logLevel: 'warn',
    build: { write: false },
  });

  const code = bridgeCode(result);

  server.config.logger.info(`[office-dev] мост собран за ${Date.now() - startedAt} мс`);

  return code;
}

/**
 * Форма чанка в результате сборки.
 *
 * Описана здесь, а не импортирована: `vite` не экспортирует тип результата
 * сборки, а взять его напрямую из `rolldown` нельзя — это не наша зависимость,
 * и строгая раскладка pnpm такого импорта не разрешит.
 */
interface BuiltChunk {
  readonly type: string;
  readonly isEntry: boolean;
  readonly fileName: string;
  readonly code: string;
}

/** Результат сборки библиотеки в память. */
interface BuiltOutput {
  readonly output?: readonly BuiltChunk[];
}

/**
 * Достаёт код моста из результата сборки.
 *
 * @param result - результат `build()` с `write: false`
 * @returns код моста
 */
function bridgeCode(result: unknown): string {
  const outputs = (Array.isArray(result) ? result : [result]) as readonly BuiltOutput[];

  for (const output of outputs) {
    for (const chunk of output.output ?? []) {
      if (chunk.type !== 'chunk' || !chunk.isEntry) {
        continue;
      }

      // Имя сверяется, а не принимается на веру: его задаёт конфигурация моста,
      // а просит страница. Разойдясь, они дали бы 404 внутри воркера офиса,
      // где сообщение почти не видно: снаружи это выглядит как «офис
      // не запустился за 120 секунд» из `boot.ts`
      if (chunk.fileName !== BRIDGE_FILE_NAME) {
        throw new Error(
          `мост собрался в ${chunk.fileName}, а страница просит ${BRIDGE_FILE_NAME}`
        );
      }

      return chunk.code;
    }
  }

  throw new Error('сборка моста не вернула входной чанк');
}

/**
 * Отдаёт собранный код моста.
 *
 * @param req - запрос
 * @param res - ответ
 * @param code - код моста
 */
function respondBridge(req: Connect.IncomingMessage, res: ServerResponse, code: string): void {
  const body = Buffer.from(code, 'utf8');

  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': String(body.byteLength),
    // Имя постоянное, содержимое меняется при каждой правке — как и в nginx,
    // где эта локация тоже отдаётся без длинного кеша
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(body);
}

/**
 * Отбрасывает строку параметров и якорь у адреса запроса.
 *
 * @param url - адрес запроса
 * @returns путь
 */
function pathOf(url: string | undefined): string {
  return (url ?? '').split(/[?#]/)[0] ?? '';
}
