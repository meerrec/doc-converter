/**
 * Раздача сборки LibreOffice (LOWA) в dev-режиме.
 *
 * В проде эту роль играет nginx: файлы лежат в образе рядом со страницей
 * (`/opt/app-root/src/local/lowa`), и локация `/local/lowa/` отдаёт их
 * с `gzip_static` и годовым кешем. В dev-режиме nginx нет, а файлы — те же
 * самые: их читает прямо из `apps/web/lowa/assets`, каталога, который
 * в образ копирует `apps/web/Dockerfile`.
 *
 * Три правила, которые определяют поведение раздачи:
 *
 * - **под своим префиксом middleware отвечает сам и никогда не зовёт
 *   `next()`**. Иначе в дело вступит SPA-fallback Vite, и пропавший wasm
 *   вернётся страницей с кодом 200: страница не увидит `!response.ok`,
 *   а сборка упадёт на компиляции модуля с невнятным сообщением;
 * - **`Content-Length` отдаётся всегда** — по нему страница считает прогресс
 *   загрузки (`src/local/lowa/preload.ts`). Без заголовка полоса покажет
 *   только объём полученного, без общего;
 * - **сжатие не эмулируется**. `gzip_static` — свойство прод-раздачи:
 *   в образе рядом с распакованными файлами лежат их `.gz`-копии, и отдаются
 *   именно они. В dev на localhost экономить нечего, а прогресс без сжатия
 *   честнее: `content-length` описывает ровно то, что скачивает страница.
 *
 * Все комментарии на русском языке.
 */

import { createReadStream, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Connect } from 'vite';
import { respondText } from './http.ts';

/** Сегмент пути, по которому страница просит файлы сборки (`LocalApp.tsx`). */
export const LOWA_PATH = 'lowa/';

/**
 * Что сказать, если файла нет.
 *
 * Сборка в репозитории не хранится (около 250 МБ), и её отсутствие — ошибка
 * окружения, а не обращение к несуществующему адресу: подсказка обязана
 * называть команду, которая это лечит.
 */
export const MISSING_BUILD_HINT =
  'файла сборки нет: выполните `node apps/web/lowa/fetch.mjs`';

/**
 * Типы содержимого по расширению — то, что в проде делает nginx по `mime.types`.
 *
 * `.wasm` важен не формальностью: с другим типом Emscripten отказывается
 * от потоковой компиляции (`instantiateStreaming`) и уходит на медленный путь,
 * сообщая об этом лишь предупреждением в консоли. `.js` обязателен из-за
 * `nosniff`: и `soffice.js` (тег `<script>`), и мост (`importScripts` в воркере)
 * грузятся как скрипты, и неверный тип — жёсткий отказ, а не предупреждение.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.gz': 'application/gzip',
};

/**
 * Подбирает тип содержимого по имени файла.
 *
 * Всё, чего нет в таблице, отдаётся потоком байт — так же поступает nginx
 * с неизвестным расширением. Для `.data` и `.metadata` это и есть верный
 * ответ: страница всё равно пересобирает их в объект в памяти со своим типом.
 *
 * @param name - имя файла сборки
 * @returns тип содержимого
 */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Файл сборки, найденный по адресу запроса. */
export interface LowaAsset {
  /** Имя файла (оно же — остаток адреса запроса). */
  readonly name: string;
  /** Путь файла в файловой системе. */
  readonly filePath: string;
  /** Тип содержимого для ответа. */
  readonly contentType: string;
}

/**
 * Находит файл сборки по адресу запроса.
 *
 * Имя приходит из адреса, то есть от кого угодно, и проверяется целиком,
 * а не «нормализуется»: в сборке вендора подкаталогов нет, файлы лежат плоско,
 * поэтому запрет разделителей пути закрывает выход за каталог независимо
 * от того, как этот выход закодирован.
 *
 * @param assetsDir - каталог сборки (абсолютный путь)
 * @param urlPath - адрес запроса без префикса раздачи
 * @returns найденный файл или `null`, если имя недопустимо
 */
