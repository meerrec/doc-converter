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
import { getRedisClient, getRedisConnection } from '../queue/connection.js';
import {
  MAX_CONCURRENT,
  FORK_POOL_SIZE,
  BULLMQ_LOCK_DURATION,
  BULLMQ_STALLED_INTERVAL,
  BULLMQ_MAX_STALLED_COUNT,
  INPUT_CLEANUP_INTERVAL_MS,
  WORKER_OOM_PAUSE_MS,
  VALKEY_MEMORY_WARN_RATIO,
} from '../config/index.js';
import { cleanupInputs } from '../storage/fileStorage.js';
import { warmupPool } from './fork-pool.js';
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
 * Запускает периодическую уборку осиротевших входных файлов.
 *
 * Файл остаётся на диске, если api записал документ, но упал до постановки
 * задачи в очередь, либо если воркер был убит раньше, чем успел удалить файл
 * после конвертации. Обход идёт по каталогу, а не по ключам Valkey: к моменту
 * уборки задача уже могла исчезнуть из очереди.
 *
 * @returns таймер уборки
 */
function startInputCleanup(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void cleanupInputs()
      .then((removed) => {
        if (removed > 0) {
          console.log(`[WORKER] Удалено осиротевших входных файлов: ${removed}`);
        }
      })
      .catch((err: Error) => {
        console.error('[WORKER] Ошибка уборки входных файлов:', err.message);
      });
  }, INPUT_CLEANUP_INTERVAL_MS);

  // unref: уборка не должна удерживать процесс живым
  timer.unref();

  return timer;
}

// ===========================================================================
// Защита от переполнения памяти Valkey
// ===========================================================================

/**
 * Таймер возобновления воркера после OOM-паузы.
 *
 * `null` означает, что воркер не на паузе. Переменная модуля (а не флаг внутри
 * обработчика) нужна потому, что ошибки приходят потоком: при `maxmemory`
 * каждое событие event loop приносит новый отказ, и без общей переменной
 * на каждый отказ заводился бы свой таймер возобновления.
 */
let oomResumeTimer: NodeJS.Timeout | null = null;

/**
 * Проверяет, что ошибка — отказ Valkey по памяти.
 *
 * @param err - ошибка из события воркера
 * @returns true, если Valkey отверг команду из-за `maxmemory`
 */
function isOomError(err: Error): boolean {
  return err.message.includes('OOM command not allowed when used memory');
}

/**
 * Ставит воркер на паузу из-за переполнения Valkey и планирует возобновление.
 *
 * Логирует ровно одну строку на паузу: при `maxmemory` отказы идут сплошным
 * потоком, и построчный лог каждого превращается в сотни тысяч строк.
 *
 * Повторные вызовы во время паузы игнорируются — таймер уже заведён.
 *
 * @param worker - воркер, который нужно приостановить
 */
function pauseOnOom(worker: BullWorker<JobData, JobResult>): void {
  if (oomResumeTimer) {
    return;
  }

  console.error(
    `[WORKER] Valkey отверг команду: used_memory упёрся в maxmemory. ` +
      `Воркер поставлен на паузу на ${WORKER_OOM_PAUSE_MS / 1000} с и задачи не берёт. ` +
      'Проверьте `docker compose exec valkey valkey-cli info memory` и освободите память ' +
      '(удалите накопленные задачи) — после возобновления отказы повторятся.'
  );

  // pause(true), а не pause(): без аргумента BullMQ ждёт завершения текущих
  // задач (whenCurrentJobsFinished), но при переполнении они не завершатся —
  // их завершение само требует записи в Redis — и пауза зависла бы навсегда
  void worker.pause(true).catch((err: Error) => {
    console.error('[WORKER] Не удалось поставить воркер на паузу:', err.message);
  });

  oomResumeTimer = setTimeout(() => {
    oomResumeTimer = null;
    console.log('[WORKER] Возобновление после OOM-паузы');
    // resume() синхронный и возвращает void. Если к этому моменту воркер
    // закрыт, таймер снят в stopWorker — сюда управление не дойдёт
    worker.resume();
  }, WORKER_OOM_PAUSE_MS);
}

/**
 * Снимает таймер OOM-паузы, если он заведён.
 *
 * Без этого `resume()` сработал бы на закрытом воркере, а BullMQ в этом
 * состоянии не игнорирует вызов, а запускает воркер заново (`if (!this.running)
 * this.run()`), то есть останавливаемый процесс ожил бы.
 */
