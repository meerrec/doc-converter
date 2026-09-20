/**
 * Воркер конвертации: одна очередь, один soffice, одна задача за раз.
 *
 * `concurrency: 1` здесь не настройка производительности, а требование
 * корректности: UNO не потокобезопасен, и вторая одновременная конвертация
 * в том же soffice-процессе приводит к порче документа и падению бриджа.
 * Параллелизм достигается только репликами — их число регулирует
 * autoscaler (в локальном запуске) или KEDA (в Kubernetes).
 *
 * Очередь задаётся переменной `WORKER_QUEUE`: одна реплика обслуживает
 * ровно один уровень сложности, иначе разделение очередей теряет смысл.
 *
 * Все комментарии на русском языке.
 */

import { pathToFileURL } from 'node:url';
import type { Job } from 'bullmq';
import { isComplexityTier } from '@doc-converter/contract';
import { getRedisConnection, closeRedisClient } from '@doc-converter/queue';
import { queueName, WORKER_OPTIONS } from '@doc-converter/queue';
import { processJob, type UnoJobData, type UnoJobResult } from './processor.js';
import { WORKER_CONCURRENCY, WORKER_QUEUE } from '@doc-converter/config';

/**
 * Проверяет, что очередь из окружения известна.
 *
 * Опечатка в `WORKER_QUEUE` иначе привела бы к воркеру, который слушает
 * несуществующую очередь и молча простаивает.
 *
 * @param value - значение переменной окружения
 * @returns имя очереди
 */
function resolveTier(value: string): 'light' | 'medium' | 'heavy' {
  if (!isComplexityTier(value)) {
    throw new Error(
      `Неизвестная очередь «${value}»: ожидается light, medium или heavy`
    );
  }

  return value;
}

/** Созданный воркер — нужен для корректного завершения процесса. */
let workerInstance: { close: () => Promise<void> } | null = null;

/**
 * Создаёт и запускает воркер.
 *
 * @returns созданный воркер
 */
export async function createWorker(): Promise<unknown> {
  const tier = resolveTier(WORKER_QUEUE);
  const name = queueName(tier);

  // Ленивая загрузка: bullmq тянет за собой msgpackr и Lua-скрипты, а модуль
  // импортируется и в тестах, которым Redis не нужен
  const { Worker: BullWorker } = await import('bullmq');

  const worker = new BullWorker<UnoJobData, UnoJobResult>(
    name,
    async (job: Job<UnoJobData>) => processJob(job.data),
    {
      connection: getRedisConnection(),
      concurrency: WORKER_CONCURRENCY,
      ...WORKER_OPTIONS,
    }
  );

  // Результат может прийти пустым, если задача завершилась не через наш
  // обработчик (например, была снята вручную) — лог не должен падать
  worker.on('completed', (job: Job<UnoJobData>, result?: UnoJobResult) => {
    console.log(
      `[WORKER] Задача ${job.data.jobId} готова: ${result?.sizeBytes ?? 0} Б, ` +
        `${result?.pages ?? 0} стр., ${result?.durationMs ?? 0} мс`
    );
  });

  worker.on('failed', (job: Job<UnoJobData> | undefined, err: Error) => {
    console.error(`[WORKER] Задача ${job?.data.jobId ?? '?'} упала: ${err.message}`);
  });

  worker.on('stalled', (jobId: string) => {
    console.warn(`[WORKER] Задача ${jobId} зависла и будет переобработана`);
  });

  worker.on('error', (err: Error) => {
    console.error(`[WORKER] Ошибка очереди: ${err.message}`);
  });

  workerInstance = worker as unknown as { close: () => Promise<void> };

  console.log(`[WORKER] Очередь ${name}, параллелизм ${WORKER_CONCURRENCY}`);

  return worker;
}

/**
 * Останавливает воркер и закрывает соединения.
 *
 * @param signal - полученный сигнал
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[WORKER] Получен ${signal}, остановка…`);

  try {
    await workerInstance?.close();
    await closeRedisClient();
  } catch (err) {
    console.error(`[WORKER] Ошибка при остановке: ${(err as Error).message}`);
  }

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  createWorker().catch((err: unknown) => {
    console.error('[WORKER] Не удалось запустить воркер:', (err as Error).message);
    process.exit(1);
  });
}

export default { createWorker };
