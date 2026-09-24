/**
 * Autoscaler воркеров для локального запуска в docker compose.
 *
 * Раз в `AUTOSCALER_POLL_INTERVAL_MS` читает длины очередей BullMQ и приводит
 * число контейнеров-воркеров к вычисленному. В Kubernetes эту роль играет
 * KEDA, и autoscaler там не нужен — он существует потому, что в compose
 * нет ничего, что умело бы масштабировать сервис по внешней метрике.
 *
 * Движок на том конце сокета — Docker или Podman: API у них совместимый,
 * отличаются путь к сокету, права на него и политика SELinux. Что именно
 * требует Podman — в `docker-compose.yml` (сервис autoscaler) и
 * `docs/deployment.md`.
 *
 * Все комментарии на русском языке.
 */

import { pathToFileURL } from 'node:url';
import { COMPLEXITY_TIERS, type ComplexityTier } from '@doc-converter/contract';
import {
  AUTOSCALER_MAX_STEP,
  AUTOSCALER_POLL_INTERVAL_MS,
  AUTOSCALER_WORKER_IMAGE,
  resolveDockerSocketPath,
  SCALING_PROFILES,
} from '@doc-converter/config';
import { getQueue } from '@doc-converter/queue';
import {
  createWorkerContainer,
  imageExists,
  listWorkerContainers,
  ping,
  removeWorkerContainer,
} from './docker-client.js';
import { canScaleDown, computeDesiredReplicas, limitStep } from './autoscaler.js';
import { readScaleDownAt, writeScaleDownAt } from './cooldown.js';

/** Признак того, что получен сигнал завершения. */
let stopping = false;

/**
 * Предельное время чтения очереди.
 *
 * Соединение BullMQ создаётся с `enableOfflineQueue: true` — командой, ждущей
 * недоступный Redis, оно не падает, а копит вызовы. Без этого таймаута цикл
 * масштабирования просто завис бы на первом обращении и перестал реагировать
 * на очереди, которые остались доступны.
 */
const QUEUE_READ_TIMEOUT_MS = 10000;

/**
 * Читает длину очереди.
 *
 * @param tier - уровень сложности
 * @returns число ожидающих и активных задач
 * @throws {Error} - если Redis не ответил за отведённое время
 */
