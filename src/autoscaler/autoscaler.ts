/**
 * Логика автомасштабирования воркеров по длине очередей.
 *
 * В Kubernetes ту же задачу решает KEDA (`deploy/k8s/scaledobject-*.yaml`),
 * а здесь — сервис в compose: он читает длины очередей BullMQ и приводит
 * число контейнеров-воркеров к вычисленному.
 *
 * Расчёт отделён от побочных эффектов (`computeDesiredReplicas` — чистая
 * функция), потому что правила масштабирования нужно проверять тестами
 * без запуска Docker и Redis.
 *
 * Все комментарии на русском языке.
 */

import type { ComplexityTier } from '@doc-converter/contract';
import { SCALING_PROFILES, type ScalingProfile } from '../config/index.js';

/** Состояние очереди, на основании которого принимается решение. */
export interface QueueState {
  /** Задачи, ожидающие воркера. */
  waiting: number;
  /** Задачи, которые прямо сейчас обрабатываются. */
  active: number;
  /** Текущее число реплик. */
  currentReplicas: number;
}

/**
 * Вычисляет желаемое число реплик.
 *
 * Правило повторяет подход KEDA: пока очередь меньше порога активации,
 * работают только минимальные реплики; дальше число реплик — это длина
 * очереди, поделённая на `jobsPerReplica` с округлением вверх. Активные
 * задачи считаются вместе с ожидающими: реплика, занятая конвертацией,
 * для очереди недоступна.
 *
 * @param tier - уровень сложности
 * @param state - состояние очереди и текущее число реплик
 * @returns желаемое число реплик
 */
export function computeDesiredReplicas(tier: ComplexityTier, state: QueueState): number {
  const profile: ScalingProfile = SCALING_PROFILES[tier];
  const backlog = state.waiting + state.active;

  if (backlog < profile.activationQueueLength) {
    return profile.min;
  }

  const byLoad = Math.ceil(backlog / profile.jobsPerReplica);

  return Math.min(profile.max, Math.max(profile.min, byLoad));
}

/**
 * Ограничивает изменение числа реплик за один цикл.
 *
 * Реплика поднимается несколько секунд и занимает сотни мегабайт, поэтому
 * мгновенный переход «1 → 10» выедает память хоста быстрее, чем приходят
 * задачи. Ограничение шага размазывает рост на несколько циклов опроса.
 *
 * @param desired - желаемое число реплик
 * @param current - текущее число реплик
 * @param maxStep - предельный шаг
 * @returns число реплик после ограничения шага
 */
export function limitStep(desired: number, current: number, maxStep: number): number {
  if (desired > current) {
    return Math.min(desired, current + maxStep);
  }

  if (desired < current) {
    return Math.max(desired, current - maxStep);
  }

  return desired;
}

/**
 * Решает, можно ли снижать число реплик.
 *
 * Снижение откладывается на время остывания: очередь, разобранная
 * за секунды, не должна приводить к удалению реплики и её немедленному
 * подъёму на следующей задаче.
 *
 * @param desired - желаемое число реплик
 * @param current - текущее число реплик
 * @param lastScaleDownAt - время последнего снижения (мс, epoch)
 * @param cooldownMs - время остывания
 * @param now - текущее время (мс, epoch)
 * @returns true, если снижать можно
 */
export function canScaleDown(
  desired: number,
  current: number,
  lastScaleDownAt: number,
  cooldownMs: number,
  now: number
): boolean {
  if (desired >= current) {
    return true;
  }

  return now - lastScaleDownAt >= cooldownMs;
}

export default { computeDesiredReplicas, limitStep, canScaleDown };
