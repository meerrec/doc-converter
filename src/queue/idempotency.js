/**
 *Идемпотентность через Valkey.
 *
 * Реализация на основе SET NX EX для гарантии, что:
 * 1. Тот же key не запустит конвертацию повторно
 * 2. Клиент может получить статус существующей задачи
 * 3. Задачи не дублируются при повторных запросах
 *
 * Все комментарии на русском языке.
 */

import { getRedisClient } from './connection.js';
import { TASK_TTL_SECONDS, MAX_TASK_ID_LENGTH } from '../security/limits.js';
import { randomUUID } from 'crypto';

/**
 * Префикс для ключей задач в Valkey.
 */
const TASK_KEY_PREFIX = 'task:';

/**
 * Префикс для хранения статуса задач.
 */
const TASK_STATUS_PREFIX = 'task:';

/**
 * Префикс для хранения owner (для идемпотентности).
 */
const TASK_OWNER_SUFFIX = ':owner';

/**
 * Префикс для хранения результата задач.
 */
const TASK_RESULT_SUFFIX = ':result';

/**
 * Генерирует уникальный taskId.
 *
 * @returns {string} - UUID v4
 */
export function generateTaskId() {
  return randomUUID();
}

/**
 * Пытается зарезервировать taskId для новой задачи.
 * Использует SET NX EX для атомарной проверки.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {number} [ttlSec=TASK_TTL_SECONDS] - время жизни в секундах
 * @returns {Promise<{reserved: boolean, existing?: string}>} - результат резервирования
 */
export async function reserveTaskId(taskId, ttlSec = TASK_TTL_SECONDS) {
  if (!taskId || taskId.length > MAX_TASK_ID_LENGTH) {
    throw new Error(`Invalid taskId: ${taskId}`);
  }

  const client = await getRedisClient();
  const ownerKey = `${TASK_KEY_PREFIX}${taskId}${TASK_OWNER_SUFFIX}`;

  // SET NX EX - устанавливаем только если ключа нет, с TTL
  const result = await client.set(
    ownerKey,
    'reserved',
    'NX',
    'EX',
    ttlSec
  );

  if (result === 'OK') {
    // Успешно зарезервировали
    return { reserved: true };
  }

  // Ключ уже существует, проверяем статус
  const status = await client.get(`${TASK_STATUS_PREFIX}${taskId}`);
  
  return {
    reserved: false,
    existing: status || 'unknown'
  };
}

/**
 * Устанавливает статус задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {string} status - статус (queued, processing, completed, failed)
 * @param {number} [ttlSec=TASK_TTL_SECONDS] - время жизни в секундах
 * @returns {Promise<void>}
 */
export async function setTaskStatus(taskId, status, ttlSec = TASK_TTL_SECONDS) {
  const client = await getRedisClient();
  const statusKey = `${TASK_STATUS_PREFIX}${taskId}`;

  await client.setex(statusKey, ttlSec, status);
}

/**
 * Получает статус задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<string|null>} - текущий статус или null
 */
export async function getTaskStatus(taskId) {
  const client = await getRedisClient();
  const statusKey = `${TASK_STATUS_PREFIX}${taskId}`;

  return await client.get(statusKey);
}

/**
 * Устанавливает прогресс задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {number} percent - процент выполнения (0-100)
 * @param {string} [message=''] - сообщение о прогрессе
 * @returns {Promise<void>}
 */
export async function setTaskProgress(taskId, percent, message = '') {
  const client = await getRedisClient();
  const progressKey = `${TASK_STATUS_PREFIX}${taskId}:progress`;

  await client.hset(
    progressKey,
    'percent', String(percent),
    'message', message
  );
  await client.expire(progressKey, TASK_TTL_SECONDS);
}

/**
 * Получает прогресс задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<{percent: number, message: string}|null>} - прогресс или null
 */
export async function getTaskProgress(taskId) {
  const client = await getRedisClient();
  const progressKey = `${TASK_STATUS_PREFIX}${taskId}:progress`;

  const result = await client.hgetall(progressKey);
  
  if (!result || Object.keys(result).length === 0) {
    return null;
  }

  return {
    percent: result.percent ? Number(result.percent) : 0,
    message: result.message || ''
  };
}

/**
 * Сохраняет результат задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {Object} result - результат задачи
 * @returns {Promise<void>}
 */
export async function setTaskResult(taskId, result) {
  const client = await getRedisClient();
  const resultKey = `${TASK_KEY_PREFIX}${taskId}${TASK_RESULT_SUFFIX}`;

  // Сохраняем результат как JSON
  await client.setex(
    resultKey,
    TASK_TTL_SECONDS,
    JSON.stringify(result)
  );
}

/**
 * Получает результат задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<Object|null>} - результат или null
 */
export async function getTaskResult(taskId) {
  const client = await getRedisClient();
  const resultKey = `${TASK_KEY_PREFIX}${taskId}${TASK_RESULT_SUFFIX}`;

  const result = await client.get(resultKey);
  
  if (!result) {
    return null;
  }

  try {
    return JSON.parse(result);
  } catch (err) {
    return null;
  }
}

/**
 * Устанавливает ошибку задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {string} error - код ошибки
 * @param {string} [message=''] - сообщение об ошибке
 * @returns {Promise<void>}
 */
