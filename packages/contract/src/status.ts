/**
 * Статусы задач и ответы маршрута GET /status.
 */

import { z } from 'zod';

/**
 * Статусы, которые сервис проставляет задаче сам.
 *
 * `unknown` — ключ зарезервирован в Valkey, но статус ещё не записан.
 */
export const TASK_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'unknown',
] as const;

/**
 * Дополнительные статусы пакетного ответа.
 *
 * `not_found` — задачи нет ни в Valkey, ни в очереди.
 * `error` — при разборе задачи возникло исключение.
 */
export const BATCH_ONLY_STATUSES = ['not_found', 'error'] as const;

/**
 * Состояния задачи в очереди BullMQ.
 *
 * Просачиваются в ответ, когда задачи нет в Valkey, но она есть в очереди
 * (`queued: true`). Перечислены для полноты: клиент обязан быть устойчив
 * к незнакомым значениям, а не падать на них.
 */
export const QUEUE_STATES = [
  'waiting',
  'active',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
  'stuck',
] as const;

/** Все статусы, которые может вернуть маршрут статуса. */
export const ALL_STATUSES = [
  ...TASK_STATUSES,
  ...BATCH_ONLY_STATUSES,
  ...QUEUE_STATES,
] as const;

/** Статус задачи. */
export type TaskStatus = (typeof ALL_STATUSES)[number];

/** Статусы, при которых задача ещё не завершена. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'processing',
  'unknown',
  'waiting',
  'active',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
  'stuck',
]);

/** Статусы, при которых опрос задачи больше не нужен. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'not_found',
  'error',
]);

/** Результат успешной конвертации. */
export const taskResultSchema = z.looseObject({
  /** Путь, по которому сервер отдаёт готовый файл. */
  fileUrl: z.string(),
  /** Формат результата. */
  fileType: z.string(),
  size: z.number().optional(),
});

/** Результат успешной конвертации. */
export type TaskResult = z.infer<typeof taskResultSchema>;

/** Ошибка обработки задачи. */
export const taskErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

/** Ошибка обработки задачи. */
export type TaskError = z.infer<typeof taskErrorSchema>;

/**
 * Элемент ответа GET /status.
 *
 * Схема намеренно свободная: набор полей зависит от того, нашлась ли задача
 * в Valkey или только в очереди, и от версии сервиса.
 */
export const taskStatusResponseSchema = z.looseObject({
  taskId: z.string(),
  status: z.string(),
  progress: z.number().optional(),
  result: taskResultSchema.optional(),
  error: taskErrorSchema.optional(),
  /** true, если задача найдена только в очереди BullMQ. */
  queued: z.boolean().optional(),
});

/** Элемент ответа GET /status. */
export type TaskStatusResponse = z.infer<typeof taskStatusResponseSchema>;

/** Ответ пакетного запроса GET /status?taskIds=… */
export const batchStatusResponseSchema = z.looseObject({
  tasks: z.array(taskStatusResponseSchema),
});

/** Ответ пакетного запроса GET /status?taskIds=… */
export type BatchStatusResponse = z.infer<typeof batchStatusResponseSchema>;
