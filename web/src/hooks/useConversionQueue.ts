/**
 * Состояние очереди конвертации и опрос статусов.
 *
 * Единственное место, где живёт список задач: компоненты получают готовые
 * данные и колбэки.
 *
 * Отправка идёт через ограничитель параллелизма, а статусы опрашиваются
 * по каждой незавершённой задаче отдельно: батча в новом API нет, поэтому
 * поток запросов ограничивает не размер пачки, а пауза между запусками
 * (см. `STATUS_MIN_INTERVAL_MS`) и то, что задача опрашивается не чаще
 * одного раза в секунду и только пока она в очереди или в работе.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { fetchStatus, submitConversion } from '../api/conversion';
import { ApiError, downloadFromUrl } from '../api/client';
import { describeError, describeJobError } from '../api/errors';
import { createLimiter, type Limiter } from '../lib/limiter';
import { detectInputFormat, stripExtension } from '../lib/format';
import {
  BATCH_CONCURRENCY,
  BATCH_MIN_INTERVAL_MS,
  MAX_UPLOAD_BYTES,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  RESULT_EXTENSION,
} from '../config';
import type {
  ComplexityTier,
  ConversionOptions,
  JobResult,
  JobStatus,
  JobStatusResponse,
} from '@doc-converter/contract';

/**
 * Состояние задачи в интерфейсе.
 *
 * Кроме серверных состояний (`queued`, `processing`, `completed`, `failed`)
 * есть локальные: файл ещё не отправлен, отправляется или отправка отменена.
 */
export type QueueItemStatus =
  /** Файл добавлен, отправка ещё не начата. */
  | 'pending'
  /** Файл отправляется на сервер. */
  | 'submitting'
  /** Состояние с сервера. */
  | JobStatus
  /** Отправка прервана пользователем; на сервере задачи нет. */
  | 'cancelled';

/** Задача в очереди. */
export interface QueueItem {
  /** Клиентский идентификатор — ключ списка React. */
  id: string;
  file: File;
  /** Идентификатор задачи на сервере; появляется после постановки. */
  jobId?: string;
  /** Уровень сложности, назначенный сервером. */
  tier?: ComplexityTier;
  /** Число листов книги, если сервер его определил. */
  sheets?: number | null;
  /** Параметры, зафиксированные на момент запуска. */
  options: ConversionOptions;
  /** Имя файла для скачивания. */
  downloadName: string;
  size: number;
  status: QueueItemStatus;
  /** Когда задача была поставлена — для показа, сколько она идёт. */
  submittedAt?: number;
  /** Ссылка на готовый PDF и срок её жизни. */
  result?: JobResult;
  errorText?: string;
}

/** Действия над очередью. */
type Action =
  | { type: 'add'; items: QueueItem[] }
  | { type: 'patch'; id: string; patch: Partial<QueueItem> }
  | { type: 'remove'; id: string }
  | { type: 'clearFinished' };

/**
 * Применяет действие к очереди.
 *
 * @param state - текущее состояние
 * @param action - действие
 * @returns новое состояние
 */
function reducer(state: QueueItem[], action: Action): QueueItem[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.items];

    case 'patch':
      return state.map((item) =>
        item.id === action.id ? { ...item, ...action.patch } : item
      );

    case 'remove':
      return state.filter((item) => item.id !== action.id);

    case 'clearFinished':
      return state.filter(
        (item) =>
          item.status !== 'completed' &&
          item.status !== 'failed' &&
          item.status !== 'cancelled'
      );

    default:
      return state;
  }
}

/** Состояния, при которых задача ещё не завершена. */
function isActiveStatus(status: QueueItemStatus): boolean {
  return (
    status === 'pending' ||
    status === 'submitting' ||
    status === 'queued' ||
    status === 'processing'
  );
}

/**
 * Проверяет, что задачу нужно опрашивать.
 *
 * @param item - задача очереди
 * @returns true, если у задачи есть идентификатор и незавершённое состояние
 */
