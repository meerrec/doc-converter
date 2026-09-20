/**
 * Скрипт проверки здоровья API.
 *
 * Используется Docker healthcheck (`HEALTHCHECK` в Dockerfile.api и сервис
 * `api` в docker-compose.yml) — запускается как обычный процесс и завершается
 * кодом 0 или 1, а не поднимает сервер.
 *
 * Проверяет две зависимости, без которых сервис не работает:
 * - Valkey/Redis — очередь и состояние задач;
 * - объектное хранилище и наличие бакета — входные файлы и результаты.
 *
 * Готовность LibreOffice здесь не проверяется: конвертация идёт в отдельных
 * контейнерах-воркерах, у них свой healthcheck (`uno-healthcheck.ts`).
 */

import { checkRedisHealth, closeRedisClient } from '@doc-converter/queue';
import { checkStorageHealth } from '@doc-converter/storage';

/**
 * Завершает процесс, закрывая соединение с Valkey.
 *
 * Проверка запускается каждые 30 секунд отдельным процессом, поэтому
 * `process.exit` без закрытия оставлял бы соединение на стороне Valkey
 * до истечения TCP-таймаутов — при нескольких репликах это копящиеся
 * сессии от каждого healthcheck'а.
 *
 * @param code - код завершения
 */
async function exitWith(code: number): Promise<never> {
  await closeRedisClient();
  process.exit(code);
}

/**
 * Выполняет проверки и завершает процесс соответствующим кодом.
 */
async function runHealthCheck(): Promise<void> {
  try {
    const redisHealth = await checkRedisHealth();

    if (!redisHealth.healthy) {
      console.error('Valkey недоступен:', redisHealth.error);
      await exitWith(1);
    }

    const storageHealth = await checkStorageHealth();

    if (!storageHealth.healthy) {
      console.error('Хранилище недоступно:', storageHealth.error);
      await exitWith(1);
    }

    console.log('Health check passed');
    await exitWith(0);
  } catch (err) {
    console.error('Health check failed:', (err as Error).message);
    await exitWith(1);
  }
}

void runHealthCheck();
