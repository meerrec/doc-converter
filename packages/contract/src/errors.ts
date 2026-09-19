/**
 * Коды ошибок API и форма тела ошибки.
 *
 * Код — строка в snake_case; HTTP-статус подбирает сервер. Клиент показывает
 * пользователю своё сообщение по коду (см. `web/src/api/errors.ts`), поэтому
 * коды — часть внешнего контракта: переименование ломает интерфейс.
 */

import { z } from 'zod';

/** Коды ошибок, которые сервис отдаёт клиенту. */
export const ERROR_CODES = [
  // --- Схема запроса ---------------------------------------------------------
  'unknown_field',
  'field_type_mismatch',
  'exactly_one_source_required',
  // Отсутствие обязательного поля: сервер формирует код как `${field}_required`
  'filetype_required',
  'outputtype_required',
  'input_format_not_allowed',
  'output_format_not_allowed',
  'key_invalid_chars',
  'title_too_long',
  'region_invalid',
  'codePage_not_allowed',
  'delimiter_not_allowed',
  'data_invalid_base64',
  'data_too_large',
  'file_too_large',
  'invalid_request',
  'invalid_option_value',

  // --- Содержимое файла ------------------------------------------------------
  'magic_mismatch',
  'magic_buffer_empty',
  'magic_buffer_too_small',
  'magic_unsupported_type',
  'magic_type_missing',
  'content_validation_failed',

  // --- Архивы ----------------------------------------------------------------
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

  // --- Источник по URL (SSRF) ------------------------------------------------
  'url_malformed',
  'url_no_host',
  'url_scheme_forbidden',
  'url_credentials_forbidden',
  'url_private_ip',
  'url_too_long',

  // --- Ход выполнения --------------------------------------------------------
  'conversion_failed',
  'job_processing_failed',
  'job_validation_failed',
  'sync_timeout',
  'sync_disabled',
  'key_conflict',
  'body_timeout',
  'client_disconnected',

  // --- Задачи и результаты ---------------------------------------------------
  'task_not_found',
  'status_check_failed',
  'batch_status_check_failed',
  'result_not_found',
  'result_read_failed',
  'invalid_result_name',
  'not_found',

  // --- Прочее -----------------------------------------------------------------
  'rate_limited',
  /**
   * Хранилище состояния временно недоступно (Valkey или каталог входных файлов).
   *
   * Отдаётся со статусом 503 и заголовком `Retry-After`: в отличие от
   * `internal`, это состояние клиент может пережить повтором.
   */
  'storage_unavailable',
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
 * Тело ответа об ошибке.
 *
 * `taskId` присутствует не всегда: его добавляют только ошибки, привязанные
 * к конкретной задаче конвертации. `requestId` сервер добавляет для сверки
 * с логами. Схема «свободная» — новые поля не должны ломать разбор у клиента.
 */
export const apiErrorBodySchema = z.looseObject({
  error: z.string(),
  message: z.string(),
  taskId: z.string().optional(),
  requestId: z.string().optional(),
});

/** Тело ответа об ошибке. */
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
