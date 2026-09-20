/**
 * Состояние задач конвертации в Redis.
 *
 * Запись — хэш `job:{id}` с TTL. Пишут обе стороны: API при постановке задачи
 * (чтобы статус был доступен сразу, ещё до того, как воркер её возьмёт)
 * и воркер по ходу обработки.
 *
 * Отдельная запись, а не поле в задаче BullMQ: задача исчезает из очереди
 * по завершении (`removeOnComplete`), а статус должен пережить её и ответить
 * клиенту ещё сутки — в том числе presigned-ссылкой на результат.
 *
 * Все комментарии на русском языке.
 */

import type { ComplexityTier, JobStatus } from '@doc-converter/contract';
import { JOB_TTL_SEC } from '@doc-converter/config';
import { getRedisClient } from './connection.js';

/**
 * Ключ записи о задаче.
 *
 * @param jobId - идентификатор задачи
 * @returns ключ в Redis
 */
function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

/** Запись о задаче в том виде, в каком она хранится в Redis. */
export interface JobRecord {
  /** Идентификатор задачи. */
  jobId: string;
  /** Текущее состояние. */
  status: JobStatus;
  /** Уровень сложности (и, значит, очередь). */
  tier: ComplexityTier;
  /** Время постановки в очередь (ISO 8601). */
  createdAt: string;
  /** Время начала обработки. */
  startedAt?: string;
  /** Время завершения — успешного или неуспешного. */
  finishedAt?: string;
  /** Код ошибки при `failed`. */
  errorCode?: string;
  /** Текст ошибки при `failed`. */
  errorMessage?: string;
  /** Ключ результата в объектном хранилище при `completed`. */
  resultKey?: string;
  /** Размер результата в байтах. */
  sizeBytes?: number;
}

/**
 * Создаёт запись о поставленной задаче.
 *
 * @param jobId - идентификатор задачи
 * @param tier - уровень сложности
 * @returns созданная запись
 */
export async function createJob(
  jobId: string,
  tier: ComplexityTier
): Promise<JobRecord> {
  const createdAt = new Date().toISOString();

  const record: JobRecord = { jobId, status: 'queued', tier, createdAt };

  const client = await getRedisClient();
  const key = jobKey(jobId);

  await client
    .multi()
    .hset(key, {
      jobId,
      status: record.status,
      tier,
      createdAt,
    })
    .expire(key, JOB_TTL_SEC)
    .exec();

  return record;
}

/**
 * Отмечает задачу как взятую в работу.
 *
 * @param jobId - идентификатор задачи
 */
export async function markProcessing(jobId: string): Promise<void> {
  const client = await getRedisClient();

  await client
    .multi()
    .hset(jobKey(jobId), {
      status: 'processing',
      startedAt: new Date().toISOString(),
    })
    .expire(jobKey(jobId), JOB_TTL_SEC)
    .exec();
}

/**
 * Отмечает задачу как завершённую успешно.
 *
 * @param jobId - идентификатор задачи
 * @param resultKey - ключ результата в объектном хранилище
 * @param sizeBytes - размер результата
 */
export async function markCompleted(
  jobId: string,
  resultKey: string,
  sizeBytes: number
): Promise<void> {
  const client = await getRedisClient();

  await client
    .multi()
    .hset(jobKey(jobId), {
      status: 'completed',
      resultKey,
      sizeBytes: String(sizeBytes),
      finishedAt: new Date().toISOString(),
    })
    // Ошибки прошлых попыток не должны переживать успех: задача могла упасть
    // на первой попытке и завершиться на повторной
    .hdel(jobKey(jobId), 'errorCode', 'errorMessage')
    .expire(jobKey(jobId), JOB_TTL_SEC)
    .exec();
}

/**
 * Отмечает задачу как упавшую.
 *
 * @param jobId - идентификатор задачи
 * @param code - код ошибки из контракта
 * @param message - текст ошибки
 */
export async function markFailed(
  jobId: string,
  code: string,
  message: string
): Promise<void> {
  const client = await getRedisClient();

  await client
    .multi()
    .hset(jobKey(jobId), {
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    })
    .expire(jobKey(jobId), JOB_TTL_SEC)
    .exec();
}

/**
 * Читает запись о задаче.
 *
 * @param jobId - идентификатор задачи
 * @returns запись или null, если задачи нет (в том числе если истёк TTL)
 */
export async function getJob(jobId: string): Promise<JobRecord | null> {
  const client = await getRedisClient();
  const raw = await client.hgetall(jobKey(jobId));

  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }

  return {
    jobId: raw.jobId ?? jobId,
    status: (raw.status ?? 'queued') as JobStatus,
    tier: (raw.tier ?? 'light') as ComplexityTier,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    errorCode: raw.errorCode,
    errorMessage: raw.errorMessage,
    resultKey: raw.resultKey,
    sizeBytes: raw.sizeBytes ? Number(raw.sizeBytes) : undefined,
  };
}

export default {
  createJob,
  markProcessing,
  markCompleted,
  markFailed,
  getJob,
};
