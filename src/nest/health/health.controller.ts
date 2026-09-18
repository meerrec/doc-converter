/**
 * Проверка доступности сервиса: GET /health.
 *
 * Ответ остаётся дословно таким же, как в Express-версии: `wasm` здесь всегда
 * `true`, потому что реальная проверка готовности WASM требует загрузки десятков
 * мегабайт ассетов и инициализации движка — это слишком дорого для проверки,
 * запускаемой каждые 30 секунд. Готовность движка проверяет docker healthcheck
 * (`src/api/health-check.js`) по доступности Valkey и наличию пакета конвертера.
 */

import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@doc-converter/contract';
import { CONVERTER_VERSION } from '../../config/index.js';

/** Маршрут проверки доступности. */
@Controller('health')
export class HealthController {
  /**
   * @returns состояние сервиса, готовность WASM и версия конвертера
   */
  @Get()
  check(): HealthResponse {
    const wasmReady = true;

    return {
      status: wasmReady ? 'ok' : 'initializing',
      wasm: wasmReady,
      version: CONVERTER_VERSION,
    };
  }
}
