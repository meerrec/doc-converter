/**
 * Очередь конвертации через BullMQ + Valkey
 *
 * Отвечает за:
 * - Создание и управление очередью задач
 * - Добавление задач в очередь
 * - Получение информации о задачах
 * - Настройку BullMQ
 *
 * Настройки BullMQ:
 * - lockDuration = JOB_TIMEOUT_MS * 2 (время блокировки задачи)
 * - stalledInterval = JOB_TIMEOUT_MS (интервал проверки зависших задач)
 * - maxStalledCount = 1 (максимум повторных попыток)
 *
 * Идемпотентность:
 * - Каждая задача имеет уникальный taskId (или key из запроса)
 * - Повторное добавление задачи с тем же taskId не создает дубликат
 * - Статус задачи хранится в Valkey
 *
 * Примечание:
 * - BullMQ автоматически продлевает блокировку при work
 * - Задачи с состоянием 'completed' или 'failed' остаются в очереди
 * - Для очистки нужно использовать cleanup функции
 */

import { getRedisClient } from './connection.js';
import {
  JOB_TIMEOUT_MS,
  IDEMPOTENCY_TTL_SEC,
} from '../config/index.js';
import type {
  DefaultJobOptions,
  JobsOptions,
  JobProgress,
  JobState,
  Queue,
  QueueOptions,
} from 'bullmq';

// ===========================================================================
// Загрузка BullMQ
// ===========================================================================

/**
 * BullMQ загружается лениво.
 *
 * Его CJS-сборка тянет ESM-only msgpackr, поэтому статический импорт ломает
 * загрузку всего модуля в ESM-окружении (в том числе в Jest), хотя очередь
 * нужна только в async-режиме.
 *
 * @returns модуль bullmq
 */
let bullmqModule: typeof import('bullmq') | null = null;

async function loadBullmq(): Promise<typeof import('bullmq')> {
  if (!bullmqModule) {
    bullmqModule = await import('bullmq');
  }
  return bullmqModule;
}

// ===========================================================================
// Название очереди
// ===========================================================================

const QUEUE_NAME = 'conversion';

// ===========================================================================
// Создание очереди
// ===========================================================================

/** Очередь конвертации (создаётся при первом обращении). */
let conversionQueue: Queue | null = null;

/**
 * Опции, передаваемые в конструктор очереди.
 *
 * В типах BullMQ часть полей описана только у Worker, а `timeout` остался
 * от Bull и не читается вовсе. Поля сохранены: конструктор получает ровно
 * ту же конфигурацию, что и раньше, а расширение типа лишь отражает
 * расхождение с типами библиотеки.
 */
interface ConversionQueueOptions extends QueueOptions {
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
  defaultJobOptions: DefaultJobOptions & { timeout: number };
}

/**
 * Получает или создает очередь конвертации
 */
export async function getConversionQueue(): Promise<Queue> {
  if (!conversionQueue) {
    const { Queue } = await loadBullmq();
    const redis = await getRedisClient();

    const queueOptions: ConversionQueueOptions = {
      connection: redis,
      // Настройки BullMQ
      lockDuration: JOB_TIMEOUT_MS * 2,
      stalledInterval: JOB_TIMEOUT_MS,
      maxStalledCount: 1,
      // Настройки по умолчанию для задач
      defaultJobOptions: {
        attempts: 1,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
        timeout: JOB_TIMEOUT_MS
      },
    };

    conversionQueue = new Queue(QUEUE_NAME, queueOptions);

    // Обработчик ошибок очереди
    conversionQueue.on('error', (err) => {
      console.error('[CONVERSION-QUEUE] Error:', err.message);
    });
  }

  return conversionQueue;
}

/**
 * Сбрасывает очередь
 */
export async function resetConversionQueue(): Promise<void> {
  if (conversionQueue) {
    await conversionQueue.close();
    conversionQueue = null;
  }
}

// ===========================================================================
// Добавление задач
// ===========================================================================

/**
 * Данные задачи конвертации.
 */
interface ConversionJobData {
  taskId: string;
  inputBuffer: string;
  inputFormat: string;
  outputFormat: string;
  options?: object;
  requestId?: string;
}