export async function setTaskError(taskId, error, message = '') {
  const client = await getRedisClient();
  const errorKey = `${TASK_KEY_PREFIX}${taskId}:error`;

  await client.hset(
    errorKey,
    'code', error,
    'message', message
  );
  await client.expire(errorKey, TASK_TTL_SECONDS);
}

/**
 * Получает ошибку задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<{code: string, message: string}|null>} - ошибка или null
 */
export async function getTaskError(taskId) {
  const client = await getRedisClient();
  const errorKey = `${TASK_KEY_PREFIX}${taskId}:error`;

  const result = await client.hgetall(errorKey);
  
  if (!result || Object.keys(result).length === 0) {
    return null;
  }

  return {
    code: result.code || '',
    message: result.message || ''
  };
}

/**
 * Удаляет все данные задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<void>}
 */
export async function deleteTask(taskId) {
  const client = await getRedisClient();
  const keys = [
    `${TASK_KEY_PREFIX}${taskId}${TASK_OWNER_SUFFIX}`,
    `${TASK_STATUS_PREFIX}${taskId}`,
    `${TASK_KEY_PREFIX}${taskId}${TASK_RESULT_SUFFIX}`,
    `${TASK_KEY_PREFIX}${taskId}:progress`,
    `${TASK_KEY_PREFIX}${taskId}:error`
  ];

  // Удаляем все ключи задачи
  await client.del(keys);
}

/**
 * Получает полную информацию о задаче.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<Object>} - информация о задаче
 */
export async function getTaskInfo(taskId) {
  const [status, progress, result, error] = await Promise.all([
    getTaskStatus(taskId),
    getTaskProgress(taskId),
    getTaskResult(taskId),
    getTaskError(taskId)
  ]);

  return {
    taskId,
    status: status || 'unknown',
    progress: progress || { percent: 0, message: '' },
    result: result || null,
    error: error || null
  };
}

/**
 * Сохраняет метаданные задачи.
 * 
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {Object} metadata - метаданные задачи
 * @returns {Promise<void>}
 */
export async function saveTaskMetadata(taskId, metadata) {
  const client = await getRedisClient();
  const metadataKey = `${TASK_KEY_PREFIX}${taskId}:metadata`;

  await client.setex(
    metadataKey,
    TASK_TTL_SECONDS,
    JSON.stringify(metadata)
  );
}

/**
 * Читает метаданные задачи.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @returns {Promise<Object|null>} - метаданные или null
 */
export async function getTaskMetadata(taskId) {
  const client = await getRedisClient();
  const metadataKey = `${TASK_KEY_PREFIX}${taskId}:metadata`;

  const metadata = await client.get(metadataKey);

  if (!metadata) {
    return null;
  }

  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
}

/**
 * Сохраняет результат задачи с явным TTL.
 * Алиас setTaskResult для вызовов из обработчика очереди.
 *
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {Object} result - результат задачи
 * @param {number} [ttlSec=TASK_TTL_SECONDS] - время жизни в секундах
 * @returns {Promise<void>}
 */
export async function saveTaskResult(taskId, result, ttlSec = TASK_TTL_SECONDS) {
  const client = await getRedisClient();
  const resultKey = `${TASK_KEY_PREFIX}${taskId}${TASK_RESULT_SUFFIX}`;

  await client.setex(
    resultKey,
    ttlSec,
    JSON.stringify(result)
  );
}

/**
 * Проверяет конфликт параметров задачи.
 * Если задача с тем же key уже существует, но с другими параметрами,
 * возвращает conflict: true.
 * 
 * @param {string} taskId - уникальный идентификатор задачи
 * @param {Object} newParams - новые параметры
 * @returns {Promise<{conflict: boolean, existingParams?: Object}>}
 */
export async function checkKeyConflict(taskId, newParams) {
  const client = await getRedisClient();
  const metadataKey = `${TASK_KEY_PREFIX}${taskId}:metadata`;
  
  const existingMetadata = await client.get(metadataKey);
  
  if (!existingMetadata) {
    // Нет сохраненных метаданных, проверяем просто статус
    const status = await getTaskStatus(taskId);
    if (status && status !== 'completed') {
      return { conflict: false };
    }
    return { conflict: false };
  }
  
  try {
    const existingParams = JSON.parse(existingMetadata);
    
    // Сравниваем критические параметры
    const criticalParams = ['filetype', 'outputtype'];
    const hasConflict = criticalParams.some(param => {
      return existingParams[param] !== undefined && 
             newParams[param] !== undefined &&
             String(existingParams[param]).toLowerCase() !== String(newParams[param]).toLowerCase();
    });
    
    return {
      conflict: hasConflict,
      existingParams: existingParams
    };
  } catch {
    return { conflict: false };
  }
}

export default {
  generateTaskId,
  reserveTaskId,
  setTaskStatus,
  getTaskStatus,
  setTaskProgress,
  getTaskProgress,
  setTaskResult,
  getTaskResult,
  setTaskError,
  getTaskError,
  deleteTask,
  getTaskInfo,
  saveTaskMetadata,
  getTaskMetadata,
  saveTaskResult,
  checkKeyConflict
};
