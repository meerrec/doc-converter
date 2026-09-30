/**
 * Договор между страницей и воркером движка.
 *
 * Сообщения — простые данные: через границу воркера не проходит ни класс
 * ошибки, ни функция. Поэтому отказ передаётся кодом и текстом, а вызывающий
 * собирает из них `EngineError` — так код отказа переживает границу и остаётся
 * тем же, что и при прямой работе движка.
 *
 * Байты и туда, и обратно идут переносом буфера: копия книги на 30 МиБ
 * съедала бы память вкладки дважды.
 *
 * Все комментарии на русском языке.
 */

import type { ConversionOptions } from '@doc-converter/contract';
import type { EngineErrorCode } from './errors.js';

/** Запрос страницы воркеру. */
export type WorkerRequest =
  | {
      /** Прогрев: поднять движок, ничего не конвертируя. */
      readonly kind: 'warmup';
      readonly id: number;
    }
  | {
      readonly kind: 'convert';
      readonly id: number;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly options: ConversionOptions;
    };

/**
 * Запрос без номера: номер присваивает клиент.
 *
 * `Omit` над объединением не распределяется — он собрал бы общие поля
 * вариантов и потерял остальные, поэтому распределение задано явно.
 */
export type WorkerRequestPayload = WorkerRequest extends infer Request
  ? Request extends WorkerRequest
    ? Omit<Request, 'id'>
    : never
  : never;

/** Ответ воркера странице. */
export type WorkerResponse =
  | { readonly kind: 'ready'; readonly id: number }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly bytes: Uint8Array;
      readonly pageCount: number;
      readonly sheets: number | null;
    }
  | {
      readonly kind: 'failed';
      readonly id: number;
      readonly code: EngineErrorCode;
      readonly message: string;
    };

/**
 * Воркер в том виде, в каком его видит клиент.
 *
 * Свой интерфейс, а не `Worker`: тесты подставляют двойника, а `lib.webworker`
 * в пакет не подключён — он конфликтует с DOM, который нужен остальному коду.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: never) => void): void;
  terminate(): void;
}

/** Область воркера: то, чем он отвечает странице. */
export interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: WorkerRequest }) => void): void;
}
