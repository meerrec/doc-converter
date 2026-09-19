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

import { createQueueRedisClient } from './connection.js';
import {
  JOB_TIMEOUT_MS,
  FAILED_JOB_TTL_SEC,
  MAX_FAILED_JOBS,
} from '../config/index.js';
import type { Redis } from 'ioredis';
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
 * загрузку всего модуля в ESM-окружении, хотя очередь
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
 * Соединение очереди.

 * Отдельное от клиента приложения: запись задачи не должна делить TCP-сессию
 * с чтениями статусов, которые обслуживают запросы клиентов.
 */
let queueConnection: Redis | null = null;

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

    queueConnection = createQueueRedisClient();

    const queueOptions: ConversionQueueOptions = {
      connection: queueConnection,
      // Настройки BullMQ
      lockDuration: JOB_TIMEOUT_MS * 2,
      stalledInterval: JOB_TIMEOUT_MS,
      maxStalledCount: 1,
      // Настройки по умолчанию для задач
      defaultJobOptions: {
        // Ретраев нет осознанно: ошибки конвертации детерминированы (битый
        // документ, таймаут WASM), и повтор лишь сжигает ещё 60 с CPU.
        // `backoff` здесь стоял раньше, но при attempts: 1 не используется
        // никогда — мёртвая настройка
        attempts: 1,
        removeOnComplete: true,
        // Упавшая задача нужна для диагностики, но не вечно: раньше здесь было
        // `false`, и задачи с payload'ом копились без ограничения — при 512 МБ
        // у Valkey это заканчивалось OOM-kill. age покрывает рабочий день,
        // count ограничивает память независимо от возраста
        removeOnFail: { age: FAILED_JOB_TTL_SEC, count: MAX_FAILED_JOBS },
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

  // Соединение очереди закрывается отдельно: BullMQ не закрывает клиент,
  // переданный ему готовым экземпляром
  if (queueConnection) {
    queueConnection.disconnect();
    queueConnection = null;
  }
}

// ===========================================================================
// Добавление задач
// ===========================================================================

/**
 * Данные задачи конвертации.
 *
 * Содержимое файла передаётся путём на общем томе (`inputPath`), а не телом
 * задачи: base64 в Redis занимал до 133 МБ на задачу. Поле `inputBuffer`
 * остаётся для задач, поставленных в очередь до обновления, — при
 * rolling-деплое они обязаны доработать.
 */
interface ConversionJobData {
  taskId: string;
  inputPath?: string;
  inputSize?: number;
  /** Устаревшее поле: содержимое файла в base64. */
  inputBuffer?: string;
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
 * @param jobData.inputPath - путь к входному файлу на общем томе
 * @param jobData.inputSize - размер входного файла в байтах
 * @param jobData.inputFormat - формат входного файла
 * @param jobData.outputFormat - формат выходного файла
 * @param jobData.options - опции конвертации
 * @param jobData.requestId - идентификатор запроса для логов
 * @param options - опции добавления
 * @param options.ttl - время жизни в секундах (по умолчанию IDEMPOTENCY_TTL_SEC)
 */
export async function addConversionJob(
  jobData: ConversionJobData
): Promise<{ taskId: string; queued: boolean }> {
  const queue = await getConversionQueue();

  // Время жизни задачи задаётся не здесь, а в defaultJobOptions
  // (removeOnComplete / removeOnFail): поле `ttl` осталось от Bull, BullMQ
  // его не читает вовсе
  const jobOptions: JobsOptions = {
    jobId: jobData.taskId,
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

  // Только getJobCounts: getCompleted(), getFailed() и родственные им делают
  // LRANGE 0 -1 и читают каждую задачу целиком вместе с её данными
  const counts = await queue.getJobCounts(
    'completed',
    'failed',
    'delayed',
    'active',
    'waiting'
  );

  return {
    counts,
    completedCount: counts.completed ?? 0,
    failedCount: counts.failed ?? 0,
    delayedCount: counts.delayed ?? 0,
    activeCount: counts.active ?? 0,
    waitingCount: counts.waiting ?? 0,
  };
}

export default {
  getConversionQueue,
  resetConversionQueue,
  addConversionJob,
  getJobInfo,
  getQueueStats,
  QUEUE_NAME,
};
