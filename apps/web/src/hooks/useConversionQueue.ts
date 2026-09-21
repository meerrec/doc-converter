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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { fetchStatus, submitConversion } from '../api/conversion';
import { ApiError, downloadFromUrl } from '../api/client';
import { describeError, describeJobError } from '../api/errors';
import { createLimiter, type Limiter } from '../lib/limiter';
import { detectInputFormat, stripExtension } from '../lib/format';
import {
  BATCH_CONCURRENCY,
  BATCH_MIN_INTERVAL_MS,
  CLOCK_TICK_MS,
  MAX_UPLOAD_BYTES,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  RESULT_EXTENSION,
} from '../config';
import { INPUT_FORMATS } from '@doc-converter/contract/formats';
import type {
  ComplexityTier,
  ConversionOptions,
  InputFormat,
  JobResult,
  JobStatus,
  JobStatusResponse,
} from '@doc-converter/contract';

/** Список поддерживаемых форматов для сообщений об отказе. */
const FORMAT_LIST = INPUT_FORMATS.map((format) => format.toUpperCase()).join(', ');

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
  /** Формат файла, определённый сервером по содержимому. */
  inputFormat?: InputFormat;
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

/**
 * Файл, отклонённый при добавлении.
 *
 * Идентификатор нужен как ключ списка React: текст отказа собирается
 * из имени файла и причины, поэтому у двух файлов с одинаковым именем
 * и одинаковой причиной он совпадёт, а дубли ключей React не допускает.
 */
export interface RejectedFile {
  /** Клиентский идентификатор — ключ списка React. */
  id: string;
  /** Текст отказа для показа пользователю. */
  message: string;
}

/** Действия над очередью. */
type Action =
  | { type: 'add'; items: QueueItem[] }
  | { type: 'patch'; id: string; patch: Partial<QueueItem> }
  | { type: 'startPending' }
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

    case 'startPending':
      // Одним проходом, а не N действиями `patch`: каждый `patch` — это
      // отдельный `map` по списку, и на большой пачке вышел бы квадрат
      return state.map((item) =>
        item.status === 'pending' ? { ...item, status: 'submitting' } : item
      );

    case 'remove':
      return state.filter((item) => item.id !== action.id);

    case 'clearFinished':
      return state.filter((item) => !isFinishedStatus(item.status));

    default:
      return state;
  }
}

/**
 * Состояния, при которых задача отправлена и ещё не завершена.
 *
 * `pending` сюда не входит: файл ещё не ушёл на сервер, и показывать
 * счётчик времени нечего.
 *
 * @param status - состояние задачи
 * @returns true, если задача выполняется
 */
export function isWorkingStatus(status: QueueItemStatus): boolean {
  return status === 'submitting' || status === 'queued' || status === 'processing';
}

/**
 * Состояния, при которых задача завершена.
 *
 * @param status - состояние задачи
 * @returns true, если задача больше не изменится
 */
