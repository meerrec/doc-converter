/**
 * Клиент движка: чем страница разговаривает с воркером.
 *
 * В браузере вся работа — разбор, вёрстка, сборка PDF — идёт в воркере,
 * и главный поток остаётся свободным. В Node (тесты, сборка без браузера)
 * воркера нет, и тот же клиент вызывает конвейер напрямую: поведение
 * и результат обязаны совпадать, иначе тесты проверяли бы не то, что
 * исполняется на странице.
 *
 * Воркер создаётся один на страницу и живёт до перезагрузки — по той же
 * причине, по которой мемоизирована загрузка движка: второй экземпляр
 * поднял бы вторую копию wasm и удвоил память вкладки.
 *
 * Все комментарии на русском языке.
 */

import type { ConvertedDocument, ConvertInput } from './convert.js';
import { EngineError } from './errors.js';
import type { PreviewSession } from './preview.js';
import type {
  WorkerLike,
  WorkerRequest,
  WorkerRequestPayload,
  WorkerResponse,
} from './worker-protocol.js';

/** Чем страница пользуется: прогрев, конвертация и предпросмотр. */
export interface OfficeClient {
  /**
   * Поднимает движок, ничего не конвертируя.
   *
   * @returns готовность движка
   */
  warmup(): Promise<void>;
  /**
   * Конвертирует файл в PDF.
   *
   * @param input - байты файла, его имя и параметры
   * @returns PDF, число страниц и число листов (для книги)
   */
  convert(input: ConvertInput): Promise<ConvertedDocument>;
  /**
   * Открывает документ для предпросмотра.
   *
   * @param input - байты файла, его имя и параметры
   * @returns сессию предпросмотра
   */
  openPreview(input: ConvertInput): Promise<PreviewSession>;
}

/**
 * Открытая сессия на стороне клиента.
 *
 * Кроме полей сессии здесь живёт то, что нужно только транспорту: номер
 * сессии в воркере, признак закрытия и метки запросов страниц.
 */
interface ClientSession {
  readonly id: number;
  readonly preview: PreviewSession;
  closed: boolean;
}

/**
 * Сколько запросов страницы успело уйти по каждому номеру.
 *
 * Метка нужна, когда один и тот же масштаб спрашивают дважды: ответ на
 * устаревший запрос приходит позже свежего, и нарисовать по нему страницу
 * значит показать картинку не того масштаба.
 */
type PageTokens = Map<number, number>;

/** Что можно подменить в клиенте: воркер нужен тестам. */
export interface OfficeClientOptions {
  readonly spawn?: () => WorkerLike;
}