function clearOomResumeTimer(): void {
  if (oomResumeTimer) {
    clearTimeout(oomResumeTimer);
    oomResumeTimer = null;
  }
}

/**
 * Читает числовое поле из вывода команды `INFO`.
 *
 * @param info - сырой ответ INFO
 * @param field - имя поля, например `used_memory`
 * @returns значение или null, если поля нет
 */
function parseInfoField(info: string, field: string): number | null {
  const match = new RegExp(`^${field}:(\\d+)$`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/**
 * Предупреждает на старте, если память Valkey уже почти выбрана.
 *
 * Разбирать инцидент по одной строке дешевле, чем по сотням тысяч: при
 * переполнении воркер не может ни завершить задачу, ни обрезать упавшие,
 * поэтому первое, что стоит знать, — с какой памятью процесс стартовал.
 * Стоимость проверки — одна команда `INFO memory` за запуск.
 */
async function warnIfValkeyMemoryHigh(): Promise<void> {
  try {
    const client = await getRedisClient();
    const info = await client.info('memory');

    const usedMemory = parseInfoField(info, 'used_memory');
    const maxMemory = parseInfoField(info, 'maxmemory');

    // maxmemory = 0 — лимит не выставлен, предупреждать не о чем
    if (usedMemory === null || !maxMemory) {
      return;
    }

    if (usedMemory > maxMemory * VALKEY_MEMORY_WARN_RATIO) {
      console.warn(
        `[WORKER] Память Valkey почти исчерпана: used_memory ${(usedMemory / 1048576).toFixed(1)} МБ ` +
          `при maxmemory ${(maxMemory / 1048576).toFixed(1)} МБ. ` +
          'Записи будут отвергаться с OOM. Если столько памяти занято сразу после старта — ' +
          'в томе остались данные от прежних версий (проверьте `RDB memory usage when created` ' +
          'в логе Valkey); в тестовом окружении лечится удалением тома.'
      );
    }
  } catch (err) {
    // Диагностика не должна мешать старту: недоступный Valkey обнаружится
    // и без неё — воркер всё равно не сможет работать
    console.warn(
      '[WORKER] Не удалось прочитать память Valkey:',
      (err as Error).message
    );
  }
}

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
  //
  // guardInterval здесь стоял раньше, но такой опции в BullMQ нет — продление
  // блокировки задаётся не интервалом, а производной от lockDuration
  // (lockRenewTime = lockDuration / 2), поэтому настройка лишь создавала
  // впечатление управляемости.
  //
  // maxStalledCount — опция именно Worker: у Queue BullMQ её игнорирует,
  // из-за чего BULLMQ_MAX_STALLED_COUNT из окружения не читался вовсе.
  const workerOptions = {
    connection: redis,
    // Конкуренция - сколько задач обрабатывать одновременно
    concurrency: MAX_CONCURRENT,
    // Настройки блокировки
    lockDuration: BULLMQ_LOCK_DURATION,
    stalledInterval: BULLMQ_STALLED_INTERVAL,
    maxStalledCount: BULLMQ_MAX_STALLED_COUNT,
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
    // Задача может упасть на записи статуса в переполненный Valkey — это тот же
    // отказ по памяти, что и в 'error', и гасится он общей паузой
    if (isOomError(err)) {
      pauseOnOom(worker);
      return;
    }

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
    if (isOomError(err)) {
      pauseOnOom(worker);
      return;
    }

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
    // close() ждёт завершения текущих задач и может не успеть до срабатывания
    // таймера — тогда resume() запустил бы воркер заново прямо во время остановки
    clearOomResumeTimer();
    await worker.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[WORKER] Received SIGINT, stopping...');
    clearOomResumeTimer();
    await worker.close();
    process.exit(0);
  });

  startInputCleanup();

  // Без await: недоступный Valkey и так не даст воркеру работать, но
  // задерживать старт на таймаут подключения диагностика не должна
  void warnIfValkeyMemoryHigh();

  // Прогрев пула — инициализация конвертеров до первых задач. Без await:
  // задача, пришедшая во время прогрева, дождётся того же конвертера
  // (в fork-worker он создаётся по общему промису)
  void warmupPool()
    .then(() => {
      console.log(`[WORKER] Пул прогрет: ${FORK_POOL_SIZE} проц.`);
    })
    .catch((err: Error) => {
      console.error('[WORKER] Прогрев пула не удался:', err.message);
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
    // Таймер снимается до close(): resume() на закрытом воркере не игнорируется,
    // а запускает его заново (см. clearOomResumeTimer)
    clearOomResumeTimer();
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
