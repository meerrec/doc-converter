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
 * @returns {Promise<Object>} - модуль bullmq
 */
let bullmqModule = null;

async function loadBullmq() {
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

/** @type {Queue|null} */
let conversionQueue = null;

/**
 * Получает или создает очередь конвертации
 * 
 * @returns {Promise<Queue>}
 */
export async function getConversionQueue() {
  if (!conversionQueue) {
    const { Queue } = await loadBullmq();
    const redis = await getRedisClient();

    conversionQueue = new Queue(QUEUE_NAME, {
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
    });
    
    // Обработчик ошибок очереди
    conversionQueue.on('error', (err) => {
      console.error('[CONVERSION-QUEUE] Error:', err.message);
    });
  }
  
  return conversionQueue;
}

/**
 * Сбрасывает очередь
 * 
 * @returns {Promise<void>}
 */
export async function resetConversionQueue() {
  if (conversionQueue) {
    await conversionQueue.close();
    conversionQueue = null;
  }
}

// ===========================================================================
// Добавление задач
// ===========================================================================

/**
 * Добавляет задачу в очередь
 * 
 * @param {object} jobData - данные задачи
 * @param {string} jobData.taskId - уникальный идентификатор
 * @param {string} jobData.inputFormat - формат входного файла
 * @param {string} jobData.outputFormat - формат выходного файла
 * @param {object} jobData.options - опции конвертации
 * @param {object} [options] - опции добавления
 * @param {number} [options.ttl=IDEMPOTENCY_TTL_SEC] - время жизни в секундах
 * @returns {Promise<{taskId: string, queued: boolean}>}
 */
export async function addConversionJob(jobData, options = {}) {
  const ttl = options.ttl ?? IDEMPOTENCY_TTL_SEC;
  const queue = await getConversionQueue();
  
  const job = await queue.add(
    QUEUE_NAME,
    jobData,
    {
      jobId: jobData.taskId,
      // TTL для задачи
      ttl: ttl * 1000,
    }
  );
  
  return {
    taskId: jobData.taskId,
    queued: true,
  };
}

// ===========================================================================
// Информация о задачах
// ===========================================================================

/**
 * Получает информацию о задаче
 * 
 * @param {string} taskId - идентификатор задачи
 * @returns {Promise<object|null>}
 */
export async function getJobInfo(taskId) {
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
 * @param {string} taskId - идентификатор задачи
 * @returns {Promise<string|null>}
 */
export async function getJobStatus(taskId) {
  const info = await getJobInfo(taskId);
  return info?.state || null;
}

/**
 * Получает прогресс задачи
 * 
 * @param {string} taskId - идентификатор задачи
 * @returns {Promise<number>}
 */
export async function getJobProgress(taskId) {
  const info = await getJobInfo(taskId);
  return info?.progress || 0;
}

// ===========================================================================
// Статистика очереди
// ===========================================================================

/**
 * Получает статистику очереди
 * 
 * @returns {Promise<object>}
 */
export async function getQueueStats() {
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
// Очистка
// ===========================================================================

/**
 * Удаляет завершенные задачи из очереди
 * 
 * @param {number} [maxAgeMs=86400000] - максимальный возраст в мс (24 часа)
 * @returns {Promise<{removed: number}>}
 */
export async function cleanupCompletedJobs(maxAgeMs = 86400000) {
  const queue = await getConversionQueue();
  
  const completed = await queue.getCompleted();
  const failed = await queue.getFailed();
  
  const allJobs = [...completed, ...failed];
  let removed = 0;
  
  for (const job of allJobs) {
    if (job.finishedOn) {
      const age = Date.now() - job.finishedOn.getTime();
      
      if (age > maxAgeMs) {
        await job.remove();
        removed++;
      }
    }
  }
  
  return { removed };
}

/**
 * Удаляет зависшие задачи
 * 
 * @returns {Promise<{removed: number}>}
 */
export async function cleanupStalledJobs() {
  const queue = await getConversionQueue();
  
  const stalled = await queue.getStalled();
  let removed = 0;
  
  for (const job of stalled) {
    await job.remove();
    removed++;
  }
  
  return { removed };
}

// ===========================================================================
// Утилиты
// ===========================================================================

/**
 * Проверяет, существует ли задача
 * 
 * @param {string} taskId - идентификатор задачи
 * @returns {Promise<boolean>}
 */
export async function jobExists(taskId) {
  const info = await getJobInfo(taskId);
  return info !== null;
}

/**
 * Удаляет задачу
 * 
 * @param {string} taskId - идентификатор задачи
 * @returns {Promise<boolean>}
 */
export async function removeJob(taskId) {
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
  cleanupCompletedJobs,
  cleanupStalledJobs,
  jobExists,
  removeJob,
  QUEUE_NAME,
};
