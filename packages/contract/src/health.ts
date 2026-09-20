/**
 * Контракт маршрута GET /health.
 */

import { z } from 'zod';

/**
 * Ответ проверки доступности.
 *
 * `storage` — доступность объектного хранилища (MinIO/S3). Проверка дешёвая
 * (запрос к сервису), в отличие от готовности конвертера: её проверяет
 * отдельный процесс healthcheck контейнера воркера, подключаясь к UNO.
 */
export const healthResponseSchema = z.looseObject({
  status: z.string(),
  storage: z.boolean(),
  version: z.string(),
});

/** Ответ проверки доступности. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;
