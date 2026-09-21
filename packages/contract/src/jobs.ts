/**
 * Состояния задачи конвертации и уровни её сложности.
 *
 * Обе шкалы — часть внешнего контракта: `status` показывается в интерфейсе,
 * а `tier` определяет, в какую очередь попадёт задача, и его полезно видеть
 * клиенту для диагностики («почему мой файл ждёт дольше остальных»).
 */

/**
 * Состояния задачи.
 *
 * `queued` — задача поставлена в очередь и ждёт свободный воркер;
 * `processing` — воркер взял задачу и конвертирует её;
 * `completed` — PDF готов и лежит в хранилище;
 * `failed` — конвертация не удалась, причина в поле `error`.
 */
export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;

/** Состояние задачи. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Уровни сложности — по одному на очередь.
 *
 * Разделение нужно потому, что одна конвертация занимает ровно один воркер
 * (UNO не потокобезопасен): без разделения крупный файл на минуты задерживал бы
 * очередь мелких, которые могли бы пройти за секунды.
 */
export const COMPLEXITY_TIERS = ['light', 'medium', 'heavy'] as const;

/** Уровень сложности задачи. */
export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];

/**
 * Проверяет, что значение — известный уровень сложности.
 *
 * @param value - проверяемое значение
 * @returns true, если уровень известен
 */
export function isComplexityTier(value: unknown): value is ComplexityTier {
  return typeof value === 'string' && (COMPLEXITY_TIERS as readonly string[]).includes(value);
}

/**
 * Проверяет, что значение — известное состояние задачи.
 *
 * @param value - проверяемое значение
 * @returns true, если состояние известно
 */
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}
