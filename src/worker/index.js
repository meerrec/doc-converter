/**
 * BullMQ Worker процесс
 * 
 * Отвечает за:
 * - Создание и управление BullMQ Worker
 * - Обработку задач из очереди
 * - Передачу задач в процессор
 * - Обработку ошибок
 * 
 * Как работает:
 * 1. Создает BullMQ Worker с подключением к Valkey
 * 2. Подписывается на очередь 'conversion'
 * 3. При получении задачи - передает её в processor
 * 4. Обновляет прогресс и статус задачи
 * 5. Обрабатывает ошибки
 * 
 * Настройки Worker:
 * - concurrency: MAX_CONCURRENT (1 по умолчанию для BullMQ)
 * - lockDuration: BULLMQ_LOCK_DURATION
 * - stalledInterval: BULLMQ_STALLED_INTERVAL
 * 
 * Примечание:
 * - Worker работает в отдельном процессе
 * - В production запускается как отдельный контейнер
 * - Worker не имеет доступа к HTTP API
 */

import { pathToFileURL } from 'node:url';
import { getRedisConnection } from '../queue/connection.js';
import {
  MAX_CONCURRENT,
  BULLMQ_LOCK_DURATION,
  BULLMQ_STALLED_INTERVAL,
} from '../config/index.js';
import { processJob } from './processor.js';
import { CONVERTER_VERSION } from '../config/index.js';

// ===========================================================================
// Название очереди
// ===========================================================================

const QUEUE_NAME = 'conversion';

// ===========================================================================
// Worker инстанс
// ===========================================================================

/** @type {Worker|null} */
let workerInstance = null;

/**
 * Создает и запускает BullMQ Worker
 * 
 * @returns {Promise<Worker>}
 */
export async function createWorker() {
  if (workerInstance) {
    return workerInstance;
  }
  
  // BullMQ грузится лениво: его CJS-сборка тянет ESM-only msgpackr,
  // что ломает статический импорт модуля
  const { Worker } = await import('bullmq');

  const redis = await getRedisConnection();

  // Настройки worker
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return await processJob(job);
    },
    {
      connection: redis,
      // Конкуренция - сколько задач обрабатывать одновременно
      concurrency: MAX_CONCURRENT,
      // Настройки блокировки
      lockDuration: BULLMQ_LOCK_DURATION,
      stalledInterval: BULLMQ_STALLED_INTERVAL,
      // Автоматическое продление блокировки
      guardInterval: 30000,
    }
  );
  
  // Обработчики событий
  worker.on('completed', (job) => {
    // Прогресс здесь обновлять нельзя: задача к этому моменту уже удалена
    // из очереди (removeOnComplete: true в настройках Queue), и вызов
    // job.updateProgress падает с «Missing key for job», роняя процесс.
    // Итоговый прогресс пишется в самом обработчике задачи (processor.js).
    console.log(`[WORKER] Job ${job.id} completed`);
  });
  
  worker.on('failed', (job, err) => {
    console.error(`[WORKER] Job ${job.id} failed: ${err.message}`);
  });
  
  worker.on('stalled', (jobId) => {
    console.warn(`[WORKER] Job ${jobId} stalled`);
  });
  
  worker.on('progress', (job, progress) => {
    console.log(`[WORKER] Job ${job.id} progress: ${progress}%`);
  });
  
  worker.on('error', (err) => {
    // У ошибок соединения ioredis message часто пустой — показываем код
    console.error('[WORKER] Error:', err.message || err.code || String(err));
  });
  
  worker.on('pause', () => {
    console.log('[WORKER] Paused');
  });
  
  worker.on('resume', () => {
    console.log('[WORKER] Resumed');
  });
  
  worker.on('cleaned', (jobs, type) => {
    console.log(`[WORKER] Cleaned ${jobs.length} ${type} jobs`);
  });
  
  // Обработчик сигналов
  process.on('SIGTERM', async () => {
    console.log('[WORKER] Received SIGTERM, stopping...');
    await worker.close();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    console.log('[WORKER] Received SIGINT, stopping...');
    await worker.close();
    process.exit(0);
  });
  
  workerInstance = worker;
  
  console.log(`[WORKER] BullMQ Worker started for queue '${QUEUE_NAME}'`);
  console.log(`[WORKER] Converter version: ${CONVERTER_VERSION}`);
  console.log(`[WORKER] Concurrency: ${MAX_CONCURRENT}`);
  
  return worker;
}

/**
 * Останавливает Worker
 * 
 * @returns {Promise<void>}
 */
export async function stopWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    console.log('[WORKER] Stopped');
  }
}

/**
 * Пауза Worker
 * 
 * @returns {Promise<void>}
 */
export async function pauseWorker() {
  if (workerInstance) {
    await workerInstance.pause();
    console.log('[WORKER] Paused');
  }
}

/**
 * Возобновление Worker
 * 
 * @returns {Promise<void>}
 */
export async function resumeWorker() {
  if (workerInstance) {
    await workerInstance.resume();
    console.log('[WORKER] Resumed');
  }
}

/**
 * Получает информацию о Worker
 * 
 * @returns {Promise<object>}
 */
export async function getWorkerInfo() {
  if (!workerInstance) {
    return { running: false };
  }
  
  const counts = await workerInstance.getJobCounts();
  
  return {
    running: true,
    ...counts,
  };
}

// ===========================================================================
// Точка входа
// ===========================================================================

// Запускаем worker только при прямом вызове файла
const isMainModule = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  createWorker().catch((err) => {
    console.error('[WORKER] Failed to start:', err.message);
    process.exit(1);
  });
}

export default {
  createWorker,
  stopWorker,
  pauseWorker,
  resumeWorker,
  getWorkerInfo,
  getWorker: () => workerInstance,
};
