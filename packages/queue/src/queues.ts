/**
 * Очереди задач конвертации — по одной на уровень сложности.
 *
 * Разделение на три очереди нужно из-за того, что одна конвертация занимает
 * воркер целиком (UNO не потокобезопасен, `concurrency: 1`). В общей очереди
 * крупная книга на несколько минут задерживала бы мелкие файлы, которые
 * прошли бы за секунды; отдельные очереди позволяют масштабировать тяжёлые
 * и лёгкие воркеры независимо.
 *
 * `bullmq` грузится лениво: модуль очереди импортируется и API (при постановке
 * задачи), и тестами, которым Redis не нужен.
 *
 * Все комментарии на русском языке.
 */

import type { Queue } from 'bullmq';
import type { ComplexityTier } from '@doc-converter/contract';
import {
  BULLMQ_LOCK_DURATION,
  BULLMQ_MAX_STALLED_COUNT,
  BULLMQ_STALLED_INTERVAL,
  FAILED_JOB_TTL_SEC,
  JOB_ATTEMPTS,
  MAX_FAILED_JOBS,
  QUEUE_PREFIX,
} from '@doc-converter/config';
import { createQueueRedisClient } from './connection.js';

/**
 * Имя очереди для уровня сложности.
 *
 * @param tier - уровень сложности
 * @returns имя очереди в Redis
 */
export function queueName(tier: ComplexityTier): string {
  return `${QUEUE_PREFIX}.${tier}`;
}

/** Созданные очереди — по одной на уровень. */
const queues = new Map<ComplexityTier, Queue>();

/**
 * Возвращает очередь уровня сложности, создавая её при первом обращении.
 *
 * @param tier - уровень сложности
 * @returns очередь BullMQ
 */
export async function getQueue(tier: ComplexityTier): Promise<Queue> {
  const existing = queues.get(tier);

  if (existing) {
    return existing;
  }

  const { Queue: BullQueue } = await import('bullmq');

  const queue = new BullQueue(queueName(tier), {
    connection: createQueueRedisClient(),
    defaultJobOptions: {
      // Повтор при ошибке конвертации не помогает: битый документ не станет
      // валидным. Инфраструктурные сбои обрабатывает stalled-механизм
      attempts: JOB_ATTEMPTS,
      // Успешные задачи не хранятся: результат лежит в объектном хранилище,
      // а состояние — в отдельной записи `job:{id}`
      removeOnComplete: true,
      removeOnFail: {
        age: FAILED_JOB_TTL_SEC,
        count: MAX_FAILED_JOBS,
      },
    },
  });

  queues.set(tier, queue);

  return queue;
}

/**
 * Опции воркера для очереди.
 *
 * Вынесены сюда, чтобы воркер и autoscaler считали зависшие задачи
 * по одним и тем же правилам.
 */
export const WORKER_OPTIONS = {
  lockDuration: BULLMQ_LOCK_DURATION,
  stalledInterval: BULLMQ_STALLED_INTERVAL,
  maxStalledCount: BULLMQ_MAX_STALLED_COUNT,
} as const;

/**
 * Ставит задачу в очередь.
 *
 * `jobId` равен идентификатору задачи сервиса: повторная постановка того же
 * идентификатора игнорируется BullMQ, поэтому двойная отправка запроса
 * не запускает вторую конвертацию.
 *
 * @param tier - уровень сложности
 * @param jobId - идентификатор задачи
 * @param data - данные задачи
 */
export async function addJob(
  tier: ComplexityTier,
  jobId: string,
  data: Record<string, unknown>
): Promise<void> {
  const queue = await getQueue(tier);
  await queue.add(queueName(tier), data, { jobId });
}

/**
 * Закрывает все созданные очереди.
 *
 * Нужно при завершении процесса: соединения очередей живут отдельно
 * от клиента приложения и не закрываются вместе с ним.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export default {
  queueName,
  getQueue,
  addJob,
  closeQueues,
  WORKER_OPTIONS,
};
