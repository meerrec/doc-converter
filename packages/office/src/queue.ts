/**
 * Очередь офиса: последовательное исполнение задач браузерного пути.
 *
 * Офис один и держит не более одного открытого документа (линейная память
 * сборки — 1 ГБ), поэтому и конвертация, и предпросмотр идут через одну
 * очередь: параллельный запуск не ускорил бы ничего, а второй документ
 * в памяти не поместился бы. Модуль не знает ни про React, ни про DOM —
 * он получает сессию функцией `open` и файл функцией `readBytes`, поэтому
 * проверяется тестом без браузера.
 *
 * Что здесь важно и неочевидно:
 *
 * - **путь идентифицирует задачу** (см. `paths.ts`). Офис переиспользует
 *   открытый документ по пути, и это ровно то, что нужно: предпросмотр
 *   и конвертация одного файла не открывают его дважды. Но у двух разных
 *   файлов пути обязаны различаться — иначе второй получит документ первого;
 * - **начатую операцию прервать нельзя**. У моста нет операции отмены,
 *   поэтому `cancelPending` снимает только ожидающие задачи, а идущая
 *   доводится до конца или до таймаута (см. `session.ts`);
 * - **исходник удаляется, только когда он больше не открыт** в окне офиса:
 *   под открытым документом файл лучше не трогать.
 *
 * Все комментарии на русском языке.
 */

import type { ConversionOptions } from '@doc-converter/contract';
import { MIN_OUTPUT_BYTES } from './constants.js';
import { buildFilterData } from './filterData.js';
import { browserFormatOf, EXPORT_FILTERS, type BrowserFormat } from './filters.js';
import { nextSourcePath, OUTPUT_PATH } from './paths.js';
import { LocalError, type LocalSession } from './session.js';

/** Что происходит с задачей внутри очереди. */
export type OfficePhase = 'waiting' | 'loading-office' | 'converting' | 'previewing';

/** Чем закончилась задача. */
export type OfficeOutcome =
  | { readonly kind: 'converted'; readonly bytes: Uint8Array }
  | { readonly kind: 'previewed'; readonly sheets: number | null };

/** Общее у задач очереди. */
interface OfficeJobBase {
  /** Идентификатор строки в списке файлов: по нему находится результат. */
  readonly itemId: string;
  /** Имя файла: из него берётся формат, а не путь. */
  readonly fileName: string;
  /** Читает файл: в момент выполнения, а не в момент постановки. */
  readonly readBytes: () => Promise<Uint8Array>;
}

/** Задача конвертации. */
export interface OfficeConvertJob extends OfficeJobBase {
  readonly kind: 'convert';
  readonly options: ConversionOptions;
}

/** Задача предпросмотра. */
export interface OfficePreviewJob extends OfficeJobBase {
  readonly kind: 'preview';
}

/** Задача очереди. */
export type OfficeJob = OfficeConvertJob | OfficePreviewJob;

/** Куда очередь сообщает о ходе работы. */
export interface OfficeQueueEvents {
  /** Фаза задачи изменилась. */
  onPhase(itemId: string, phase: OfficePhase): void;
  /** Задача выполнена. */
  onDone(itemId: string, outcome: OfficeOutcome): void;
  /** Задача не выполнена; очередь продолжит работу. */
  onFailed(itemId: string, error: Error): void;
  /**
   * В окне офиса теперь другой документ.
   *
   * `null` означает, что показанного документа больше нет: офис открыл
   * на его месте другой. Без этого сообщения на canvas остался бы последний
   * нарисованный кадр уже выгруженного документа.
   */
  onDocumentChanged(itemId: string | null): void;
}

/** Очередь офиса. */
export interface OfficeQueue {
  /** Ставит задачу; повторная постановка того же `itemId` игнорируется. */
  enqueue(job: OfficeJob): void;
  /** Снимает ожидающие задачи (все или одну) и сообщает, сколько снято. */
  cancelPending(itemId?: string): number;
  /** Закрывает открытый документ, освобождая память. */
  closeDocument(): Promise<void>;
}

/** Что нужно очереди, чтобы работать. */
export interface OfficeQueueOptions {
  /** Отдаёт готовый офис: в бою — `ensureOffice`, в тестах — подмена. */
  readonly open: () => Promise<LocalSession>;
  /** Куда сообщать о ходе работы. */
  readonly events: OfficeQueueEvents;
}

/**
 * Создаёт очередь офиса.
 *
 * @param options - источник сессии и подписчики событий
 * @returns очередь
 */