/**
 * Добавляет задачу в очередь
 *
 * @param jobData - данные задачи
 * @param jobData.taskId - уникальный идентификатор
 * @param jobData.inputBuffer - содержимое файла в base64
 * @param jobData.inputFormat - формат входного файла
 * @param jobData.outputFormat - формат выходного файла
 * @param jobData.options - опции конвертации
 * @param jobData.requestId - идентификатор запроса для логов
 * @param options - опции добавления
 * @param options.ttl - время жизни в секундах (по умолчанию IDEMPOTENCY_TTL_SEC)
 */
export async function addConversionJob(
  jobData: ConversionJobData,
  options: { ttl?: number } = {}
): Promise<{ taskId: string; queued: boolean }> {
  const ttl = options.ttl ?? IDEMPOTENCY_TTL_SEC;
  const queue = await getConversionQueue();

  // `ttl` остался от Bull — BullMQ его не читает, и в типах библиотеки
  // такого поля нет: тип расширен здесь, чтобы значение сохранилось
  // без приведения типов
  const jobOptions: JobsOptions & { ttl: number } = {
    jobId: jobData.taskId,
    // TTL для задачи
    ttl: ttl * 1000,
  };

  await queue.add(QUEUE_NAME, jobData, jobOptions);

  return {
    taskId: jobData.taskId,
    queued: true,
  };
}

// ===========================================================================
// Информация о задачах
// ===========================================================================

/**
 * Информация о задаче в очереди.
 */
interface JobInfo {
  taskId: string;
  state: JobState | 'unknown';
  progress: JobProgress;
  result: unknown;
  error: string | undefined;
  timestamp: number | undefined;
}

/**
 * Получает информацию о задаче
 *
 * Форма результата описана явно: к полям обращается код на TypeScript,
 * а `object` не даёт о них представления.
 *
 * @param taskId - идентификатор задачи
 */
export async function getJobInfo(taskId: string): Promise<JobInfo | null> {
  const queue = await getConversionQueue();

  try {
    const job = await queue.getJob(taskId);

    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue;
    const error = job.failedReason;

    return {
      taskId,
      state,
      progress,
      result,
      error,
      timestamp: job.processedOn,
    };
  } catch {
    return null;
  }
}

/**
 * Получает статус задачи
 *
 * @param taskId - идентификатор задачи
 */
export async function getJobStatus(taskId: string): Promise<string | null> {
  const info = await getJobInfo(taskId);
  return info?.state || null;
}

/**
 * Получает прогресс задачи
 *
 * @param taskId - идентификатор задачи
 */
export async function getJobProgress(taskId: string): Promise<JobProgress> {
  const info = await getJobInfo(taskId);
  return info?.progress || 0;
}

// ===========================================================================
// Статистика очереди
// ===========================================================================

/**
 * Получает статистику очереди
 */
export async function getQueueStats(): Promise<{
  counts: { [index: string]: number };
  completedCount: number;
  failedCount: number;
  delayedCount: number;
  activeCount: number;
  waitingCount: number;
}> {
  const queue = await getConversionQueue();

  const [counts, completed, failed, delayed, active, waiting] = await Promise.all([
    queue.getJobCounts(),
    queue.getCompleted(),
    queue.getFailed(),
    queue.getDelayed(),
    queue.getActive(),
    queue.getWaiting(),
  ]);

  return {
    counts,
    completedCount: completed.length,
    failedCount: failed.length,
    delayedCount: delayed.length,
    activeCount: active.length,
    waitingCount: waiting.length,
  };
}

// ===========================================================================
// Утилиты
// ===========================================================================

/**
 * Проверяет, существует ли задача
 *
 * @param taskId - идентификатор задачи
 */
export async function jobExists(taskId: string): Promise<boolean> {
  const info = await getJobInfo(taskId);
  return info !== null;
}

/**
 * Удаляет задачу
 *
 * @param taskId - идентификатор задачи
 */
export async function removeJob(taskId: string): Promise<boolean> {
  const queue = await getConversionQueue();

  try {
    const job = await queue.getJob(taskId);
    if (job) {
      await job.remove();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export default {
  getConversionQueue,
  resetConversionQueue,
  addConversionJob,
  getJobInfo,
  getJobStatus,
  getJobProgress,
  getQueueStats,
  jobExists,
  removeJob,
  QUEUE_NAME,
};