/** Ожидающий ответа запрос. */
interface Pending {
  readonly resolve: (response: WorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Создаёт клиент движка.
 *
 * @param options - источник воркера; по умолчанию — настоящий `Worker`
 * @returns клиент
 */
export function createOfficeClient(options: OfficeClientOptions = {}): OfficeClient {
  const spawn = options.spawn;
  const pending = new Map<number, Pending>();
  let worker: WorkerLike | null = null;
  /** Отказ загрузки терминален: повторять загрузку мегабайт незачем. */
  let broken = false;
  let nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /**
   * Отдаёт воркер, создавая его при первом обращении.
   *
   * @returns воркер
   */
  const engine = (): WorkerLike => {
    if (worker !== null) {
      return worker;
    }

    const created =
      spawn === undefined
        ? (new Worker(new URL('./worker.js', import.meta.url), {
            type: 'module',
            name: 'doc-converter-engine',
          }) as unknown as WorkerLike)
        : spawn();

    created.addEventListener('message', (event: never) => {
      const response = (event as unknown as { readonly data: WorkerResponse }).data;

      // Виды ответов перечислены, а не проверены на «есть номер»: ответ без
      // номера (или ставший таким после правки протокола) не должен будить
      // чужой запрос — `pending.get(undefined)` вернул бы не того ожидающего
      const known =
        response.kind === 'ready' ||
        response.kind === 'done' ||
        response.kind === 'failed' ||
        response.kind === 'opened' ||
        response.kind === 'page' ||
        response.kind === 'closed';

      if (known) {
        const waiting = pending.get(response.id);

        pending.delete(response.id);
        waiting?.resolve(response);
      }
    });

    // Падение воркера не отвечает ничем: без этого все ожидающие запросы
    // зависли бы навсегда, а страница — на фазе загрузки
    const fail = (): void => {
      broken = true;

      for (const waiting of pending.values()) {
        waiting.reject(new EngineError('engine_load_failed', 'воркер движка остановился'));
      }

      pending.clear();
    };

    created.addEventListener('error', fail);
    created.addEventListener('messageerror', fail);

    worker = created;

    return created;
  };

  /**
   * Отправляет запрос и ждёт ответа.
   *
   * @param message - запрос без номера
   * @param transfer - буферы, передаваемые без копии
   * @returns ответ воркера
   */
  const send = (
    message: WorkerRequestPayload,
    transfer: Transferable[] = []
  ): Promise<WorkerResponse> => {
    if (broken) {
      return Promise.reject(new EngineError('engine_load_failed', 'движок не загрузился'));
    }

    nextId += 1;

    const id = nextId;

    return new Promise<WorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });

      try {
        engine().postMessage({ ...message, id } as WorkerRequest, transfer);
      } catch (error) {
        pending.delete(id);
        broken = true;
        reject(new EngineError('engine_load_failed', error instanceof Error ? error.message : String(error)));
      }
    });
  };

  /**
   * Выполняет задачи по одной.
   *
   * Очередь страницы и так последовательна, но клиент не должен на это
   * полагаться: два запроса в один воркер дали бы две книги в памяти сразу.
   *
   * @param task - что выполнить
   * @returns результат задачи
   */
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);

    tail = run.catch(() => undefined);

    return run;
  };

  /** Открытая сессия предпросмотра: движок один, и сессия одна. */
  let active: ClientSession | null = null;

  /** Метки запросов страниц по номерам сессий. */
  const tokens = new Map<number, PageTokens>();

  /**
   * Закрывает сессию.
   *
   * Признак закрытия ставится сразу, а сообщение воркеру уходит в очередь:
   * панель должна освободиться мгновенно, даже если воркер занят растеризацией
   * страницы, которую уже некому показать.
   *
   * @param session - закрываемая сессия
   */
  const closeSession = (session: ClientSession): void => {
    if (session.closed) {
      return;
    }

    session.closed = true;
    tokens.delete(session.id);

    if (active === session) {
      active = null;
    }

    // Сообщение уходит **мимо очереди**: `close` зовут из обработчика события,
    // а очередь задач не должна ждать закрытия — иначе открытие следующего
    // документа встало бы за ним, и порядок сообщений стал бы обратным.
    //
    // Обгонять запрос страницы закрытию не страшно: воркер разбирает
    // сообщения по порядку, а закрытая сессия сама отвергает рисование
    void send({ kind: 'preview-close', session: session.id }).catch(() => undefined);
  };

  /**
   * Рисует страницу открытой сессии.
   *
   * @param session - сессия
   * @param pageIndex - номер страницы
   * @param scale - масштаб растра
   * @returns растр или `null`, если он больше не нужен
   */
  const renderPage = async (
    session: ClientSession,
    pageIndex: number,
    scale: number
  ): Promise<ImageBitmap | null> => {
    if (session.closed) {
      return null;
    }

    const pageTokens = tokens.get(session.id) ?? new Map<number, number>();
    const token = (pageTokens.get(pageIndex) ?? 0) + 1;

    pageTokens.set(pageIndex, token);
    tokens.set(session.id, pageTokens);

    try {
      return await serialized(async () => {
        // Пока запрос стоял в очереди, сессию могли закрыть
        if (session.closed) {
          return null;
        }

        const response = await send({
          kind: 'preview-page',
          session: session.id,
          pageIndex,
          scale,
        });

        if (response.kind === 'failed') {
          // Сессия закрыта или заменена, пока запрос шёл: страницу уже некому
          // показывать, и отказ здесь — не отказ
          if (response.code === 'engine_preview_stale') {
            return null;
          }

          broken = response.code === 'engine_load_failed';

          throw new EngineError(response.code, response.message);
        }

        if (response.kind !== 'page') {
          throw new EngineError('engine_convert_failed', 'воркер ответил не на запрос страницы');
        }

        // Ответ на устаревший запрос: метка сменилась, пока он шёл, — значит,
        // спрашивали другой масштаб. Растр освобождается здесь же: получил его
        // клиент, ему и закрывать
        if (session.closed || pageTokens.get(pageIndex) !== token) {
          response.bitmap.close();

          return null;
        }

        return response.bitmap;
      });
    } catch (error) {
      // Закрытая сессия гасит и отказ транспорта: спрашивать было нечего
      if (session.closed) {
        return null;
      }

      throw error;
    }
  };

  /**
   * Открывает сессию предпросмотра в воркере.
   *
   * @param input - байты файла, имя и параметры
   * @returns сессия
   */
  const openPreviewInWorker = (input: ConvertInput): Promise<PreviewSession> =>
    serialized(async () => {
      // Движок один: открытие нового документа закрывает прежний
      if (active !== null) {
        closeSession(active);
      }

      // Буфер передаётся без копии — по той же причине, что и в конвертации
      const whole =
        input.bytes.byteOffset === 0 && input.bytes.byteLength === input.bytes.buffer.byteLength;
      const bytes = whole ? input.bytes : input.bytes.slice();
      const response = await send(
        { kind: 'preview-open', bytes, fileName: input.fileName, options: input.options },
        [bytes.buffer as ArrayBuffer]
      );

      if (response.kind === 'failed') {
        broken = response.code === 'engine_load_failed';

        throw new EngineError(response.code, response.message);
      }

      if (response.kind !== 'opened') {
        throw new EngineError('engine_convert_failed', 'воркер ответил не на запрос предпросмотра');
      }

      const session: ClientSession = {
        id: response.session,
        closed: false,
        preview: {
          pageCount: response.pages.length,
          sheets: response.sheets,
          pages: response.pages,
          skipped: response.skipped,
          render: (pageIndex: number, scale: number) => renderPage(session, pageIndex, scale),
          close: () => closeSession(session),
        },
      };

      active = session;

      return session.preview;
    });

  return {
    warmup(): Promise<void> {
      // В Node воркера нет: «прогрев» — это загрузка модуля конвейера
      if (spawn === undefined && typeof Worker === 'undefined') {
        return import('./convert.js').then(() => undefined);
      }

      return serialized(async () => {
        const response = await send({ kind: 'warmup' });

        if (response.kind === 'failed') {
          broken = response.code === 'engine_load_failed';

          throw new EngineError(response.code, response.message);
        }
      });
    },

    convert(input: ConvertInput): Promise<ConvertedDocument> {
      if (spawn === undefined && typeof Worker === 'undefined') {
        return import('./convert.js').then((module) => module.convertDocument(input));
      }

      return serialized(async () => {
        // Буфер передаётся без копии: книга на 30 МиБ в двух экземплярах
        // съела бы память вкладки дважды. Копия нужна только если массив —
        // это окно в чужой буфер: отчуждать его целиком нельзя
        const whole = input.bytes.byteOffset === 0 && input.bytes.byteLength === input.bytes.buffer.byteLength;
        const bytes = whole ? input.bytes : input.bytes.slice();
        const response = await send(
          { kind: 'convert', bytes, fileName: input.fileName, options: input.options },
          [bytes.buffer as ArrayBuffer]
        );

        if (response.kind === 'failed') {
          // Отказ загрузки терминален и здесь: если движок не поднялся,
          // следующая задача упрётся в то же самое
          broken = response.code === 'engine_load_failed';

          throw new EngineError(response.code, response.message);
        }

        if (response.kind !== 'done') {
          throw new EngineError('engine_convert_failed', 'воркер ответил не на запрос конвертации');
        }

        return {
          bytes: response.bytes,
          pageCount: response.pageCount,
          sheets: response.sheets,
          skipped: response.skipped,
        };
      });
    },

    openPreview(input: ConvertInput): Promise<PreviewSession> {
      // В Node воркера нет: сессию открывает сам конвейер, и она настоящая
      if (spawn === undefined && typeof Worker === 'undefined') {
        return import('./preview.js').then((module) => module.openPreview(input));
      }

      return openPreviewInWorker(input);
    },
  };
}

/** Клиент страницы: один на вкладку. */
let shared: OfficeClient | null = null;

/**
 * Отдаёт клиент страницы, создавая его при первом обращении.
 *
 * @returns клиент
 */
export function getOfficeClient(): OfficeClient {
  shared ??= createOfficeClient();

  return shared;
}
