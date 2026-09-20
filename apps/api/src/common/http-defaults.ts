/**
 * Заголовки, CORS и разбор тела запроса.
 *
 * Перенесено из `api/server.js` дословно: переключение на NestJS не должно
 * менять наблюдаемое поведение сервиса.
 */

import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONVERTER_VERSION } from '../version.js';

/**
 * Заголовки безопасности и версии конвертера.
 *
 * Замечание на будущее: `Cross-Origin-Opener-Policy`,
 * `Cross-Origin-Embedder-Policy` и `Cross-Origin-Resource-Policy` появились
 * в расчёте на WASM в браузере (без них не выдаётся `SharedArrayBuffer`),
 * но конвертер работает в Node — в форк-процессе на сервере. Для API это
 * политики уровня документа и пользы не приносят. Поведение сохранено как
 * есть; пересмотреть стоит отдельно, вместе с CSP.
 *
 * @param app - приложение NestJS
 * @param isProduction - включает CSP (как в Express-версии)
 */
export function applySecurityHeaders(
  app: INestApplication,
  isProduction: boolean
): void {
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');

    if (isProduction) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
      );
    }

    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // Результаты конвертации не должны кешироваться
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    res.setHeader('X-Converter-Version', CONVERTER_VERSION);

    next();
  });
}

/**
 * CORS для режима разработки.
 *
 * В production заголовки не выставляются: интерфейс и API живут на одном
 * origin за nginx, поэтому CORS не нужен. Включение только по `NODE_ENV`
 * повторяет поведение Express-версии.
 *
 * @param app - приложение NestJS
 * @param isDevelopment - включает CORS
 */
export function applyCors(app: INestApplication, isDevelopment: boolean): void {
  if (!isDevelopment) {
    return;
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
}

/**
 * Предельный размер JSON-тела запроса в байтах.
 *
 * Файлы приходят в multipart/form-data, который разбирает multer со своим
 * лимитом (MAX_FILE_BYTES). Этот лимит относится к JSON-запросам, которых
 * у сервиса почти нет, поэтому значение небольшое: 1 МиБ с запасом
 * покрывает любой служебный запрос и не даёт держать в памяти лишнее.
 */
export const BODY_LIMIT_BYTES = 1024 * 1024;
