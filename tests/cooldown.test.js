/**
 * Проверки хранения отметок о снижении числа реплик.
 *
 * Valkey подменяется заглушкой: набор не должен требовать инфраструктуры
 * (таково же правило остальных наборов). Проверяется главное свойство —
 * отметка живёт вне процесса, поэтому переживает рестарт автоскейлера.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Окружение задаётся до импорта модулей: config читает его при загрузке
process.env.QUEUE_PREFIX = 'testq';

const { store, state } = vi.hoisted(() => ({
  store: new Map(),
  state: { failNext: false },
}));

vi.mock('../packages/queue/src/connection.js', () => ({
  getRedisClient: async () => ({
    get: async (key) => {
      if (state.failNext) {
        throw new Error('Valkey недоступен');
      }

      return store.get(key) ?? null;
    },
    set: async (key, value) => {
      if (state.failNext) {
        throw new Error('Valkey недоступен');
      }

      store.set(key, value);
    },
  }),
}));

const { readScaleDownAt, writeScaleDownAt } = await import('../apps/autoscaler/src/cooldown.js');

beforeEach(() => {
  store.clear();
  state.failNext = false;
});

describe('отметка о снижении числа реплик', () => {
  it('без записи возвращает ноль — снижения ещё не было', async () => {
    await expect(readScaleDownAt('light')).resolves.toBe(0);
  });

  it('записанная отметка читается обратно', async () => {
    const at = Date.now();

    await writeScaleDownAt('heavy', at);

    await expect(readScaleDownAt('heavy')).resolves.toBe(at);
  });

  it('отметка переживает перезапуск процесса', async () => {
    // Смысл хранения в Valkey: состояние не живёт в памяти автоскейлера,
    // поэтому новый вызов (в реальности — новый процесс) видит прежнее время
    const at = Date.now() - 1000;

    await writeScaleDownAt('medium', at);

    await expect(readScaleDownAt('medium')).resolves.toBe(at);
  });

  it('уровни не делят одну отметку', async () => {
    await writeScaleDownAt('light', 111);
    await writeScaleDownAt('heavy', 222);

    await expect(readScaleDownAt('light')).resolves.toBe(111);
    await expect(readScaleDownAt('heavy')).resolves.toBe(222);
  });

  it('ключ содержит префикс очереди и уровень', async () => {
    await writeScaleDownAt('light', 1);

    expect([...store.keys()]).toEqual(['testq.autoscaler.cooldown.light']);
  });

  it('недоступный Valkey проявляется ошибкой, а не нулём', async () => {
    // Ноль означал бы «снижения не было» и разрешил бы немедленное гашение
    // реплик сразу после рестарта — ровно тот дефект, ради которого отметка
    // перенесена в Valkey. Ошибка же заставляет цикл пропустить уровень
    state.failNext = true;

    await expect(readScaleDownAt('light')).rejects.toThrow('Valkey недоступен');
  });
});
