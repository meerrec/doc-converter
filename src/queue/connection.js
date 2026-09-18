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

import Redis from 'ioredis';
import { REDIS_HOST, REDIS_PORT } from '../config/index.js';

/**
 * Конфигурация подключения к Valkey.
 */
export const redisConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  // В Docker Compose Valkey доступен по имени сервиса
  // В production это будет хост из переменных окружения
  enableReadyCheck: true,
  retryStrategy: (times) => {
    // Экспоненциальный бэкофф с ограничением
    const delay = Math.min(Math.pow(2, times) * 100, 5000);
    return delay;
  },
  maxRetriesPerRequest: 5,
  connectTimeout: 5000,
  keepAlive: 30000
};

/**
 * Создаёт новый экземпляр Redis клиента.
 *
 * @returns {Redis} - экземпляр ioredis
 */
export function createRedisClient() {
  return new Redis(redisConnection);
}

/**
 * Общий экземпляр Redis клиента (singleton).
 */
let sharedClient = null;

/**
 * Получает общий Redis клиент.
 * Создаёт его при первом вызове.
 *
 * @returns {Promise<Redis>} - Redis клиент
 */
export async function getRedisClient() {
  if (!sharedClient) {
    sharedClient = createRedisClient();
    
    // Пингуем, чтобы убедиться, что соединение работает
    try {
      await sharedClient.ping();
    } catch (err) {
      sharedClient.disconnect();
      sharedClient = null;
      throw new Error(`Не удалось подключиться к Valkey/Redis: ${err.message}`);
    }
    
    // Обработка ошибок соединения
    sharedClient.on('error', (err) => {
      console.error('[redis] Ошибка соединения:', err);
    });
    
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
export async function closeRedisClient() {
  if (sharedClient) {
    await sharedClient.disconnect();
    sharedClient = null;
  }
}

/**
 * Проверяет, доступен ли Redis.
 *
 * @returns {Promise<boolean>} - true, если Redis доступен
 */
export async function isRedisAvailable() {
  try {
    const client = createRedisClient();
    await client.ping();
    await client.disconnect();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Возвращает параметры подключения к Valkey (для BullMQ).
 *
 * BullMQ требует maxRetriesPerRequest: null — иначе он переопределяет
 * опцию сам и предупреждает об этом в логе.
 *
 * @returns {Object} - опции подключения
 */
export function getRedisConnection() {
  return {
    ...redisConnection,
    maxRetriesPerRequest: null
  };
}

/**
 * Проверяет здоровье соединения с Valkey.
 *
 * @returns {Promise<{healthy: boolean, error?: string}>}
 */
export async function checkRedisHealth() {
  try {
    const client = await getRedisClient();
    await client.ping();
    return { healthy: true };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

export default {
  redisConnection,
  createRedisClient,
  getRedisClient,
  getRedisConnection,
  closeRedisClient,
  isRedisAvailable,
  checkRedisHealth
};