export function resolveLowaAsset(assetsDir: string, urlPath: string): LowaAsset | null {
  // Строка параметров и якорь к имени файла не относятся: сборка запрашивает
  // файлы как есть, но браузер или отладчик может добавить к адресу своё
  const raw = urlPath.split(/[?#]/)[0] ?? '';

  let name: string;

  try {
    // Процентная кодировка разбирается до проверок: `%2e%2e%2f` — это `../`,
    // и проверять её в закодированном виде значило бы пропустить выход
    name = decodeURIComponent(raw);
  } catch {
    // Битая последовательность вроде `%zz` — не имя файла
    return null;
  }

  if (name === '' || name === '.' || name === '..') {
    return null;
  }

  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return null;
  }

  const filePath = path.join(assetsDir, name);

  // Второй рубеж на случай, если запрет выше ослабят: путь обязан остаться
  // внутри каталога сборки
  if (!filePath.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return { name, filePath, contentType: contentTypeFor(name) };
}

/** Что нужно раздаче сборки. */
export interface LowaAssetsOptions {
  /** Каталог сборки. */
  readonly assetsDir: string;
  /** Префикс адресов, которые она обслуживает (`base` страницы + `lowa/`). */
  readonly urlPrefix: string;
  /** Куда сообщать о сбоях чтения. */
  readonly logger: { error(message: string): void };
}

/**
 * Создаёт middleware раздачи сборки.
 *
 * @param options - каталог сборки, префикс адресов и логгер
 * @returns обработчик для `server.middlewares`
 */
export function lowaAssetsMiddleware(options: LowaAssetsOptions): Connect.NextHandleFunction {
  const assetsDir = path.resolve(options.assetsDir);

  return (req, res, next) => {
    const url = req.url ?? '';

    // Чужой адрес — не наше дело, дальше обычная раздача Vite
    if (!url.startsWith(options.urlPrefix)) {
      next();
      return;
    }

    // А под своим префиксом отвечаем только мы: `next()` здесь означал бы
    // оболочку страницы вместо файла и 200 вместо 404
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondText(res, 405, 'сборка отдаётся только по GET и HEAD');
      return;
    }

    const asset = resolveLowaAsset(assetsDir, url.slice(options.urlPrefix.length));

    if (asset === null) {
      respondText(res, 400, 'недопустимое имя файла сборки');
      return;
    }

    const stats = statSync(asset.filePath, { throwIfNoEntry: false });

    if (stats === undefined || !stats.isFile()) {
      respondText(res, 404, MISSING_BUILD_HINT);
      return;
    }

    sendAsset(req, res, asset, stats, options.logger);
  };
}

/**
 * Отдаёт найденный файл сборки.
 *
 * Кеш — `no-cache` с `ETag`, а не годовой `immutable` из прод-раздачи: там имя
 * файла защищено контрольными суммами и версией сборки, а здесь под тем же
 * именем после повторного `fetch.mjs` окажется другое содержимое, и годовой
 * кеш вернул бы старое. С `ETag` повторная отдача стоит одного запроса с кодом
 * 304, а это заметно: файлы сборки весят 154 МБ и 95 МБ, и страница в dev
 * перезагружается часто.
 *
 * @param req - запрос
 * @param res - ответ
 * @param asset - найденный файл
 * @param stats - сведения о файле
 * @param logger - куда сообщать о сбоях чтения
 */
function sendAsset(
  req: Connect.IncomingMessage,
  res: ServerResponse,
  asset: LowaAsset,
  stats: Stats,
  logger: { error(message: string): void }
): void {
  // Размер и время изменения: содержимое меняется только вместе с ними
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;

  const headers = {
    'Content-Type': asset.contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(stats.size) });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(asset.filePath);

  stream.on('error', (error: Error) => {
    logger.error(`[local-dev] чтение ${asset.name}: ${error.message}`);

    // Заголовки уже отправлены — ответ обрывается, а не переписывается
    res.destroy();
  });

  stream.pipe(res);
}