function isPollable(item: QueueItem): boolean {
  return (
    item.jobId !== undefined && (item.status === 'queued' || item.status === 'processing')
  );
}

/**
 * Минимальная пауза между циклами опроса (мс).
 *
 * Нужна как страховка от «горячего» цикла: если сроки всех задач уже прошли,
 * следующий цикл без паузы крутился бы на setTimeout(0), сжигая процессор
 * на переборе списка задач.
 */
const MIN_TICK_DELAY_MS = 50;

/** Параметры хука. */
export interface UseConversionQueueOptions {
  /** Параметры конвертации, применяемые к новым задачам. */
  options: ConversionOptions;
}

/** Значение, возвращаемое хуком. */
export interface ConversionQueue {
  items: QueueItem[];
  /** Добавляет файлы в очередь. Возвращает тексты отказов. */
  addFiles: (files: File[]) => string[];
  removeItem: (id: string) => void;
  clearFinished: () => void;
  startAll: () => void;
  cancelAll: () => void;
  retryItem: (id: string) => void;
  downloadAll: () => void;
  stats: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
}

/**
 * Управляет очередью конвертации.
 *
 * @param hookOptions - параметры конвертации для новых задач
 * @returns состояние очереди и операции над ней
 */
export function useConversionQueue({
  options,
}: UseConversionQueueOptions): ConversionQueue {
  const [items, dispatch] = useReducer(reducer, []);

  // Актуальные настройки нужны внутри колбэков, которые не должны
  // пересоздаваться при каждом изменении формы
  const settingsRef = useRef(options);
  settingsRef.current = options;

  // Зеркало списка задач для чтения внутри колбэков и цикла опроса.
  //
  // Читать состояние напрямую нельзя: колбэк, зависящий от items, получает
  // новую идентичность на каждом обновлении, а для memo(TaskRow) это значит
  // перерисовку всех строк таблицы на каждом тике опроса (см. TaskTable).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Ограничитель живёт в ссылке, потому что cancelAll заменяет его новым:
  // значение нужно читать в момент вызова, а не в момент создания
  const limiterRef = useRef<Limiter | null>(null);

  // Таймеры отложенных скачиваний: их нужно снимать при размонтировании
  // и при повторном запуске, иначе клики по скрытым ссылкам продолжат
  // срабатывать после ухода со страницы
  const downloadTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * Возвращает текущий ограничитель, создавая его при первом обращении.
   *
   * Создание ленивое намеренно: аргумент useRef вычисляется на каждом
   * рендере, поэтому ограничитель — объект с очередью, множеством
   * контроллеров и замыканиями — создавался и сразу уходил в мусор.
   *
   * @returns ограничитель, актуальный на момент вызова
   */
  const getLimiter = useCallback((): Limiter => {
    let limiter = limiterRef.current;

    if (limiter === null) {
      limiter = createLimiter(BATCH_CONCURRENCY, BATCH_MIN_INTERVAL_MS);
      limiterRef.current = limiter;
    }

    return limiter;
  }, []);

  useEffect(() => {
    // Ссылки читаются в момент размонтирования: cancelAll мог заменить
    // ограничитель, а список отложенных скачиваний — измениться
    return () => {
      limiterRef.current?.clear();

      for (const timer of downloadTimersRef.current) {
        clearTimeout(timer);
      }
    };
  }, []);

  /**
   * Отправляет одну задачу и запоминает выданный сервером идентификатор.
   */
  const sendItem = useCallback(
    async (item: QueueItem, signal: AbortSignal) => {
      dispatch({ type: 'patch', id: item.id, patch: { status: 'submitting' } });

      try {
        const accepted = await submitConversion(
          { file: item.file, options: item.options },
          signal
        );

        dispatch({
          type: 'patch',
          id: item.id,
          patch: {
            status: accepted.status,
            jobId: accepted.jobId,
            tier: accepted.tier,
            sheets: accepted.sheets,
            submittedAt: Date.now(),
            errorText: undefined,
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          dispatch({ type: 'patch', id: item.id, patch: { status: 'cancelled' } });
          return;
        }

        // Сервер ограничил частоту — приостанавливаем остальные отправки
        if (error instanceof ApiError && error.status === 429 && error.retryAfterSec) {
          getLimiter().pause(error.retryAfterSec * 1000);
        }

        dispatch({
          type: 'patch',
          id: item.id,
          patch: { status: 'failed', errorText: describeError(error) },
        });
      }
    },
    [getLimiter]
  );

  /**
   * Добавляет файлы в очередь, отсеивая неподдерживаемые и слишком крупные.
   */
  const addFiles = useCallback((files: File[]): string[] => {
    const rejected: string[] = [];
    const accepted: QueueItem[] = [];

    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push(
          `«${file.name}»: размер превышает ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} МБ`
        );
        continue;
      }

      if (!detectInputFormat(file.name)) {
        rejected.push(`«${file.name}»: поддерживаются только файлы XLSX и XLS`);
        continue;
      }

      accepted.push({
        id: crypto.randomUUID(),
        file,
        options: settingsRef.current,
        downloadName: `${stripExtension(file.name)}.${RESULT_EXTENSION}`,
        size: file.size,
        status: 'pending',
      });
    }

    if (accepted.length > 0) {
      dispatch({ type: 'add', items: accepted });
    }

    return rejected;
  }, []);

  /** Запускает все ожидающие задачи через ограничитель. */
  const startAll = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.status !== 'pending') {
        continue;
      }

      const prepared: QueueItem = {
        ...item,
        options: settingsRef.current,
        downloadName: `${stripExtension(item.file.name)}.${RESULT_EXTENSION}`,
      };

      void getLimiter().run((signal) => sendItem(prepared, signal));
    }
  }, [sendItem, getLimiter]);

  /**
   * Отменяет отправку: прерывает запросы и помечает задачи отменёнными.
   *
   * Задачи, уже принятые сервером (`queued`, `processing`), отмене не подлежат:
   * их доведёт до конца воркер, и результат появится в списке сам. Поэтому
   * отменяются только те, что ещё не ушли.
   */
  const cancelAll = useCallback(() => {
    getLimiter().clear();
    // Ограничитель одноразовый: после clear() он навсегда помечен очищенным
    // и отвергает новые задачи, поэтому заменяется свежим
    limiterRef.current = createLimiter(BATCH_CONCURRENCY, BATCH_MIN_INTERVAL_MS);

    for (const item of itemsRef.current) {
      if (item.status === 'pending' || item.status === 'submitting') {
        dispatch({ type: 'patch', id: item.id, patch: { status: 'cancelled' } });
      }
    }
  }, [getLimiter]);

  /**
   * Повторяет задачу с новым идентификатором.
   *
   * Прежний jobId не переиспользуется: сервер выдаёт новый на каждый запрос,
   * а состояние прежней задачи остаётся в хранилище до истечения срока.
   * Параметры берутся из формы, а не из прежнего снимка, — так же, как
   * при обычном запуске: пользователь видит панель и ожидает, что применится
   * именно она.
   */
  const retryItem = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);

      if (!item) {
        return;
      }

      const restarted: QueueItem = {
        ...item,
        options: settingsRef.current,
        downloadName: `${stripExtension(item.file.name)}.${RESULT_EXTENSION}`,
        status: 'pending',
        jobId: undefined,
        result: undefined,
        errorText: undefined,
        submittedAt: undefined,
      };

      dispatch({
        type: 'patch',
        id,
        patch: {
          options: restarted.options,
          downloadName: restarted.downloadName,
          status: 'pending',
          jobId: undefined,
          result: undefined,
          errorText: undefined,
          submittedAt: undefined,
        },
      });

      void getLimiter().run((signal) => sendItem(restarted, signal));
    },
    [sendItem, getLimiter]
  );

  /**
   * Скачивает все готовые результаты по очереди.
   *
   * Одиночное скачивание идёт по обычной ссылке в строке задачи, а здесь
   * ссылки открываются программно — с паузой, потому что браузеры
   * ограничивают число одновременных загрузок.
   */
  const downloadAll = useCallback(() => {
    // Повторное нажатие начинает batch заново, а не добавляет второй поверх
    for (const timer of downloadTimersRef.current) {
      clearTimeout(timer);
    }

    const ready = itemsRef.current.filter(
      (item) => item.status === 'completed' && item.result !== undefined
    );

    downloadTimersRef.current = ready.map((item, index) =>
      setTimeout(() => {
        if (item.result) {
          downloadFromUrl(item.result.url, item.downloadName);
        }
      }, index * 300)
    );
  }, []);

  // Признак «есть что опрашивать».
  //
  // Зависимость — только сам факт наличия незавершённых задач: список задач
  // читается через itemsRef, иначе цепочка таймеров перезапускалась бы
  // на каждом завершении задачи и сбрасывала накопленный интервал
  const hasActive = items.some((item) => isActiveStatus(item.status));

  useEffect(() => {
    if (!hasActive) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval = POLL_INTERVAL_MS;
    let stopped = false;

    // Сроки ведутся по задаче, а не по эффекту: при постоянном потоке файлов
    // общий срок истёк бы и «упал» на только что добавленные задачи, которым
    // ждать ещё пятнадцать минут
    const nextPollAt = new Map<string, number>();
    const deadlines = new Map<string, number>();

    // Задачи, по которым запрос уже отправлен. Без этого набора задача,
    // ждущая своей очереди в ограничителе, опрашивалась бы повторно:
    // её срок следующего опроса ещё не отмечен, а цикл уже наступил
    const inFlight = new Set<string>();

    /**
     * Помечает задачу проваленной.
     */
    const fail = (item: QueueItem, errorText: string) => {
      dispatch({ type: 'patch', id: item.id, patch: { status: 'failed', errorText } });
    };

    /**
     * Применяет ответ сервера к задаче.
     */
    const applyStatus = (item: QueueItem, response: JobStatusResponse) => {
      if (response.status === 'failed') {
        fail(
          item,
          response.error
            ? describeJobError(response.error)
            : 'Не удалось сконвертировать документ'
        );
        return;
      }

      if (response.status === 'completed') {
        // Готовый статус без ссылки означает, что результат не сохранился
        // или срок его хранения истёк: скачивать нечего, и обещать
        // пользователю кнопку «Скачать» нельзя
        if (!response.result) {
          fail(item, 'Результат не найден — возможно, истёк срок его хранения');
          return;
        }

        dispatch({
          type: 'patch',
          id: item.id,
          patch: {
            status: 'completed',
            result: response.result,
            tier: response.tier,
          },
        });
        return;
      }

      dispatch({
        type: 'patch',
        id: item.id,
        patch: { status: response.status, tier: response.tier },
      });
    };

    /**
     * Выполняет один цикл опроса и планирует следующий.
     */
    const tick = async () => {
      if (stopped) {
        return;
      }

      const now = Date.now();

      const pollable = itemsRef.current.filter(isPollable);
      const pollableIds = new Set(pollable.map((item) => item.jobId));

      // Память о завершённых задачах больше не нужна
      for (const jobId of deadlines.keys()) {
        if (!pollableIds.has(jobId)) {
          deadlines.delete(jobId);
        }
      }

      for (const jobId of nextPollAt.keys()) {
        if (!pollableIds.has(jobId)) {
          nextPollAt.delete(jobId);
        }
      }

      // Пары «задача — её идентификатор»: держать два параллельных массива
      // нельзя, их индексы разошлись бы при первой же пропущенной задаче
      const due: { item: QueueItem; jobId: string }[] = [];

      for (const item of pollable) {
        const jobId = item.jobId;

        if (jobId === undefined || inFlight.has(jobId)) {
          continue;
        }

        if (!deadlines.has(jobId)) {
          deadlines.set(jobId, now + POLL_DEADLINE_MS);
        }

        const deadline = deadlines.get(jobId);

        if (deadline !== undefined && deadline <= now) {
          deadlines.delete(jobId);
          nextPollAt.delete(jobId);
          fail(item, 'Превышено время ожидания обработки');
          continue;
        }

        if ((nextPollAt.get(jobId) ?? 0) <= now) {
          due.push({ item, jobId });
        }
      }

      if (due.length > 0) {
        for (const entry of due) {
          inFlight.add(entry.jobId);
        }

        const results = await Promise.allSettled(
          due.map((entry) => fetchStatus(entry.jobId, controller.signal))
        );

        // Эффект снят (задачи завершились или страница закрывается) —
        // результат никому не нужен
        if (stopped) {
          return;
        }

        let roundFailed = false;
        const settledAt = Date.now();

        results.forEach((result, index) => {
          const entry = due[index];

          if (entry === undefined) {
            return;
          }

          const { item, jobId } = entry;

          inFlight.delete(jobId);

          if (result.status === 'fulfilled') {
            nextPollAt.set(jobId, settledAt + POLL_INTERVAL_MS);
            applyStatus(item, result.value);
            return;
          }

          const error: unknown = result.reason;

          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }

          // Задача исчезла или идентификатор отвергнут: повторять бессмысленно,
          // а пользователю нужно сказать, что именно случилось
          if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
            nextPollAt.delete(jobId);
            fail(item, describeError(error));
            return;
          }

          // Прочие сбои — временные: задачу не «роняем», а откладываем
          // следующий опрос, иначе одна сетевая ошибка выглядела бы
          // как проваленная конвертация
          roundFailed = true;

          const backoff =
            error instanceof ApiError && (error.status === 429 || error.status === 503)
              ? (error.retryAfterSec ?? 1) * 1000
              : interval;

          nextPollAt.set(jobId, Date.now() + backoff);
        });

        // Успешный цикл возвращает базовый ритм, сбойный — постепенно
        // снижает частоту опроса
        interval = roundFailed ? Math.min(interval * 2, POLL_MAX_INTERVAL_MS) : POLL_INTERVAL_MS;
      }

      // Следующий цикл — к ближайшему сроку; если опрашивать пока нечего
      // (все задачи в pending или отправляются), проверяем очередь снова
      // через базовый интервал: признак hasActive от смены состояния
      // не изменится, и эффект не перезапустится
      let nextAt = Date.now() + interval;

      for (const item of itemsRef.current) {
        if (!isPollable(item) || item.jobId === undefined) {
          continue;
        }

        const at = nextPollAt.get(item.jobId);

        if (at !== undefined && at < nextAt) {
          nextAt = at;
        }
      }

      timer = setTimeout(
        () => void tick(),
        Math.max(MIN_TICK_DELAY_MS, nextAt - Date.now())
      );
    };

    void tick();

    return () => {
      stopped = true;
      controller.abort();

      if (timer) {
        clearTimeout(timer);
      }
    };
    // items намеренно не в зависимостях: актуальное состояние читается
    // через itemsRef, иначе цепочка таймеров перезапускалась бы на каждом
    // изменении списка задач
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  const stats = useMemo(() => {
    let pending = 0;
    let active = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    for (const item of items) {
      if (item.status === 'pending' || item.status === 'submitting') {
        pending += 1;
      } else if (item.status === 'completed') {
        completed += 1;
      } else if (item.status === 'failed') {
        failed += 1;
      } else if (item.status === 'cancelled') {
        cancelled += 1;
      } else {
        active += 1;
      }
    }

    return { total: items.length, pending, active, completed, failed, cancelled };
  }, [items]);

  return {
    items,
    addFiles,
    removeItem: useCallback((id: string) => dispatch({ type: 'remove', id }), []),
    clearFinished: useCallback(() => dispatch({ type: 'clearFinished' }), []),
    startAll,
    cancelAll,
    retryItem,
    downloadAll,
    stats,
  };
}
