/**
 * Контракт маршрута GET /health.
 */

import { z } from 'zod';

/**
 * Ответ проверки доступности.
 *
 * `wasm` сейчас всегда true: сервер объявляет готовность константой
 * (`const wasmReady = true; // TODO` в `api/server.js`), реальная проверка
 * WASM не выполняется — она требует загрузки десятков мегабайт ассетов.
 */
export const healthResponseSchema = z.looseObject({
  status: z.string(),
  wasm: z.boolean(),
  version: z.string(),
});

/** Ответ проверки доступности. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;
