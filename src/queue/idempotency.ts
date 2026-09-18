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
 * Прогресс задачи, хранимый в Valkey.
 */
interface TaskProgress {
  percent: number;
  message: string;
}

/**
 * Ошибка задачи, хранимая в Valkey.
 */
interface TaskErrorInfo {
  code: string;
  message: string;
}

/**
 * Полная информация о задаче.
 */
interface TaskInfo {
  taskId: string;
  status: string;
  progress: TaskProgress;
  result: unknown;
  error: TaskErrorInfo | null;
}

/**
 * Генерирует уникальный taskId.
 *
 * @returns UUID v4
 */
export function generateTaskId(): string {
  return randomUUID();
}

/**
 * Пытается зарезервировать taskId для новой задачи.
 * Использует SET NX EX для атомарной проверки.
 *
 * @param taskId - уникальный идентификатор задачи
 * @param ttlSec - время жизни в секундах
 * @returns результат резервирования
 */
export async function reserveTaskId(
  taskId: string,
  ttlSec: number = TASK_TTL_SECONDS
): Promise<{ reserved: boolean; existing?: string }> {
  if (!taskId || taskId.length > MAX_TASK_ID_LENGTH) {
    throw new Error(`Invalid taskId: ${taskId}`);
  }

  const client = await getRedisClient();
  const ownerKey = `${TASK_KEY_PREFIX}${taskId}${TASK_OWNER_SUFFIX}`;

  // SET NX EX - устанавливаем только если ключа нет, с TTL.
  // Токены идут в порядке EX → NX: такую форму принимают типы ioredis,
  // для самого Redis порядок опций SET значения не имеет
  const result = await client.set(
    ownerKey,
    'reserved',
    'EX',
    ttlSec,
    'NX'
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
 * @param taskId - уникальный идентификатор задачи
 * @param status - статус (queued, processing, completed, failed)
 * @param ttlSec - время жизни в секундах
 */
export async function setTaskStatus(
  taskId: string,
  status: string,
  ttlSec: number = TASK_TTL_SECONDS
): Promise<void> {
  const client = await getRedisClient();
  const statusKey = `${TASK_STATUS_PREFIX}${taskId}`;

  await client.setex(statusKey, ttlSec, status);
}

/**
 * Получает статус задачи.
 *
 * @param taskId - уникальный идентификатор задачи
 * @returns текущий статус или null
 */
export async function getTaskStatus(taskId: string): Promise<string | null> {
  const client = await getRedisClient();
  const statusKey = `${TASK_STATUS_PREFIX}${taskId}`;

  return await client.get(statusKey);
}

/**
 * Устанавливает прогресс задачи.
 *
 * @param taskId - уникальный идентификатор задачи
 * @param percent - процент выполнения (0-100)
 * @param message - сообщение о прогрессе
 */
export async function setTaskProgress(
  taskId: string,
  percent: number,
  message: string = ''
): Promise<void> {
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
 * @param taskId - уникальный идентификатор задачи
 * @returns прогресс или null
 */
export async function getTaskProgress(taskId: string): Promise<TaskProgress | null> {
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
 * @param taskId - уникальный идентификатор задачи
 * @param result - результат задачи
 */
export async function setTaskResult(taskId: string, result: object): Promise<void> {
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
 * @param taskId - уникальный идентификатор задачи
 * @returns результат или null
 */
export async function getTaskResult(taskId: string): Promise<unknown> {
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
 * @param taskId - уникальный идентификатор задачи
 * @param error - код ошибки
 * @param message - сообщение об ошибке
 */
export async function setTaskError(
  taskId: string,
  error: string,
  message: string = ''
): Promise<void> {
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
 * @param taskId - уникальный идентификатор задачи
 * @returns ошибка или null
 */
export async function getTaskError(taskId: string): Promise<TaskErrorInfo | null> {
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
 * @param taskId - уникальный идентификатор задачи
 */
export async function deleteTask(taskId: string): Promise<void> {
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
 * Форма возвращаемого объекта описана явно: к полям обращается код
 * на TypeScript, а `Object` не даёт о них никакого представления.
 *
 * @param taskId - уникальный идентификатор задачи
 * @returns информация о задаче
 */
export async function getTaskInfo(taskId: string): Promise<TaskInfo> {
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
 * @param taskId - уникальный идентификатор задачи
 * @param metadata - метаданные задачи
 */
export async function saveTaskMetadata(taskId: string, metadata: object): Promise<void> {
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
 * @param taskId - уникальный идентификатор задачи
 * @returns метаданные или null
 */
export async function getTaskMetadata(taskId: string): Promise<unknown> {
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
 * @param taskId - уникальный идентификатор задачи
 * @param result - результат задачи
 * @param ttlSec - время жизни в секундах
 */
export async function saveTaskResult(
  taskId: string,
  result: object,
  ttlSec: number = TASK_TTL_SECONDS
): Promise<void> {
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
 * @param taskId - уникальный идентификатор задачи
 * @param newParams - новые параметры
 */
export async function checkKeyConflict(
  taskId: string,
  newParams: Record<string, unknown>
): Promise<{ conflict: boolean; existingParams?: Record<string, unknown> }> {
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
    const existingParams = JSON.parse(existingMetadata) as Record<string, unknown>;

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
