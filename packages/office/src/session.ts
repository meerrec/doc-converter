/**
 * Сессия браузерного офиса: то, чем пользуется страница.
 *
 * Страница не знает ни про UNO, ни про порты — она получает сессию после
 * загрузки сборки и вызывает методы. Всё остальное (порт, идентификаторы
 * запросов, таймауты, файловая система) скрыто здесь.
 *
 * Содержимое документа передаётся **через файловую систему сборки**, а не
 * сообщениями: `postMessage` копирует данные, и копия книги на 30 МБ стоила бы
 * столько же памяти, сколько сама книга. По протоколу идут только пути
 * и параметры.
 *
 * Все комментарии на русском языке.
 */

import { BOOT_TIMEOUT_MS, OPERATION_TIMEOUT_MS } from './constants.js';
import { isBridgeResponse } from './protocol.js';
import { withTimeout } from './timeout.js';
import type {
  BridgeCall,
  BridgeResult,
  ConvertRequest,
  LocalErrorCode,
  MemoryResult,
  PreviewResult,
} from './protocol.js';
import type { EmscriptenFs } from './types.js';

/** Отказ браузерного пути с кодом причины. */
export class LocalError extends Error {
  /** Код отказа. */
  readonly code: LocalErrorCode;

  /**
   * @param code - код отказа
   * @param message - описание для журнала
   */
  constructor(code: LocalErrorCode, message: string) {
    super(message);
    this.name = 'LocalError';
    this.code = code;
  }
}

/** Ожидающий ответа запрос. */
interface PendingRequest {
  readonly resolve: (result: BridgeResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Готовый к работе браузерный офис. */
export class LocalSession {
  private readonly port: MessagePort;
  private readonly fs: EmscriptenFs;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;

  private nextId = 1;
  private disposed = false;

  /**
   * @param port - порт обмена со сборкой (со стороны главного потока)
   * @param fs - виртуальная файловая система сборки
   */
  constructor(port: MessagePort, fs: EmscriptenFs) {
    this.port = port;
    this.fs = fs;

    let confirmReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      confirmReady = resolve;
    });

    this.ready = withTimeout(
      ready,
      BOOT_TIMEOUT_MS,
      'офис не сообщил о готовности: сборка не инициализировалась'
    );

    // Порт получает обработчик до первого запроса: ответ на `ready` может
    // прийти раньше, чем страница вызовет первый метод
    port.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;

      if (!isBridgeResponse(message)) {
        return;
      }

      if (message.kind === 'ready') {
        confirmReady();

        return;
      }

      const pending = this.pending.get(message.id);

      if (pending === undefined) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.kind === 'failed') {
        pending.reject(new LocalError(message.code, message.message));
      } else {
        pending.resolve(message.result);
      }
    };

    port.start();
  }

  // =========================================================================
  // Файловая система
  // =========================================================================

  /**
   * Кладёт файл в файловую систему сборки.
   *
   * @param path - путь, по которому файл будет виден офису
   * @param bytes - содержимое
   */
  writeFile(path: string, bytes: Uint8Array): void {
    this.fs.writeFile(path, bytes);
  }

  /**
   * Читает файл из файловой системы сборки.
   *
   * @param path - путь файла
   * @returns содержимое
   */
  readFile(path: string): Uint8Array {
    return this.fs.readFile(path);
  }

  /**
   * Удаляет файл.
   *
   * Ошибка удаления не поднимается: файла может не быть (экспорт не дошёл
   * до записи), а это не то, о чём стоит сообщать пользователю.
   *
   * @param path - путь файла
   */
  removeFile(path: string): void {
    try {
      this.fs.unlink(path);
    } catch {
      // См. выше
    }
  }

  // =========================================================================
  // Операции
  // =========================================================================

  /**
   * Конвертирует документ в PDF.
   *
   * Готовый файл остаётся в файловой системе сборки по пути `request.target`;
   * читает его страница (`readFile`), там же проверяется и размер.
   *
   * @param request - пути и параметры экспорта
   */
  async convert(request: Omit<ConvertRequest, 'id' | 'kind'>): Promise<void> {
    await this.request({ kind: 'convert', ...request });
  }

  /**
   * Открывает документ в окне предпросмотра.
   *
   * @param source - путь документа
   * @returns сведения о документе
   */
  async preview(source: string): Promise<PreviewResult> {
    return (await this.request({ kind: 'preview', source })) as PreviewResult;
  }

  /** Закрывает открытый документ. */
  async close(): Promise<void> {
    await this.request({ kind: 'close' });
  }

  /** Возвращает размер линейной памяти сборки. */
  async memory(): Promise<MemoryResult> {
    return (await this.request({ kind: 'memory' })) as MemoryResult;
  }

  /**
   * Закрывает сессию.
   *
   * Незавершённые запросы отклоняются, а не остаются висеть: ждать ответа
   * от закрытого порта нечего.
   */
  dispose(): void {
    this.disposed = true;
    this.port.onmessage = null;
    this.port.close();

    const error = new LocalError('lowa_unavailable', 'сессия закрыта');

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  /**
   * Отправляет запрос и ждёт ответа.
   *
   * @param request - запрос с уже присвоенным идентификатором
   * @returns результат
   */
  private async request(request: BridgeCall): Promise<BridgeResult> {
    await this.ready;

    if (this.disposed) {
      throw new LocalError('lowa_unavailable', 'сессия закрыта');
    }

    const id = this.nextId;

    this.nextId += 1;

    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LocalError('lowa_timeout', `операция не завершилась за ${OPERATION_TIMEOUT_MS} мс`));
      }, OPERATION_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ ...request, id });
    });
  }
}
