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
import type { EventEmitter } from 'node:events';
// Worker импортируется под псевдонимом: имя Worker занято локальной
// переменной в createWorker — так класс грузится лениво (см. комментарий там)
import type { Job, QueueGetters, Worker as BullWorker } from 'bullmq';
import { getRedisConnection } from '../queue/connection.js';
import {
  MAX_CONCURRENT,
  BULLMQ_LOCK_DURATION,
  BULLMQ_STALLED_INTERVAL,
} from '../config/index.js';
import { processJob } from './processor.js';
import type { JobData, JobResult } from './processor.js';
import { CONVERTER_VERSION } from '../config/index.js';

// ===========================================================================
// Название очереди
// ===========================================================================

const QUEUE_NAME = 'conversion';

// ===========================================================================
// Worker инстанс
// ===========================================================================

/** Инстанс Worker'а. */
let workerInstance: BullWorker<JobData, JobResult> | null = null;

/**
 * Информация о Worker'е.
 */
export type WorkerInfo = { running: boolean } & Record<string, number | boolean>;

/**
 * Создает и запускает BullMQ Worker
 */
export async function createWorker(): Promise<BullWorker<JobData, JobResult>> {
  if (workerInstance) {
    return workerInstance;
  }

  // BullMQ грузится лениво: его CJS-сборка тянет ESM-only msgpackr,
  // что ломает статический импорт модуля
  const { Worker } = await import('bullmq');

  const redis = await getRedisConnection();

  // Настройки worker.
  // Объект собран заранее: guardInterval в типе WorkerOptions текущего BullMQ
  // отсутствует, а в литерале аргумента лишнее свойство — ошибка компиляции
  const workerOptions = {
    connection: redis,
    // Конкуренция - сколько задач обрабатывать одновременно
    concurrency: MAX_CONCURRENT,
    // Настройки блокировки
    lockDuration: BULLMQ_LOCK_DURATION,
    stalledInterval: BULLMQ_STALLED_INTERVAL,
    // Автоматическое продление блокировки
    guardInterval: 30000,
  };

  const worker = new Worker<JobData, JobResult>(
    QUEUE_NAME,
    async (job) => {
      return await processJob(job);
    },
    workerOptions
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
    // В типе BullMQ job необязателен (задача удалена после stalled-лимита);
    // приведение сохраняет исходное обращение к job.id
    const failedJob = job as Job<JobData, JobResult>;
    console.error(`[WORKER] Job ${failedJob.id} failed: ${err.message}`);
  });

  worker.on('stalled', (jobId) => {
    console.warn(`[WORKER] Job ${jobId} stalled`);
  });

  worker.on('progress', (job, progress) => {
    console.log(`[WORKER] Job ${job.id} progress: ${progress}%`);
  });

  worker.on('error', (err) => {
    // У ошибок соединения ioredis message часто пустой — показываем код
    const connectionError = err as Error & { code?: string };
    console.error('[WORKER] Error:', connectionError.message || connectionError.code || String(err));
  });

  // События 'pause', 'resume' и 'cleaned' в типе Worker не объявлены:
  // в текущем BullMQ пауза и возобновление называются 'paused'/'resumed',
  // а 'cleaned' эмитит очередь. Обработчики сохранены как есть, поэтому
  // регистрируем их через EventEmitter
  const emitter = worker as EventEmitter;

  emitter.on('pause', () => {
    console.log('[WORKER] Paused');
  });

  emitter.on('resume', () => {
    console.log('[WORKER] Resumed');
  });

  emitter.on('cleaned', (jobs: unknown[], type: string) => {
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
 */
export async function stopWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    console.log('[WORKER] Stopped');
  }
}

/**
 * Пауза Worker
 */
export async function pauseWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.pause();
    console.log('[WORKER] Paused');
  }
}

/**
 * Возобновление Worker
 */
export async function resumeWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.resume();
    console.log('[WORKER] Resumed');
  }
}

/**
 * Получает информацию о Worker
 */
export async function getWorkerInfo(): Promise<WorkerInfo> {
  if (!workerInstance) {
    return { running: false };
  }

  // getJobCounts объявлен в QueueGetters, а Worker его не наследует: в текущем
  // BullMQ вызов падает с TypeError, в типе Worker метода тоже нет.
  // Приведение нужно только для компиляции — поведение сохранено как есть
  const jobCounts = await (workerInstance as unknown as QueueGetters).getJobCounts();

  return {
    running: true,
    ...jobCounts,
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
    console.error('[WORKER] Failed to start:', (err as Error).message);
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
