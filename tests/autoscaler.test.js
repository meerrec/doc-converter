/**
 * Проверки правил автомасштабирования.
 *
 * Расчёт отделён от обращения к Docker и Redis (`computeDesiredReplicas` —
 * чистая функция), поэтому проверяется без поднятия инфраструктуры.
 * Ошибка в этих правилах стоит дорого: слишком агрессивное масштабирование
 * съедает память хоста, слишком робкое — копит очередь.
 */

import { describe, it, expect } from 'vitest';

const { computeDesiredReplicas, limitStep, canScaleDown } = await import(
  '../src/autoscaler/autoscaler.js'
);

const { SCALING_PROFILES } = await import('../src/config/index.js');

describe('Автомасштабирование: расчёт числа реплик', () => {
  it('пустая очередь опускает лёгкие воркеры до минимума', () => {
    const desired = computeDesiredReplicas('light', {
      waiting: 0,
      active: 0,
      currentReplicas: 3,
    });

    expect(desired).toBe(SCALING_PROFILES.light.min);
  });

  it('тяжёлая очередь не опускается ниже одной реплики', () => {
    const desired = computeDesiredReplicas('heavy', {
      waiting: 0,
      active: 0,
      currentReplicas: 2,
    });

    expect(desired).toBe(1);
  });

  it('каждая тяжёлая задача требует отдельной реплики', () => {
    // jobsPerReplica = 1: две задачи в очереди — это две реплики
    const desired = computeDesiredReplicas('heavy', {
      waiting: 2,
      active: 0,
      currentReplicas: 1,
    });

    expect(desired).toBe(2);
  });

  it('лёгкие задачи идут по пять на реплику', () => {
    const desired = computeDesiredReplicas('light', {
      waiting: 11,
      active: 0,
      currentReplicas: 1,
    });

    // 11 / 5 = 2.2, округление вверх даёт 3
    expect(desired).toBe(3);
  });

  it('активные задачи считаются вместе с ожидающими', () => {
    // Реплика, занятая конвертацией, для очереди недоступна: если считать
    // только waiting, воркеры будут вечно догонять нагрузку
    const desired = computeDesiredReplicas('medium', {
      waiting: 1,
      active: 1,
      currentReplicas: 1,
    });

    expect(desired).toBe(1);

    const more = computeDesiredReplicas('medium', {
      waiting: 2,
      active: 2,
      currentReplicas: 1,
    });

    expect(more).toBe(2);
  });

  it('не превышает потолок реплик', () => {
    const desired = computeDesiredReplicas('heavy', {
      waiting: 100,
      active: 0,
      currentReplicas: 1,
    });

    expect(desired).toBe(SCALING_PROFILES.heavy.max);
  });
});

describe('Автомасштабирование: ограничение шага', () => {
  it('рост ограничивается одним шагом', () => {
    expect(limitStep(10, 1, 1)).toBe(2);
  });

  it('снижение ограничивается одним шагом', () => {
    expect(limitStep(1, 5, 1)).toBe(4);
  });

  it('совпадение не меняет число реплик', () => {
    expect(limitStep(3, 3, 1)).toBe(3);
  });
});

describe('Автомасштабирование: остывание', () => {
  it('снижение откладывается на время остывания', () => {
    const cooldown = SCALING_PROFILES.medium.cooldownMs;
    const lastScaleDown = 1_000_000;

    // Прошло меньше времени остывания — снижать нельзя
    expect(canScaleDown(1, 3, lastScaleDown, cooldown, lastScaleDown + 1000)).toBe(false);

    // Остывание истекло
    expect(canScaleDown(1, 3, lastScaleDown, cooldown, lastScaleDown + cooldown)).toBe(true);
  });

  it('рост не зависит от остывания', () => {
    expect(canScaleDown(5, 2, Date.now(), 600000, Date.now())).toBe(true);
  });
});
