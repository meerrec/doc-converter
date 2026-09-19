/**
 * Состояние очереди конвертации и опрос статусов.
 *
 * Единственное место, где живёт список задач: компоненты получают готовые
 * данные и колбэки. Отправка идёт через ограничитель параллелизма, а статусы
 * запрашиваются одной пачкой на все активные задачи.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { fetchStatuses, submitConversion } from '../api/conversion';
import { ApiError, buildDownloadUrl } from '../api/client';
import { describeError } from '../api/errors';
import { fileToBase64 } from '../lib/base64';
import { createLimiter, type Limiter } from '../lib/limiter';
import { detectInputFormat, stripExtension } from '../lib/format';
import {
  BATCH_CONCURRENCY,
  BATCH_MIN_INTERVAL_MS,
  MAX_UPLOAD_BYTES,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
} from '../config';
import type {
  ConversionOptions,
  TaskResult,
  TaskStatus,
  TaskStatusResponse,
} from '@doc-converter/contract';

/** Состояние задачи в интерфейсе. */
export type QueueItemStatus =
  /** Файл добавлен, отправка ещё не начата. */
  | 'pending'
  /** Файл кодируется в base64. */
  | 'encoding'
  /** Запрос отправлен, ждём ответа. */
  | 'uploading'
  /** Сервер принял задачу. */
  | TaskStatus
  | 'cancelled';

/** Задача в очереди. */
export interface QueueItem {
  /** Клиентский идентификатор — ключ списка React. */
  id: string;
  file: File;
  /** Идентификатор задачи на сервере (он же key в запросе). */
  taskId: string;
  /** Формат результата, выбранный на момент запуска. */
  outputType: string;
  /** Опции, применённые на момент запуска. */
  options: ConversionOptions;
  /** Имя файла для скачивания. */
  downloadName: string;
  size: number;
  status: QueueItemStatus;
  progress: number;
  result?: TaskResult;
  errorText?: string;
}

/** Действия над очередью. */
type Action =
  | { type: 'add'; items: QueueItem[] }
  | { type: 'patch'; id: string; patch: Partial<QueueItem> }
  | { type: 'remove'; id: string }
  | { type: 'clearFinished' }
  | { type: 'reset' };

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
        (item) => item.status !== 'completed' && item.status !== 'cancelled'
      );

    case 'reset':
      return [];

    default:
      return state;
  }
}

/** Статусы, при которых задача ещё не завершена. */
function isActiveStatus(status: QueueItemStatus): boolean {
  return (
    status === 'pending' ||
    status === 'encoding' ||
    status === 'uploading' ||
    status === 'queued' ||
    status === 'processing' ||
    status === 'unknown'
  );
}

/** Статусы, при которых опрос задачи больше не нужен. */
function isTerminalStatus(status: QueueItemStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Параметры хука. */
export interface UseConversionQueueOptions {
  /** Формат результата, применяемый к новым задачам. */
  outputType: string;
  /** Опции конвертации, применяемые к новым задачам. */
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
  downloadItem: (id: string) => void;
  downloadAll: () => void;
  stats: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
  };
}

/**
 * Управляет очередью конвертации.
 *
 * @param hookOptions - формат результата и опции для новых задач
 * @returns состояние очереди и операции над ней
 */
