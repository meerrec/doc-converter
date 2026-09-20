/**
 * Базовый HTTP-клиент.
 *
 * Отвечает за:
 * - единую точку обращения к API (базовый URL из VITE_API_BASE)
 * - разбор ответа схемой контракта, переданной вызывающей стороной
 * - разбор ошибок сервера в тип ApiError
 * - таймауты и отмену запросов
 * - сквозной X-Request-Id для логов сервиса
 */

import { apiErrorBodySchema } from '@doc-converter/contract';

/**
 * Базовый адрес API.
 *
 * По умолчанию пустой — запросы уходят на тот же origin, что и страница:
 * в разработке их проксирует Vite, в production — nginx.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/** Таймаут обычного запроса (опрос статуса, проверка доступности). */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Таймаут отправки файла: тело может быть крупным, а сеть — медленной.
 *
 * Обоснование: постановка задачи включает проверку zip-контейнера и оценку
 * сложности книги, то есть сервер отвечает не мгновенно даже на быстрой сети.
 * Две минуты — тот же порядок, что и у `CONVERSION_TIMEOUT_MS` на сервере.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Коды ошибок, которые ставит сам клиент.
 *
 * Их нет в контракте сервера: это сбои до или после HTTP-обмена (сеть,
 * таймаут, неожиданная форма ответа). Лежат рядом с ApiError, чтобы
 * `errors.ts` переводил их так же, как серверные.
 */
export const CLIENT_ERROR_CODES = {
  network: 'network_error',
  timeout: 'timeout',
  invalidResponse: 'invalid_response',
} as const;

/** Ошибка обращения к API. */
export class ApiError extends Error {
  constructor(
    /** HTTP-статус ответа; 0 — ответа не было. */
    readonly status: number,
    /** Код ошибки в snake_case из поля error. */
    readonly code: string,
    /** Сообщение сервера. */
    readonly serverMessage: string,
    /** Идентификатор задачи, если сервер его вернул. */
    readonly jobId?: string,
    /** Идентификатор запроса для сверки с логами сервиса. */
    readonly requestId?: string,
    /** Через сколько секунд повторять запрос (заголовок Retry-After). */
    readonly retryAfterSec?: number
  ) {
    super(serverMessage);
    this.name = 'ApiError';
  }
}

/** Опции запроса. */
export interface RequestOptions<T> {
  method?: 'GET' | 'POST';
  /**
   * Тело запроса: `FormData` уходит как есть (multipart), объект —
   * сериализуется в JSON.
   */
  body?: FormData | Record<string, unknown>;
  /**
   * Разбор успешного ответа схемой контракта.
   *
   * Схема передаётся вызывающей стороной, а не импортируется здесь: у каждого
   * маршрута она своя, а клиент остаётся общим. Исключение из `parse`
   * превращается в ApiError с кодом `invalid_response` — иначе расхождение
   * контракта и сервера проявилось бы как «поле undefined» где-то в разметке.
   */
  parse: (value: unknown) => T;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Читает Retry-After из заголовков ответа.
 *
 * @param response - ответ сервера
 * @returns число секунд или undefined
 */
function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');

  if (!header) {
    return undefined;
  }

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Выполняет запрос к API и разбирает ответ.
 *
 * @param path - путь относительно базового адреса API
 * @param options - метод, тело, схема разбора, сигнал отмены и таймаут
 * @returns разобранное тело ответа
 * @throws {ApiError} - если сервер ответил ошибкой или ответ не разобрался
 */
export async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const {
    method = 'GET',
    body,
    parse,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // Таймаут и внешний сигнал объединяем: запрос прервётся по любому из них
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = {
    // Сервис переиспользует входящий идентификатор — логи становятся сквозными
    'X-Request-Id': crypto.randomUUID(),
  };

  const isFormData = body instanceof FormData;

  // Content-Type для multipart не задаём: браузер сам добавит его вместе
  // с границей частей, а ручное значение границу потеряет
  if (body !== undefined && !isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(
        0,
        CLIENT_ERROR_CODES.timeout,
        'Превышено время ожидания ответа сервера'
      );
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }

    throw new ApiError(
      0,
      CLIENT_ERROR_CODES.network,
      'Не удалось связаться с сервером'
    );
  }

  // Тело может быть не JSON (например, 502 от прокси) — читаем как текст
  const text = await response.text();
  let parsed: unknown = null;

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errorBody = apiErrorBodySchema.safeParse(parsed);

    throw new ApiError(
      response.status,
      errorBody.success ? errorBody.data.error : 'unknown_error',
      errorBody.success
        ? errorBody.data.message
        : `Сервер ответил ошибкой ${response.status}`,
      errorBody.success ? errorBody.data.jobId : undefined,
      errorBody.success ? errorBody.data.requestId : undefined,
      parseRetryAfter(response)
    );
  }

  try {
    return parse(parsed);
  } catch (err) {
    // Подробности разбора (путь до поля, ожидаемый тип) полезны в консоли,
    // а пользователю показывается общее сообщение из errors.ts
    console.error('Ответ сервера не соответствует контракту', err);

    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.invalidResponse,
      'Ответ сервера не соответствует ожидаемому формату'
    );
  }
}

/**
 * Запускает скачивание готового PDF по presigned-ссылке.
 *
 * Ссылка ведёт в объектное хранилище, а не в API, поэтому `download`
 * работает только когда хранилище доступно с того же origin; в остальных
 * случаях браузер откроет PDF в новой вкладке (атрибут `download`
 * для чужого origin игнорируется). Альтернатива — качать файл через fetch
 * и отдавать blob-ссылкой — требует CORS от хранилища и лишает пользователя
 * возможности отменить загрузку.
 *
 * @param url - presigned-ссылка из ответа статуса
 * @param fileName - имя файла для сохранения
 */
export function downloadFromUrl(url: string, fileName: string): void {
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.target = '_blank';

  document.body.append(link);
  link.click();
  link.remove();
}