export function createOfficeQueue(options: OfficeQueueOptions): OfficeQueue {
  const { open, events } = options;

  /** Ожидающие задачи, в порядке постановки. */
  const waiting: OfficeJob[] = [];

  /** Идентификатор выполняющейся задачи; `null` — очередь свободна. */
  let running: string | null = null;

  /** Сессия офиса: появляется при первой задаче. */
  let session: LocalSession | null = null;

  /** Путь исходника каждой задачи: один и тот же файл — один и тот же путь. */
  const paths = new Map<string, { readonly path: string; readonly format: BrowserFormat }>();

  /** Документ, открытый в окне офиса, и задача, по которой он открыт. */
  let openPath: string | null = null;

  /**
   * Запускает следующую задачу.
   *
   * Идемпотентна: повторный вызов при идущей задаче ничего не делает. Именно
   * поэтому её можно звать и из `enqueue`, и из завершения задачи.
   */
  function pump(): void {
    if (running !== null) {
      return;
    }

    const job = waiting.shift();

    if (job === undefined) {
      return;
    }

    running = job.itemId;

    void execute(job).finally(() => {
      running = null;
      pump();
    });
  }

  /**
   * Возвращает путь для задачи, заводя его при первом обращении.
   *
   * @param job - задача
   * @param format - формат документа
   * @returns путь в файловой системе сборки
   */
  function pathFor(job: OfficeJob, format: BrowserFormat): string {
    const known = paths.get(job.itemId);

    // Формат мог смениться: тот же файл заменили другим (перетащили заново
    // под тем же идентификатором) — тогда прежний путь больше не годится
    if (known !== undefined && known.format === format) {
      return known.path;
    }

    const path = nextSourcePath(format);

    paths.set(job.itemId, { path, format });

    return path;
  }

  /**
   * Помечает документ, открытый в окне, закрытым.
   *
   * Сам файл удаляется не здесь: офис закроет документ при следующей операции,
   * и до этого момента файл лучше не трогать.
   *
   * @returns путь осиротевшего файла или null
   */
  function forgetDocument(): string | null {
    const stale = openPath;

    if (stale !== null) {
      openPath = null;
      events.onDocumentChanged(null);
    }

    return stale;
  }

  /**
   * Удаляет файл задачи и её путь.
   *
   * @param path - путь файла
   */
  function dropSource(path: string): void {
    session?.removeFile(path);

    for (const [itemId, known] of paths) {
      if (known.path === path) {
        paths.delete(itemId);
      }
    }
  }

  /**
   * Выполняет задачу.
   *
   * Никогда не отклоняется: отказ уходит в `onFailed`, и очередь продолжает
   * работу — иначе одна плохая книга останавливала бы все следующие.
   *
   * @param job - задача
   */
  async function execute(job: OfficeJob): Promise<void> {
    const format = browserFormatOf(job.fileName);

    if (format === null) {
      events.onFailed(
        job.itemId,
        new LocalError('lowa_load_failed', `формат не поддержан: ${job.fileName}`)
      );

      return;
    }

    let stale: string | null = null;

    try {
      if (session === null) {
        // Офис ещё не загружен: качаются файлы сборки. Это самая долгая
        // часть первой задачи, и она видна пользователю отдельной фазой
        events.onPhase(job.itemId, 'loading-office');

        session = await open();
      }

      const path = pathFor(job, format);
      const bytes = await job.readBytes();

      // Документ откроется по этому пути; прежний офис закроет сам
      if (openPath !== path) {
        stale = forgetDocument();
      }

      session.writeFile(path, bytes);

      if (job.kind === 'preview') {
        events.onPhase(job.itemId, 'previewing');

        const preview = await session.preview(path);

        openPath = path;
        events.onDocumentChanged(job.itemId);
        events.onDone(job.itemId, { kind: 'previewed', sheets: preview.sheets });
      } else {
        events.onPhase(job.itemId, 'converting');
        await convert(job, path, format);

        const pdf = session.readFile(OUTPUT_PATH);

        session.removeFile(OUTPUT_PATH);

        if (pdf.byteLength < MIN_OUTPUT_BYTES) {
          throw new LocalError('lowa_export_failed', 'экспортёр вернул пустой файл');
        }

        // Документ остался открытым, если он же показан в предпросмотре;
        // во всех прочих случаях офис закрыл его после экспорта
        if (openPath !== path) {
          dropSource(path);
        }

        events.onDone(job.itemId, { kind: 'converted', bytes: pdf });
      }
    } catch (error) {
      events.onFailed(job.itemId, error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Прежний документ офис уже закрыл — теперь файл можно удалить
      if (stale !== null) {
        dropSource(stale);
      }
    }
  }

  /**
   * Выгружает документ в PDF.
   *
   * @param job - задача конвертации
   * @param path - путь исходника
   * @param format - формат документа
   */
  async function convert(job: OfficeConvertJob, path: string, format: BrowserFormat): Promise<void> {
    await session?.convert({
      source: path,
      target: OUTPUT_PATH,
      filterName: EXPORT_FILTERS[format],
      filterData: buildFilterData(job.options),
      // Подгонка под страницу — свойство страничного стиля Calc: у документа
      // Word его нет, и серверный путь правит их так же
      scaleToPages: job.options.fitToOnePage && format === 'xlsx',
    });
  }

  return {
    enqueue(job: OfficeJob): void {
      // Задача уже стоит или выполняется: второй клик по кнопке не должен
      // открывать тот же документ дважды
      if (running === job.itemId || waiting.some((queued) => queued.itemId === job.itemId)) {
        return;
      }

      waiting.push(job);
      events.onPhase(job.itemId, 'waiting');
      pump();
    },

    cancelPending(itemId?: string): number {
      let cancelled = 0;

      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        const job = waiting[index];

        if (job === undefined || (itemId !== undefined && job.itemId !== itemId)) {
          continue;
        }

        waiting.splice(index, 1);
        cancelled += 1;
      }

      return cancelled;
    },

    async closeDocument(): Promise<void> {
      const path = openPath;

      if (session !== null && path !== null) {
        await session.close();
      }

      openPath = null;

      if (path !== null) {
        dropSource(path);
        events.onDocumentChanged(null);
      }
    },
  };
}