export function useConversionQueue({
  outputType,
  options,
}: UseConversionQueueOptions): ConversionQueue {
  const [items, dispatch] = useReducer(reducer, []);

  // Актуальные настройки нужны внутри колбэков, которые не должны
  // пересоздаваться при каждом изменении формы
  const settingsRef = useRef({ outputType, options });
  settingsRef.current = { outputType, options };

  // Зеркало списка задач для чтения внутри колбэков и таймера опроса.
  //
  // Читать состояние напрямую нельзя: колбэк, зависящий от items, получает
  // новую идентичность на каждом обновлении прогресса. Для memo(TaskRow) это
  // критично — нестабильные пропсы обнуляют сравнение и перерисовывают все
  // строки таблицы на каждом тике опроса (см. TaskTable).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Ограничитель живёт в ссылке, потому что cancelAll заменяет его новым:
  // значение нужно читать в момент вызова, а не в момент создания
  const limiterRef = useRef<Limiter | null>(null);

  // Таймеры отложенных скачиваний: их нужно снимать при размонтировании и
  // при повторном запуске, иначе клики по скрытым ссылкам продолжат
  // срабатывать после ухода со страницы
  const downloadTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * Возвращает текущий ограничитель, создавая его при первом обращении.
   *
   * Создание ленивое намеренно: аргумент useRef вычисляется на каждом
   * рендере, поэтому ограничитель — объект с очередью, множеством
   * контроллеров и замыканиями — создавался и сразу уходил в мусор на
   * каждом обновлении прогресса.
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
   * Отправляет одну задачу: кодирует файл и ставит его в очередь сервиса.
   */
  const sendItem = useCallback(async (item: QueueItem, signal: AbortSignal) => {
    dispatch({ type: 'patch', id: item.id, patch: { status: 'encoding' } });

    try {
      const data = await fileToBase64(item.file, signal);

      dispatch({ type: 'patch', id: item.id, patch: { status: 'uploading' } });

      const response = await submitConversion(
        {
          taskId: item.taskId,
          filetype: detectInputFormat(item.file.name) ?? '',
          outputtype: item.outputType,
          data,
          title: item.downloadName,
          options: item.options,
        },
        signal
      );

      // Сервер мог ответить готовым результатом, если задача с таким key
      // уже выполнялась ранее — тогда опрос не нужен
      if (response.result) {
        dispatch({
          type: 'patch',
          id: item.id,
          patch: {
            status: 'completed',
            progress: 100,
            result: response.result,
          },
        });
        return;
      }

      dispatch({
        type: 'patch',
        id: item.id,
        patch: { status: 'queued', progress: 0 },
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
  }, [getLimiter]);

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

      const format = detectInputFormat(file.name);

      if (!format) {
        rejected.push(`«${file.name}»: формат не поддерживается`);
        continue;
      }

      const { outputType: currentOutput, options: currentOptions } = settingsRef.current;

      accepted.push({
        id: crypto.randomUUID(),
        file,
        // Идентификатор задачи: UUID укладывается в ограничение сервера
        // в 64 символа и проходит проверку допустимых символов
        taskId: crypto.randomUUID(),
        outputType: currentOutput,
        options: currentOptions,
        downloadName: `${stripExtension(file.name)}.${currentOutput}`,
        size: file.size,
        status: 'pending',
        progress: 0,
      });
    }

    if (accepted.length > 0) {
      dispatch({ type: 'add', items: accepted });
    }

    return rejected;
  }, []);

  /** Запускает все ожидающие задачи через ограничитель. */
  const startAll = useCallback(() => {
    const { outputType: currentOutput, options: currentOptions } = settingsRef.current;

    for (const item of itemsRef.current) {
      if (item.status !== 'pending') {
        continue;
      }

      const prepared: QueueItem = {
        ...item,
        outputType: currentOutput,
        options: currentOptions,
        downloadName: `${stripExtension(item.file.name)}.${currentOutput}`,
      };

      void getLimiter().run((signal) => sendItem(prepared, signal));
    }
  }, [sendItem, getLimiter]);

  /** Отменяет отправку: прерывает запросы и помечает задачи отменёнными. */
  const cancelAll = useCallback(() => {
    getLimiter().clear();
    // Ограничитель одноразовый: после clear() он навсегда помечен очищенным
    // и отвергает новые задачи, поэтому заменяется свежим
    limiterRef.current = createLimiter(BATCH_CONCURRENCY, BATCH_MIN_INTERVAL_MS);

    for (const item of itemsRef.current) {
      if (isActiveStatus(item.status)) {
        dispatch({ type: 'patch', id: item.id, patch: { status: 'cancelled' } });
      }
    }
  }, [getLimiter]);

  /**
   * Повторяет задачу с новым идентификатором.
   *
   * Новый key обязателен: повторный запрос с прежним ключом сервер считает
   * идемпотентным и не запускает конвертацию заново.
   */
  const retryItem = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);

      if (!item) {
        return;
      }

      const restarted: QueueItem = {
        ...item,
        taskId: crypto.randomUUID(),
        status: 'pending',
        progress: 0,
        result: undefined,
        errorText: undefined,
      };

      dispatch({
        type: 'patch',
        id,
        patch: {
          taskId: restarted.taskId,
          status: 'pending',
          progress: 0,
          result: undefined,
          errorText: undefined,
        },
      });

      void getLimiter().run((signal) => sendItem(restarted, signal));
    },
    [sendItem, getLimiter]
  );

  /** Скачивает готовый результат. */
  const downloadItem = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);

      if (!item?.result) {
        return;
      }

      const link = document.createElement('a');
      link.href = buildDownloadUrl(item.result.fileUrl, item.downloadName);
      link.download = item.downloadName;
      document.body.append(link);
      link.click();
      link.remove();
    },
    []
  );

  /** Скачивает все готовые результаты по очереди. */
  const downloadAll = useCallback(() => {
    // Повторное нажатие начинает batch заново, а не добавляет второй поверх
    for (const timer of downloadTimersRef.current) {
      clearTimeout(timer);
    }

    const ready = itemsRef.current.filter(
      (item) => item.status === 'completed' && item.result
    );

    downloadTimersRef.current = ready.map((item, index) =>
      // Небольшая задержка между загрузками: браузеры ограничивают
      // количество одновременных скачиваний
      setTimeout(() => downloadItem(item.id), index * 300)
    );
  }, [downloadItem]);

  // Признак «есть что опрашивать».
  //
  // Раньше зависимостью была строка из идентификаторов активных задач, поэтому
  // каждое завершение задачи перезапускало эффект: опрос обрывался, накопленный
  // интервал сбрасывался и немедленно уходил внеочередной запрос. При сорока
  // завершающихся подряд задачах это давало сорок лишних запросов. Актуальный
  // список задач и так читается через itemsRef, поэтому зависеть достаточно
  // от самого факта наличия активных
  const hasActive = items.some((item) => isActiveStatus(item.status));

  useEffect(() => {
    if (!hasActive) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval = POLL_INTERVAL_MS;
    let stopped = false;

    // Дедлайн ведётся на задачу, а не на эффект: при постоянном потоке задач
    // общий дедлайн истекал бы и «падал» на только что добавленные задачи,
    // которым ждать ещё пять минут
    const deadlines = new Map<string, number>();

    /**
     * Применяет ответ сервера к очереди.
     */
    const applyStatuses = (statuses: TaskStatusResponse[]) => {
      // Индекс строится один раз на пачку: поиск через find внутри цикла
      // давал O(n·m) на каждом тике опроса
      const byTaskId = new Map(itemsRef.current.map((entry) => [entry.taskId, entry]));

      for (const status of statuses) {
        const item = byTaskId.get(status.taskId);

        if (!item) {
          continue;
        }

        if (status.status === 'completed') {
          dispatch({
            type: 'patch',
            id: item.id,
            patch: { status: 'completed', progress: 100, result: status.result },
          });
          continue;
        }

        if (status.status === 'failed') {
          dispatch({
            type: 'patch',
            id: item.id,
            patch: {
              status: 'failed',
              errorText:
                status.error?.message ?? 'Не удалось сконвертировать документ',
            },
          });
          continue;
        }

        if (status.status === 'not_found') {
          dispatch({
            type: 'patch',
            id: item.id,
            patch: {
              status: 'failed',
              errorText: 'Задача не найдена — возможно, истёк срок её хранения',
            },
          });
          continue;
        }

        dispatch({
          type: 'patch',
          id: item.id,
          patch: {
            status: status.status as QueueItemStatus,
            progress: status.progress ?? item.progress,
          },
        });
      }
    };

    /**
     * Выполняет один цикл опроса и планирует следующий.
     */
    const tick = async () => {
      if (stopped) {
        return;
      }

      const now = Date.now();

      const activeIds = itemsRef.current
        .filter((item) => isActiveStatus(item.status) && item.status !== 'pending')
        .map((item) => item.taskId);

      // Дедлайн новой задачи отсчитывается с момента, когда её стало можно
      // опрашивать, а не с запуска эффекта
      for (const taskId of activeIds) {
        if (!deadlines.has(taskId)) {
          deadlines.set(taskId, now + POLL_DEADLINE_MS);
        }
      }

      const active = new Set(activeIds);

      // Завершившиеся задачи перестают занимать память
      for (const taskId of deadlines.keys()) {
        if (!active.has(taskId)) {
          deadlines.delete(taskId);
        }
      }

      // Задачи, ждущие дольше дедлайна, снимаются с опроса. Статус проверяется
      // заново: пока шёл предыдущий запрос, задача могла завершиться
      for (const item of itemsRef.current) {
        const expiresAt = deadlines.get(item.taskId);

        if (expiresAt !== undefined && expiresAt <= now && isActiveStatus(item.status)) {
          deadlines.delete(item.taskId);
          active.delete(item.taskId);

          dispatch({
            type: 'patch',
            id: item.id,
            patch: {
              status: 'failed',
              errorText: 'Превышено время ожидания обработки',
            },
          });
        }
      }

      if (active.size === 0) {
        // Опрашивать пока нечего: все задачи ещё в pending. Цепочку таймеров
        // обрывать нельзя — статусы сменятся на encoding/uploading/queued,
        // но признак hasActive от этого не изменится, эффект не перезапустится,
        // и опрос не заведётся уже никогда. Поэтому ждём и проверяем снова
        timer = setTimeout(() => void tick(), interval);
        return;
      }

      try {
        const statuses = await fetchStatuses([...active], controller.signal);
        applyStatuses(statuses);
        interval = POLL_INTERVAL_MS;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        // Превышен лимит частоты или хранилище временно недоступно — ждём
        // столько, сколько просит сервер (оба ответа несут Retry-After)
        if (
          error instanceof ApiError &&
          (error.status === 429 || error.status === 503)
        ) {
          interval = Math.min(
            (error.retryAfterSec ?? 1) * 1000,
            POLL_MAX_INTERVAL_MS * 4
          );
        } else {
          // Прочие сбои: постепенно снижаем частоту опроса
          interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
        }
      }

      timer = setTimeout(() => void tick(), interval);
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
    // через itemsRef, иначе таймер перезапускался бы на каждом обновлении
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  const stats = useMemo(() => {
    let pending = 0;
    let active = 0;
    let completed = 0;
    let failed = 0;

    for (const item of items) {
      if (item.status === 'pending') {
        pending += 1;
      } else if (item.status === 'completed') {
        completed += 1;
      } else if (item.status === 'failed') {
        failed += 1;
      } else if (!isTerminalStatus(item.status)) {
        active += 1;
      }
    }

    return { total: items.length, pending, active, completed, failed };
  }, [items]);

  return {
    items,
    addFiles,
    removeItem: useCallback((id: string) => dispatch({ type: 'remove', id }), []),
    clearFinished: useCallback(() => dispatch({ type: 'clearFinished' }), []),
    startAll,
    cancelAll,
    retryItem,
    downloadItem,
    downloadAll,
    stats,
  };
}
