/**
 * Скрипт проверки здоровья сервиса.
 *
 * Используется Docker healthcheck (`HEALTHCHECK` в Dockerfile и сервис `api`
 * в docker-compose.yml) — запускается как обычный процесс и завершается
 * кодом 0 или 1, а не поднимает сервер.
 *
 * Проверяет:
 * - подключение к Valkey
 * - наличие пакета конвертера (WASM-ассеты внутри образа)
 *
 * Полная проверка WASM здесь намеренно не выполняется: она требует загрузки
 * ~48 МБ ассетов и инициализации движка, что слишком дорого для проверки,
 * запускаемой каждые 30 секунд.
 */

import { createRequire } from 'node:module';
import { checkRedisHealth } from '../../queue/connection.js';

const require = createRequire(import.meta.url);

/**
 * Выполняет проверки и завершает процесс соответствующим кодом.
 */
async function runHealthCheck(): Promise<void> {
  try {
    // Проверяем Redis.
    // checkRedisHealth возвращает объект { healthy, error }, а не boolean
    const redisHealth = await checkRedisHealth();

    if (!redisHealth.healthy) {
      console.error('Redis connection failed:', redisHealth.error);
      process.exit(1);
    }

    // Проверяем, что пакет конвертера и его WASM-ассеты на месте
    try {
      require.resolve('@matbee/libreoffice-converter/package.json');
    } catch {
      console.error('Конвертер недоступен: пакет @matbee/libreoffice-converter не найден');
      process.exit(1);
    }

    console.log('Health check passed');
    process.exit(0);
  } catch (err) {
    console.error('Health check failed:', (err as Error).message);
    process.exit(1);
  }
}

void runHealthCheck();
