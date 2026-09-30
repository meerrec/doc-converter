/**
 * Очередь своего движка: последовательное исполнение задач браузерного пути.
 *
 * Устройство повторяет очередь сборки LibreOffice (`queue.ts`) намеренно:
 * правила у путей общие, и расходиться им незачем. Движок один на страницу,
 * а его wasm держит память вкладки, поэтому задачи идут по одной — и
 * конвертация, и предпросмотр через эту же очередь; начатую задачу прервать
 * нельзя (отменяются только ожидающие).
 *
 * Отличий два, и оба от того, что документ живёт не в окне офиса:
 *
 * - **Файл никуда не записывается.** Сборка открывает документ по пути
 *   в своей файловой системе, и путь там обязан быть уникальным; свой движок
 *   получает байты прямо в функцию. Поэтому ни путей, ни удаления исходников
 *   здесь нет;
 * - **Предпросмотр — это готовый PDF.** Окна офиса у движка нет, страницы
 *   он отдаёт примитивами, и показать их можно только тем же экспортёром,
 *   что собирает результат. Отсюда и `pdf` в исходе предпросмотра.
 *
 * Модуль не знает ни про React, ни про DOM: конвертер приходит функцией
 * (по умолчанию — ленивая загрузка движка), поэтому проверяется тестом
 * без браузера.
 *
 * Все комментарии на русском языке.
 */

import { MIN_OUTPUT_BYTES } from '../constants.js';
import { browserFormatOf } from '../filters.js';
import type { ConversionOptions } from '@doc-converter/contract';
import type { ConvertedDocument, ConvertInput } from './convert.js';
import { EngineError } from './errors.js';
import { loadEngine } from './load.js';

/** Что происходит с задачей внутри очереди. */
export type OfficePhase = 'waiting' | 'loading-office' | 'converting' | 'previewing';

/** Чем закончилась задача. */
export type OfficeOutcome =
  | { readonly kind: 'converted'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'previewed';
      readonly sheets: number | null;
      /**
       * Готовый PDF предпросмотра.
       *
       * У своего движка нет окна: он рисует не документ на canvas, а страницы,
       * и показать их можно только тем же экспортёром, что собирает результат.
       */
      readonly pdf?: Uint8Array;
    };

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
  /** Параметры показа: предпросмотр — тот же PDF, что пойдёт на скачивание. */
  readonly options: ConversionOptions;
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
   * Показанный документ изменился.
   *
   * `null` означает, что показанного документа больше нет: предпросмотр
   * закрыт или заменён другим.
   */
  onDocumentChanged(itemId: string | null): void;
}

/** Очередь браузерного пути. */
export interface OfficeQueue {
  /** Ставит задачу; повторная постановка того же `itemId` игнорируется. */
  enqueue(job: OfficeJob): void;
  /** Снимает ожидающие задачи (все или одну) и сообщает, сколько снято. */
  cancelPending(itemId?: string): number;
  /** Закрывает показанный документ, освобождая его. */
  closeDocument(): Promise<void>;
}

/** Чем очередь выполняет задачу: в бою — конвейер, в тестах — подмена. */
export type EngineConverter = (input: ConvertInput) => Promise<ConvertedDocument>;

/** Что нужно очереди, чтобы работать. */
export interface LocalQueueOptions {
  /**
   * Выполняет задачу. По умолчанию — конвейер движка, загружаемый лениво:
   * подмена нужна тестам, у которых нет ни wasm, ни шрифтов.
   */
  readonly convert?: EngineConverter;
  /** Куда сообщать о ходе работы. */
  readonly events: OfficeQueueEvents;
}

/**
 * Создаёт очередь своего движка.
 *
 * @param options - конвертер и подписчики событий
 * @returns очередь
 */
export function createLocalQueue(options: LocalQueueOptions): OfficeQueue {
  const { events } = options;

  /** Ожидающие задачи, в порядке постановки. */
  const waiting: OfficeJob[] = [];

  /** Идентификатор выполняющейся задачи; `null` — очередь свободна. */
  let running: string | null = null;

  /**
   * Загружен ли движок.
   *
   * Подменённый конвертер означает, что грузить нечего: тесты не должны
   * тянуть wasm, чтобы проверить порядок задач.
   */
  let engineReady = options.convert !== undefined;

  const convert: EngineConverter =
    options.convert ?? (async (input) => (await loadEngine()).convert(input));

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
   * Выполняет задачу.
   *
   * Никогда не отклоняется: отказ уходит в `onFailed`, и очередь продолжает
   * работу — иначе один плохой файл останавливал бы все следующие.
   *
   * @param job - задача
   */
  async function execute(job: OfficeJob): Promise<void> {
    try {
      const format = browserFormatOf(job.fileName);

      if (format === null) {
        throw new EngineError('engine_unsupported', `формат не поддержан: ${job.fileName}`);
      }

      if (!engineReady) {
        // Первая задача ждёт и модуль движка, и его wasm: это самая долгая
        // часть, и пользователю она видна отдельной фазой
        events.onPhase(job.itemId, 'loading-office');

        try {
          // `warmup` поднимает воркер и инициализирует в нём wasm: без него
          // эта работа попала бы в фазу конвертации и выглядела бы зависанием
          await (await loadEngine()).warmup();
        } catch (error) {
          // Отказ загрузки терминален и должен отличаться от отказа самого
          // документа: по коду `engine_load_failed` страница блокирует
          // браузерные действия до перезагрузки
          throw new EngineError(
            'engine_load_failed',
            error instanceof Error ? error.message : String(error)
          );
        }

        engineReady = true;
      }

      events.onPhase(job.itemId, job.kind === 'preview' ? 'previewing' : 'converting');

      const result = await convert({
        bytes: await job.readBytes(),
        fileName: job.fileName,
        options: job.options,
      });

      if (job.kind === 'preview') {
        events.onDocumentChanged(job.itemId);
        events.onDone(job.itemId, {
          kind: 'previewed',
          sheets: result.sheets,
          pdf: result.bytes,
        });

        return;
      }

      if (result.bytes.byteLength < MIN_OUTPUT_BYTES) {
        throw new EngineError('engine_convert_failed', 'экспортёр вернул пустой файл');
      }

      events.onDone(job.itemId, { kind: 'converted', bytes: result.bytes });
    } catch (error) {
      events.onFailed(job.itemId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    enqueue(job: OfficeJob): void {
      // Задача уже стоит или выполняется: второй клик по кнопке не должен
      // запускать ту же работу дважды
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
      // Закрывать нечего: документ живёт только внутри задачи, а показанный
      // предпросмотр — это PDF в памяти страницы, и освобождает его она сама
      events.onDocumentChanged(null);
    },
  };
}
