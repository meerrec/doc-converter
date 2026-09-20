/**
 * Ограничитель параллелизма с паузой между запусками.
 *
 * Нужен, чтобы пакетная конвертация не упиралась в ограничение частоты
 * запросов на сервере: число одновременных отправок ограничено, а между
 * стартами выдерживается минимальный интервал.
 */

/** Задача, которую выполняет ограничитель. */
type LimitedTask<T> = (signal: AbortSignal) => Promise<T>;

/** Ограничитель параллелизма. */
export interface Limiter {
  /**
   * Ставит задачу в очередь на выполнение.
   *
   * @param task - функция, выполняющая работу; получает сигнал отмены
   * @returns результат выполнения
   */
  run: <T>(task: LimitedTask<T>) => Promise<T>;
  /** Приостанавливает запуск новых задач на указанное время (мс). */
  pause: (ms: number) => void;
  /** Отменяет ожидающие и выполняющиеся задачи. */
  clear: () => void;
}

/** Запись очереди. */
interface QueueEntry {
  task: LimitedTask<never>;
  resolve: (value: never) => void;
  reject: (reason: unknown) => void;
}

/**
 * Создаёт ограничитель параллелизма.
 *
 * @param concurrency - сколько задач выполняется одновременно
 * @param minIntervalMs - минимальная пауза между запусками задач
 * @returns ограничитель
 */
export function createLimiter(concurrency: number, minIntervalMs: number): Limiter {
  const queue: QueueEntry[] = [];
  const controllers = new Set<AbortController>();
  let active = 0;
  let lastStartAt = 0;
  let pausedUntil = 0;
  let cleared = false;

  /**
   * Запускает следующую задачу, если есть свободный слот и прошла пауза.
   */
  function pump(): void {
    if (cleared || active >= concurrency || queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitUntil = Math.max(lastStartAt + minIntervalMs, pausedUntil);

    if (now < waitUntil) {
      // Ждём до ближайшего разрешённого момента и пробуем снова
      setTimeout(pump, waitUntil - now);
      return;
    }

    const entry = queue.shift();

    if (!entry) {
      return;
    }

    const controller = new AbortController();
    controllers.add(controller);
    active += 1;
    lastStartAt = now;

    entry
      .task(controller.signal)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        controllers.delete(controller);
        active -= 1;
        pump();
      });
  }

  return {
    run<T>(task: LimitedTask<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (cleared) {
          reject(new DOMException('Очередь очищена', 'AbortError'));
          return;
        }

        queue.push({
          task: task as LimitedTask<never>,
          resolve: resolve as (value: never) => void,
          reject,
        });

        pump();
      });
    },

    pause(ms: number): void {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },

    clear(): void {
      cleared = true;

      // Прерываем выполняющиеся запросы
      for (const controller of controllers) {
        controller.abort();
      }

      controllers.clear();

      // Отклоняем промисы задач, которые так и не стартовали
      const pending = queue.splice(0, queue.length);

      for (const entry of pending) {
        entry.reject(new DOMException('Задача отменена', 'AbortError'));
      }
    },
  };
}
