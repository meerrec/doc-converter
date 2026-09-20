/**
 * Проверка доступности сервиса: GET /health.
 *
 * Ответ быстрый и не поднимает LibreOffice: готовность конвертера проверяет
 * healthcheck контейнера-воркера, который подключается к UNO-бриджу
 * (`uno-healthcheck.ts`). Здесь проверяется только хранилище — то, без чего
 * API не примет ни одной задачи.
 */

import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@doc-converter/contract';
import { CONVERTER_VERSION } from '../../config/index.js';
import { checkStorageHealth } from '../../storage/s3.js';

/** Маршрут проверки доступности. */
@Controller('health')
export class HealthController {
  /**
   * @returns состояние сервиса, доступность хранилища и версия
   */
  @Get()
  async check(): Promise<HealthResponse> {
    const storage = await checkStorageHealth();

    return {
      status: storage.healthy ? 'ok' : 'degraded',
      storage: storage.healthy,
      version: CONVERTER_VERSION,
    };
  }
}