function isFinishedStatus(status: QueueItemStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
  /**
   * Текущее время на момент последнего такта часов.
   *
   * Нужно строкам таблицы: счётчик идущей задачи и срок действия ссылки
   * считаются от него, а не от `Date.now()` в рендере.
   */
  now: number;
  /** Добавляет файлы в очередь. Возвращает отклонённые файлы с причинами. */
  addFiles: (files: File[]) => RejectedFile[];
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

  // Часы интерфейса. Начальное значение берётся лениво, чтобы не звать
  // Date.now() на каждом рендере — оно нужно только как стартовая точка.
  const [now, setNow] = useState(() => Date.now());

  // Актуальные настройки нужны внутри колбэков, которые не должны
  // пересоздаваться при каждом изменении формы
  const settingsRef = useRef(options);

  // Зеркало списка задач для чтения внутри колбэков и цикла опроса.
  //
  // Читать состояние напрямую нельзя: колбэк, зависящий от items, получает
  // новую идентичность на каждом обновлении, а для memo(TaskRow) это значит
  // перерисовку всех строк таблицы на каждом тике опроса (см. TaskTable).
  const itemsRef = useRef(items);

  // Зеркала обновляются после коммита, а не в теле рендера: запись в ref
  // во время рендера — побочный эффект, который ломается при прерывании
  // или повторном выполнении рендера (React 19, StrictMode в main.tsx).
  //
  // Layout-эффект, а не пассивный: он выполняется синхронно в фазе коммита,
  // то есть строго до отрисовки и до любого пользовательского события.
  // Пассивный эффект таких гарантий не даёт — клик, пришедший до его
  // выполнения, увидел бы на одно обновление устаревшее зеркало.
  //
  // Отставшая ссылка читателям не грозит и здесь: все они — обработчики
  // событий и колбэки таймеров, а они выполняются только после коммита.
  useLayoutEffect(() => {
    settingsRef.current = options;
    itemsRef.current = items;
  });

  // Ограничитель живёт в ссылке, потому что cancelAll заменяет его новым:
  // значение нужно читать в момент вызова, а не в момент создания
  const limiterRef = useRef<Limiter | null>(null);

  // Таймеры отложенных скачиваний: их нужно снимать при размонтировании
  // и при повторном запуске, иначе клики по скрытым ссылкам продолжат
  // срабатывать после ухода со страницы.
  //
  // Ключ — идентификатор задачи, а не просто список: задача может исчезнуть
  // из очереди (убрана вручную или кнопкой «Очистить завершённые»), пока
  // её скачивание ещё ждёт своей очереди, и снять таймер нужно точечно.
  const downloadTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

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
    // Карта берётся в момент подписки: сам объект не заменяется никогда,
    // а `ref.current` внутри очистки может к тому времени указывать на другое
    const downloadTimers = downloadTimersRef.current;

    return () => {
      // Ограничитель, в отличие от карты, читается в момент размонтирования:
      // cancelAll заменяет его новым
      limiterRef.current?.clear();

      for (const timer of downloadTimers.values()) {
        clearTimeout(timer);
      }

      downloadTimers.clear();
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
            inputFormat: accepted.inputFormat,
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
  const addFiles = useCallback((files: File[]): RejectedFile[] => {
    const rejected: RejectedFile[] = [];
    const accepted: QueueItem[] = [];

    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push({
          id: crypto.randomUUID(),
          message: `«${file.name}»: размер превышает ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} МБ`,
        });
        continue;
      }

      if (!detectInputFormat(file.name)) {
        rejected.push({
          id: crypto.randomUUID(),
          message: `«${file.name}»: поддерживаются только файлы ${FORMAT_LIST}`,
        });
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
    // Намерение отправить фиксируется синхронно, до постановки в ограничитель.
    // Ограничитель запускает задачи не сразу (BATCH_CONCURRENCY и пауза
    // BATCH_MIN_INTERVAL_MS), и всё это время задача оставалась бы `pending`.
    // Кнопка «Конвертировать» активна, пока есть `pending`, поэтому второй
    // клик отправил бы те же файлы ещё раз — два POST и две задачи на сервере.
    //
    // Список ниже читается через itemsRef уже после dispatch: ссылка обновится
    // только в коммите, а здесь нужен текущий состав пачки — ровно тот,
    // который отмечается этим действием.
    dispatch({ type: 'startPending' });

    for (const item of itemsRef.current) {
      if (item.status !== 'pending') {
        continue;
      }

      const prepared: QueueItem = {
        ...item,
        options: settingsRef.current,
        downloadName: `${stripExtension(item.file.name)}.${RESULT_EXTENSION}`,
      };

      // Ограничитель отклоняет задачу при отмене (`clear` в cancelAll)
      // и на очищенном ограничителе. Статусы в этом случае уже проставлены
      // самим cancelAll, поэтому отказ здесь только гасится — иначе он всплыл
      // бы как необработанный и засорил консоль и сборщик ошибок.
      // Собственные ошибки sendItem не пробрасывает: внутри он их разбирает
      // и переводит задачу в `failed`.
      getLimiter()
        .run((signal) => sendItem(prepared, signal))
        .catch(() => undefined);
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

      // Состояние сразу `submitting`, а не `pending`: задача уходит
      // в ограничитель этой же строкой, а `pending` оставил бы её видимой
      // для повторного запуска кнопкой «Конвертировать» (см. startAll)
      const restarted: QueueItem = {
        ...item,
        options: settingsRef.current,
        downloadName: `${stripExtension(item.file.name)}.${RESULT_EXTENSION}`,
        status: 'submitting',
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
          status: 'submitting',
          jobId: undefined,
          result: undefined,
          errorText: undefined,
          submittedAt: undefined,
        },
      });

      // См. startAll: отказ означает отмену, статусы проставлены cancelAll
      getLimiter()
        .run((signal) => sendItem(restarted, signal))
        .catch(() => undefined);
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
    for (const timer of downloadTimersRef.current.values()) {
      clearTimeout(timer);
    }

    downloadTimersRef.current.clear();

    const ready = itemsRef.current.filter(
      (item) => item.status === 'completed' && item.result !== undefined
    );

    ready.forEach((item, index) => {
      downloadTimersRef.current.set(
        item.id,
        setTimeout(() => {
          // Таймер отработал — из карты его убираем, чтобы она не росла
          downloadTimersRef.current.delete(item.id);

          if (item.result) {
            downloadFromUrl(item.result.url, item.downloadName);
          }
        }, index * 300)
      );
    });
  }, []);

  /**
   * Снимает отложенное скачивание задачи, если оно ещё не сработало.
   *
   * @param id - идентификатор задачи
   */
  const cancelDownload = useCallback((id: string) => {
    const timer = downloadTimersRef.current.get(id);

    if (timer !== undefined) {
      clearTimeout(timer);
      downloadTimersRef.current.delete(id);
    }
  }, []);

  /**
   * Убирает задачу из списка, отменяя её отложенное скачивание.
   *
   * @param id - идентификатор задачи
   */
  const removeItem = useCallback(
    (id: string) => {
      // Иначе клик по ссылке удалённой задачи всё равно сработает:
      // пользователь убрал строку, а файл скачается через долю секунды
      cancelDownload(id);
      dispatch({ type: 'remove', id });
    },
    [cancelDownload]
  );

  /** Убирает завершённые задачи, отменяя их отложенные скачивания. */
  const clearFinished = useCallback(() => {
    for (const item of itemsRef.current) {
      if (isFinishedStatus(item.status)) {
        cancelDownload(item.id);
      }
    }

    dispatch({ type: 'clearFinished' });
  }, [cancelDownload]);

  // Счётчики состояний.
  //
  // Объявлены до эффекта опроса: признак «есть что опрашивать» выводится
  // из них, а не из отдельного прохода по списку (см. hasActive).
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

  // Признак «есть что опрашивать».
  //
  // Зависимость — только сам факт наличия незавершённых задач: список задач
  // читается через itemsRef, иначе цепочка таймеров перезапускалась бы
  // на каждом завершении задачи и сбрасывала накопленный интервал.
  //
  // Выводится из уже посчитанных счётчиков, а не отдельным проходом
  // по списку: `pending` набирается на `pending|submitting`, `active` —
  // на `queued|processing`, то есть ровно на тех четырёх состояниях,
  // при которых задача ещё не завершена. Второй проход по массиву
  // на каждом рендере был бы лишней работой, а `useMemo` вокруг него
  // правило `rerender-simple-expression-in-memo` считает дороже самого
  // выражения.
  const hasActive = stats.pending > 0 || stats.active > 0;

  // Такт часов.
  //
  // Строки таблицы показывают счётчик идущей задачи и следят за сроком ссылки
  // на готовый файл — и то и другое считается от текущего времени. Раньше
  // каждая строка звала Date.now() прямо в рендере: рендер переставал быть
  // чистым, а срок ссылки не обновлялся вовсе — завершённые задачи больше
  // не опрашиваются, и «ссылка истекла» могло не появиться до случайной
  // перерисовки списка.
  //
  // Таймер заводится только на ближайшее осмысленное событие: пока идёт
  // работа — на следующий такт, иначе — на момент истечения ближайшей ссылки.
  // Без этого страница перерисовывалась бы каждую секунду вхолостую.
  useEffect(() => {
    let nextAt: number | null = hasActive ? now + CLOCK_TICK_MS : null;

    for (const item of items) {
      const expiresAt = item.result ? Date.parse(item.result.expiresAt) : Number.NaN;

      // Истёкшие ссылки пропускаются: иначе таймер перезаводился бы на то же
      // прошлое мгновение и цикл стал бы горячим
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        continue;
      }

      nextAt = nextAt === null ? expiresAt : Math.min(nextAt, expiresAt);
    }

    if (nextAt === null) {
      return;
    }

    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(MIN_TICK_DELAY_MS, nextAt - now)
    );

    return () => clearTimeout(timer);
  }, [now, items, hasActive]);

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
    // изменении списка задач.
    //
    // От этого зависит не только плавность: перезапуск эффекта обнуляет
    // deadlines, а в них лежит срок ожидания задачи (POLL_DEADLINE_MS).
    // Инвариант, который делает перезапуск безопасным: опрашиваемые задачи
    // (isPollable — есть jobId и статус queued|processing) всегда входят
    // в число активных, поэтому момент, когда hasActive становится false, —
    // это момент, когда опрашивать уже некого, и терять сроки не на чем.
    // Обратный переход всегда связан с появлением новой задачи без jobId,
    // и её дедлайн отсчитывается заново — как и задумано.
    //
    // Если однажды понадобится добавить items в зависимости, инвариант
    // придётся пересматривать: молчаливое отодвигание дедлайна превратит
    // защиту от вечного ожидания в её отсутствие.
  }, [hasActive]);

  return {
    items,
    now,
    addFiles,
    removeItem,
    clearFinished,
    startAll,
    cancelAll,
    retryItem,
    downloadAll,
    stats,
  };
}
