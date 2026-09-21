/**
 * Коды ошибок API и форма тела ошибки.
 *
 * Код — строка в snake_case; HTTP-статус подбирает сервер. Клиент показывает
 * пользователю своё сообщение по коду (см. `web/src/api/errors.ts`), поэтому
 * коды — часть внешнего контракта: переименование ломает интерфейс.
 */

import type { ApiErrorBody } from './schemas.js';

/** Коды ошибок, которые сервис отдаёт клиенту. */
export const ERROR_CODES = [
  // --- Схема запроса ---------------------------------------------------------
  'file_required',
  'file_too_large',
  'invalid_request',
  'unknown_field',
  'field_type_mismatch',
  'invalid_option_value',
  'invalid_watermark',
  'invalid_pdf_version',
  'invalid_quality',
  'invalid_resolution',

  // --- Содержимое файла ------------------------------------------------------
  'magic_mismatch',
  'magic_buffer_empty',
  'magic_buffer_too_small',
  'magic_unsupported_type',
  'content_validation_failed',
  'unsupported_format',

  // --- Архивы (входные форматы — контейнеры OOXML, то есть zip) --------------
  'archive_forbidden_name',
  'archive_forbidden_extension',
  'archive_ratio_exceeded',
  'archive_too_many_entries',
  'archive_entry_too_large',
  'archive_total_too_large',
  'archive_too_deep',
  'archive_duplicate_entry',
  'archive_empty',
  'archive_corrupt',

  // --- Ход выполнения задачи -------------------------------------------------
  'job_not_found',
  'job_processing_failed',
  'conversion_failed',
  'conversion_timeout',
  /**
   * UNO-бридж недоступен: soffice не запущен или не отвечает на сокете.
   *
   * Отдаётся, когда воркер не смог подключиться к LibreOffice. Задача при
   * этом не «сломана» — она упадёт и будет повторена после перезапуска воркера.
   */
  'uno_unavailable',
  'storage_unavailable',
  'upload_failed',

  // --- Прочее -----------------------------------------------------------------
  /** Запрошен неизвестный маршрут. */
  'not_found',
  'rate_limited',
  'internal',
] as const;

/** Код ошибки API. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Множество кодов для проверок во время выполнения. */
const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * Проверяет, что строка — известный код ошибки.
 *
 * Нужно там, где код приходит извне типизированного кода: например, от
 * zipGuard, который сообщает о нарушении строкой. Вместо приведения типа
 * (`as ErrorCode`) значение проверяется, а неизвестное заменяется на общий
 * код — так в ответ клиенту не попадёт что-то, чего нет в контракте.
 *
 * @param value - проверяемое значение
 * @returns true, если это код из контракта
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && errorCodeSet.has(value);
}

/**
 * Проверяет, что значение — тело ответа об ошибке.
 *
 * Гард повторяет схему `apiErrorBodySchema` из `schemas.ts` для потребителей,
 * которым рантайм-zod не нужен: веб-интерфейс разбирает ответы сервера,
 * но не валидирует запросы, и тащить ради этого весь валидатор в браузер
 * незачем. Тип по-прежнему выводится из схемы, а за согласованностью гарда
 * и схемы следит `tests/contract-guards.test.js`.
 *
 * Лишние поля допускаются: схема объявлена как `looseObject`, и сервер вправе
 * добавить поле, не ломая уже собранный клиент.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является телом ответа об ошибке
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;

  return (
    typeof body['error'] === 'string' &&
    typeof body['message'] === 'string' &&
    (body['jobId'] === undefined || typeof body['jobId'] === 'string') &&
    (body['requestId'] === undefined || typeof body['requestId'] === 'string')
  );
}
