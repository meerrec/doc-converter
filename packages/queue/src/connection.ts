/**
 *Подключение к Valkey (Redis-совместимый сервер).
 *
 * Используется для:
 * - Очереди задач (BullMQ)
 * - Идемпотентности (SET NX)
 * - Хранения статусов задач
 *
 * Все комментарии на русском языке.
 */

// Именованный импорт: при `module: NodeNext` TypeScript выводит из default-импорта
// CJS-пакета пространство имён, а не класс, — `new Redis()` и тип `Redis` тогда
// не работают. В рантайме обе формы дают один и тот же класс
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { REDIS_HOST, REDIS_PORT } from '@doc-converter/config';

/**
 * Общие для всех соединений параметры подключения к Valkey.
 *
 * В Docker Compose Valkey доступен по имени сервиса,
 * в production это будет хост из переменных окружения.
 */
const baseConnection: RedisOptions = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  enableReadyCheck: true,
  retryStrategy: (times: number) => {
    // Экспоненциальный бэкофф с ограничением
    const delay = Math.min(Math.pow(2, times) * 100, 5000);
    return delay;
  },
  connectTimeout: 5000,
  keepAlive: 30000
};

/**
 * Конфигурация подключения к Valkey для приложения.
 *
 * `enableOfflineQueue: false` — при обрыве связи команды не копятся в памяти
 * процесса, а сразу отвергаются: неограниченная очередь команд на недоступном
 * Valkey растёт вместе с RSS и превращает недоступность хранилища в OOM самого
 * api. Цена решения — команду нельзя отправить до готовности соединения,
 * поэтому `getRedisClient` дожидается события `ready`.
 *
 * `enableAutoPipelining: true` — команды, отправленные в одном тике event loop,
 * уходят одним round-trip'ом. Соединениям BullMQ его давать нельзя: там
 * блокирующий BZPOPMIN и Lua-скрипты (см. `getRedisConnection`).
 */
export const redisConnection: RedisOptions = {
  ...baseConnection,
  maxRetriesPerRequest: 5,
  enableOfflineQueue: false,
  enableAutoPipelining: true
};

/**
 * Создаёт новый экземпляр Redis клиента.
 *
 * @returns экземпляр ioredis
 */
export function createRedisClient(): Redis {
  return new Redis(redisConnection);
}

/**
 * Общий экземпляр Redis клиента (singleton).
 */
let sharedClient: Redis | null = null;

/**
 * Дожидается готовности соединения.
 *
 * @param client - клиент ioredis
 * @throws {Error} - если подключиться не удалось
 */
async function waitForReady(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.off('ready', onReady);
      client.off('error', onError);
    };

    const onReady = (): void => {
      cleanup();
      resolve();
    };

    // Первая же ошибка подключения отклоняет ожидание: retryStrategy
    // продолжит переподключение в фоне, но запрос ждать его не должен
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * Получает общий Redis клиент.
 * Создаёт его при первом вызове.
 *
 * @returns Redis клиент
 */
export async function getRedisClient(): Promise<Redis> {
  if (!sharedClient) {
    const client = createRedisClient();

    // Обработчик ошибок навешивается до ожидания готовности: ioredis эмитит
    // 'error' и на неудачных попытках переподключения, а событие 'error'
    // без слушателя в Node.js роняет процесс
    client.on('error', (err) => {
      console.error('[redis] Ошибка соединения:', err);
    });

    // Ждём готовности до выдачи клиента: при enableOfflineQueue: false команда,
    // отправленная в состоянии connecting, отвергается, а не встаёт в очередь
    try {
      await waitForReady(client);
    } catch (err) {
      client.disconnect();
      // Причина сохраняется в `cause`: по тексту «не удалось подключиться»
      // не отличить отказ сети от неверного пароля или адреса
      throw new Error(`Не удалось подключиться к Valkey/Redis: ${(err as Error).message}`, {
        cause: err,
      });
    }

    sharedClient = client;

    sharedClient.on('connect', () => {
      console.log('[redis] Подключение установлено');
    });

    sharedClient.on('ready', () => {
      console.log('[redis] Готов к работе');
    });

    sharedClient.on('close', () => {
      console.log('[redis] Соединение закрыто');
    });
  }

  return sharedClient;
}

/**
 * Закрывает общий Redis клиент.
 */
export async function closeRedisClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.disconnect();
    sharedClient = null;
  }
}

/**
 * Возвращает параметры подключения к Valkey (для BullMQ).
 *
 * BullMQ требует maxRetriesPerRequest: null — иначе он переопределяет
 * опцию сам и предупреждает об этом в логе.
 *
 * Настройки клиента приложения здесь намеренно переопределены:
 * `enableAutoPipelining` несовместим с блокирующим BZPOPMIN и Lua-скриптами,
 * которыми BullMQ забирает и завершает задачи, а `enableOfflineQueue: false`
 * не дал бы воркеру пережить переподключение — BullMQ рассчитывает, что
 * команды дождутся восстановления связи.
 *
 * @returns опции подключения
 */
export function getRedisConnection(): RedisOptions {
  return {
    ...baseConnection,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    enableAutoPipelining: false
  };
}

/**
 * Создаёт отдельное соединение для BullMQ Queue.
 *
 * Очередь не делит соединение с чтениями статусов: запись задачи блокировала
 * бы опрос на той же TCP-сессии, а очередь живёт дольше и закрывается
 * отдельно от клиента приложения.
 *
 * @returns клиент ioredis для очереди
 */
export function createQueueRedisClient(): Redis {
  return new Redis(getRedisConnection());
}

/**
 * Проверяет здоровье соединения с Valkey.
 */
export async function checkRedisHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const client = await getRedisClient();
    await client.ping();
    return { healthy: true };
  } catch (err) {
    return { healthy: false, error: (err as Error).message };
  }
}

export default {
  redisConnection,
  createRedisClient,
  createQueueRedisClient,
  getRedisClient,
  getRedisConnection,
  closeRedisClient,
  checkRedisHealth
};
