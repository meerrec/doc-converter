/**
 *Идемпотентность и состояние задач в Valkey.
 *
 * Реализация на основе SET NX EX для гарантии, что:
 * 1. Тот же key не запустит конвертацию повторно
 * 2. Клиент может получить статус существующей задачи
 * 3. Задачи не дублируются при повторных запросах
 *
 * Число обращений к Valkey здесь принципиально: статус опрашивается клиентом
 * постоянно. Поэтому состояние читается одной командой MGET на пачку задач,
 * а не командой на ключ, и на задачу приходится ровно два ключа — статус
 * и результат. Ключи прогресса и ошибки убраны: их никто не создавал, а на
 * каждом опросе по ним выполнялся HGETALL.
 *
 * Все комментарии на русском языке.
 */

import { getRedisClient } from './connection.js';
import { TASK_TTL_SECONDS, MAX_TASK_ID_LENGTH } from '../security/limits.js';

/**
 * Префикс для ключей задач.
 */
const TASK_KEY_PREFIX = 'task:';

/**
 * Суффикс ключа владельца (для идемпотентности).
 */
const TASK_OWNER_SUFFIX = ':owner';

/**
 * Суффикс ключа результата задачи.
 */
const TASK_RESULT_SUFFIX = ':result';

/**
 * Суффикс ключа метаданных задачи.
 */
const TASK_METADATA_SUFFIX = ':metadata';

/**
 * Состояние задачи, хранимое в Valkey.
 */
export interface TaskInfo {
  /** Идентификатор задачи. */
  taskId: string;
  /** Статус: queued, processing, completed, failed. */
  status: string;
  /** Результат задачи либо null. */
  result: unknown;
}

/** Ключ владельца задачи. */
function ownerKey(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}${TASK_OWNER_SUFFIX}`;
}

/** Ключ статуса задачи. */
function statusKey(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}`;
}

/** Ключ результата задачи. */
function resultKey(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}${TASK_RESULT_SUFFIX}`;
}

/** Ключ метаданных задачи. */
function metadataKey(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}${TASK_METADATA_SUFFIX}`;
}

/**
 * Разбирает JSON из значения Valkey.
 *
 * @param raw - значение ключа
 * @returns разобранное значение или null
 */
function parseJson(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

  // SET ... EX ... NX GET — одна команда вместо SET + GET. Токены идут
  // в порядке EX → NX → GET: такую форму принимают типы ioredis, для самого
  // Redis порядок опций SET значения не имеет.
  // Ответ — прежнее значение ключа, либо null, если ключ удалось занять
  const previous = await client.set(
    ownerKey(taskId),
    'reserved',
    'EX',
    ttlSec,
    'NX',
    'GET'
  );

  if (previous === null) {
    return { reserved: true };
  }

  // Ключ занят: отдаём текущий статус задачи, если он ещё не истёк.
  // undefined вместо 'unknown' — вызывающий сам решает, что показать клиенту
  const status = await client.get(statusKey(taskId));

  return {
    reserved: false,
    existing: status ?? undefined
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

  await client.setex(statusKey(taskId), ttlSec, status);
}

/**
 * Читает состояние пачки задач одной командой.
 *
 * MGET на всю пачку вместо GET на каждый ключ: пакетный опрос статусов —
 * самый частый запрос к Valkey, и раньше он стоил четырёх команд на задачу,
 * две из которых читали никогда не создаваемые ключи.
 *
 * @param taskIds - идентификаторы задач
 * @returns состояния задач в том же порядке; null для неизвестных задач
 */
export async function getTasksInfo(
  taskIds: string[]
): Promise<(TaskInfo | null)[]> {
  if (taskIds.length === 0) {
    return [];
  }

  const client = await getRedisClient();
  const keys: string[] = [];

  for (const taskId of taskIds) {
    keys.push(statusKey(taskId), resultKey(taskId));
  }

  const values = await client.mget(...keys);

  return taskIds.map((taskId, index) => {
    const status = values[index * 2] ?? null;
    const rawResult = values[index * 2 + 1] ?? null;

    // Ни статуса, ни результата — задача неизвестна. Раньше здесь возвращался
    // объект со статусом 'unknown', поэтому ветка not_found в контроллере
    // статусов была недостижима: клиент принимал 'unknown' за живую задачу
    // и опрашивал её до пятиминутного дедлайна
    if (status === null && rawResult === null) {
      return null;
    }

    return {
      taskId,
      status: status ?? 'unknown',
      result: parseJson(rawResult)
    };
  });
}

/**
 * Читает состояние одной задачи.
 *
 * @param taskId - уникальный идентификатор задачи
 * @returns состояние задачи или null, если задачи в Valkey нет
 */
export async function getTaskInfo(taskId: string): Promise<TaskInfo | null> {
  const [info] = await getTasksInfo([taskId]);

  return info ?? null;
}

/**
 * Сохраняет результат задачи.
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

  await client.setex(resultKey(taskId), ttlSec, JSON.stringify(result));
}

/**
 * Сохраняет метаданные задачи.
 *
 * @param taskId - уникальный идентификатор задачи
 * @param metadata - метаданные задачи
 */
export async function saveTaskMetadata(taskId: string, metadata: object): Promise<void> {
  const client = await getRedisClient();

  await client.setex(
    metadataKey(taskId),
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

  const metadata = await client.get(metadataKey(taskId));

  return parseJson(metadata);
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

  const existingMetadata = await client.get(metadataKey(taskId));

  if (!existingMetadata) {
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
  reserveTaskId,
  setTaskStatus,
  getTaskInfo,
  getTasksInfo,
  saveTaskResult,
  saveTaskMetadata,
  getTaskMetadata,
  checkKeyConflict
};
