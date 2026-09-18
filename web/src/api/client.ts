/**
 * Базовый HTTP-клиент.
 *
 * Отвечает за:
 * - единую точку обращения к API (базовый URL из VITE_API_BASE)
 * - разбор ошибок сервера в тип ApiError
 * - таймауты и отмену запросов
 * - сквозной X-Request-Id для логов сервиса
 */

import type { ApiErrorBody } from './types';

/**
 * Базовый адрес API.
 *
 * По умолчанию пустой — запросы уходят на тот же origin, что и страница:
 * в разработке их проксирует Vite, в production — nginx.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/** Таймаут обычного запроса (опрос статуса, health). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Таймаут отправки файла: тело может быть крупным, а сеть — медленной. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** Ошибка обращения к API. */
export class ApiError extends Error {
  constructor(
    /** HTTP-статус ответа. */
    readonly status: number,
    /** Код ошибки в snake_case из поля error. */
    readonly code: string,
    /** Сообщение сервера. */
    readonly serverMessage: string,
    /** Идентификатор задачи, если сервер его вернул. */
    readonly taskId?: string,
    /** Через сколько секунд повторять запрос (заголовок Retry-After). */
    readonly retryAfterSec?: number
  ) {
    super(serverMessage);
    this.name = 'ApiError';
  }
}

/** Опции запроса. */
export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
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
 * @param options - метод, тело, сигнал отмены и таймаут
 * @returns разобранное тело ответа
 * @throws {ApiError} - если сервер ответил ошибкой
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
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

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, 'timeout', 'Превышено время ожидания ответа сервера');
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }

    throw new ApiError(0, 'network_error', 'Не удалось связаться с сервером');
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
    const errorBody = parsed as ApiErrorBody | null;

    throw new ApiError(
      response.status,
      errorBody?.error ?? 'unknown_error',
      errorBody?.message ?? `Сервер ответил ошибкой ${response.status}`,
      errorBody?.taskId,
      parseRetryAfter(response)
    );
  }

  return parsed as T;
}

/**
 * Собирает URL скачивания результата.
 *
 * Сервер отдаёт файлы по /results/{taskId}.{ext}; адрес из ответа
 * используется как есть, чтобы не дублировать правила именования.
 *
 * @param fileUrl - значение fileUrl из ответа API
 * @param downloadName - желаемое имя файла для пользователя
 * @returns путь с параметром name
 */
export function buildDownloadUrl(fileUrl: string, downloadName?: string): string {
  const path = `${API_BASE}${fileUrl}`;

  if (!downloadName) {
    return path;
  }

  return `${path}?name=${encodeURIComponent(downloadName)}`;
}