async function readQueueState(tier: ComplexityTier): Promise<{ waiting: number; active: number }> {
  const queue = await getQueue(tier);

  const counts = await Promise.race([
    queue.getJobCounts('wait', 'active'),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Redis не ответил за ${QUEUE_READ_TIMEOUT_MS} мс`)),
        QUEUE_READ_TIMEOUT_MS
      );
      timer.unref();
    }),
  ]);

  return {
    waiting: counts.wait ?? 0,
    active: counts.active ?? 0,
  };
}

/**
 * Пересчитывает число реплик для одного уровня сложности.
 *
 * @param tier - уровень сложности
 */
async function reconcile(tier: ComplexityTier): Promise<void> {
  const profile = SCALING_PROFILES[tier];

  const { waiting, active } = await readQueueState(tier);

  const containers = await listWorkerContainers();
  const mine = containers.filter((item) => item.Labels['doc-converter.tier'] === tier);

  // Реплики делятся на два вида: стартовые из compose (их не удаляем —
  // `restart: unless-stopped` вернёт контейнер, и autoscaler будет
  // бесконечно бороться с compose) и созданные autoscaler'ом
  const base = mine.filter(
    (item) => item.State === 'running' && item.Labels['doc-converter.managed'] !== 'autoscaler'
  );
  const managed = mine.filter(
    (item) => item.State === 'running' && item.Labels['doc-converter.managed'] === 'autoscaler'
  );
  const dead = mine.filter(
    (item) => item.State !== 'running' && item.Labels['doc-converter.managed'] === 'autoscaler'
  );

  // Остановленные реплики удаляются сразу: иначе они копятся и мешают
  // считать текущее число реплик
  for (const container of dead) {
    await removeWorkerContainer(container.Id);
    console.log(`[AUTOSCALER] Удалён остановленный контейнер ${container.Id.slice(0, 12)}`);
  }

  const current = base.length + managed.length;

  // Желаемое число не может быть меньше стартовых реплик compose: они
  // существуют независимо от autoscaler'а
  const desired = Math.max(
    base.length,
    limitStep(
      computeDesiredReplicas(tier, { waiting, active, currentReplicas: current }),
      current,
      AUTOSCALER_MAX_STEP
    )
  );

  if (desired === current) {
    return;
  }

  if (desired > current) {
    const toAdd = desired - current;

    for (let i = 0; i < toAdd; i += 1) {
      try {
        const id = await createWorkerContainer(tier, current + i);

        console.log(
          `[AUTOSCALER] ${tier}: очередь ${waiting} + ${active}, поднята реплика ${id.slice(0, 12)} ` +
            `(${current + i + 1}/${profile.max})`
        );
      } catch (err) {
        console.error(`[AUTOSCALER] ${tier}: не удалось поднять реплику — ${(err as Error).message}`);
        break;
      }
    }

    return;
  }

  const now = Date.now();

  // Отметка читается из Valkey: локальная обнулялась при рестарте, и первый
  // же цикл после деплоя гасил реплики немедленно. Если Valkey недоступен,
  // чтение бросит — цикл по уровням это поймает и пропустит уровень, то есть
  // гашение не выполнится: это безопаснее, чем погасить лишнее
  const lastScaleDownAt = await readScaleDownAt(tier);

  if (!canScaleDown(desired, current, lastScaleDownAt, profile.cooldownMs, now)) {
    return;
  }

  // Гасятся только реплики autoscaler'а — стартовые остаются на месте
  const toRemove = Math.min(current - desired, managed.length);

  // Гасить нечего: отметку в этом случае не трогаем, иначе время остывания
  // обновлялось бы на каждом цикле и снижение откладывалось бы бесконечно
  if (toRemove === 0) {
    return;
  }

  for (let i = 0; i < toRemove; i += 1) {
    const victim = managed[managed.length - 1 - i];

    if (!victim) {
      break;
    }

    try {
      await removeWorkerContainer(victim.Id);
      console.log(`[AUTOSCALER] ${tier}: очередь разобрана, погашена реплика ${victim.Id.slice(0, 12)}`);
    } catch (err) {
      console.error(`[AUTOSCALER] ${tier}: не удалось погасить реплику — ${(err as Error).message}`);
    }
  }

  await writeScaleDownAt(tier, now);
}

/**
 * Один цикл пересчёта по всем уровням сложности.
 */
async function tick(): Promise<void> {
  for (const tier of COMPLEXITY_TIERS) {
    try {
      await reconcile(tier);
    } catch (err) {
      // Падение на одной очереди не должно останавливать масштабирование
      // остальных: чаще всего это временная недоступность Docker API
      console.error(`[AUTOSCALER] ${tier}: ошибка цикла — ${(err as Error).message}`);
    }
  }
}

/**
 * Запускает цикл масштабирования.
 */
async function main(): Promise<void> {
  // Путь нужен для строки в логе: он попадает и в отказ, но там его называет
  // клиент — он один знает и путь, и код ошибки соединения
  const socketPath = resolveDockerSocketPath();
  const probe = await ping();

  if (!probe.ok) {
    throw new Error(
      `${probe.reason ?? 'Docker API недоступен: нет ответа'}\n` +
        'Сокет движка должен быть смонтирован в контейнер: docs/deployment.md'
    );
  }

  console.log(`[AUTOSCALER] Сокет ${socketPath}, движок ${probe.engine ?? 'не определён'}`);

  if (!(await imageExists(AUTOSCALER_WORKER_IMAGE))) {
    // Не ошибка: образ может появиться позже (идёт сборка). Но без него
    // масштабирование не заработает, и причина должна быть видна сразу
    console.warn(
      `[AUTOSCALER] Образ ${AUTOSCALER_WORKER_IMAGE} не найден локально — ` +
        'реплики не будут подниматься до его сборки'
    );
  }

  console.log(
    `[AUTOSCALER] Запущен: интервал ${AUTOSCALER_POLL_INTERVAL_MS} мс, ` +
      `шаг не более ${AUTOSCALER_MAX_STEP} реплик за цикл`
  );

  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, AUTOSCALER_POLL_INTERVAL_MS));
  }
}

process.on('SIGTERM', () => {
  stopping = true;
  console.log('[AUTOSCALER] Получен SIGTERM, остановка');
  process.exit(0);
});

process.on('SIGINT', () => {
  stopping = true;
  process.exit(0);
});

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('[AUTOSCALER] Не удалось запустить:', (err as Error).message);
    process.exit(1);
  });
}

export { computeDesiredReplicas, limitStep, canScaleDown } from './autoscaler.js';
export default { main };
