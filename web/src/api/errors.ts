/**
 * Перевод кодов ошибок API в понятные пользователю сообщения.
 *
 * Сервер отвечает кодами в snake_case (`packages/contract/src/errors.ts`),
 * показывать их напрямую нельзя, а поле message бывает техническим.
 * Карта типизирована по контракту: новый код ошибки в контракте ломает
 * сборку интерфейса, а не проходит молча.
 */

import { isErrorCode } from '@doc-converter/contract';
import type { ErrorCode } from '@doc-converter/contract';
import { ApiError, CLIENT_ERROR_CODES } from './client';

/** Сообщения по кодам ошибок API. */
const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  // --- Схема запроса ---------------------------------------------------------
  file_required: 'Не передан файл для конвертации',
  file_too_large: 'Файл превышает допустимый размер',
  invalid_request: 'Запрос сформирован неверно',
  unknown_field: 'Запрос содержит недопустимое поле',
  field_type_mismatch: 'Неверный тип одного из полей запроса',
  invalid_option_value: 'Параметры конвертации указаны неверно',
  invalid_watermark: 'Текст водяного знака слишком длинный',
  invalid_pdf_version: 'Такая версия PDF не поддерживается',
  invalid_quality: 'Качество сжатия должно быть целым числом от 1 до 100',
  invalid_resolution: 'Разрешение изображений должно быть целым числом от 50 до 1200 DPI',

  // --- Содержимое файла ------------------------------------------------------
  magic_mismatch: 'Содержимое файла не совпадает с его расширением',
  magic_buffer_empty: 'Файл пустой',
  magic_buffer_too_small: 'Файл слишком мал, чтобы определить формат',
  magic_unsupported_type: 'Этот формат не поддерживается',
  content_validation_failed: 'Файл не прошёл проверку содержимого',
  unsupported_format: 'Поддерживаются только книги Excel: XLSX и XLS',

  // --- Архивы (XLSX — это zip-контейнер) -------------------------------------
  archive_forbidden_name: 'Внутри книги найдены недопустимые имена файлов',
  archive_forbidden_extension: 'Внутри книги найдены файлы недопустимых типов',
  archive_ratio_exceeded: 'Файл похож на архив-бомбу и отклонён',
  archive_too_many_entries: 'Внутри книги слишком много файлов',
  archive_entry_too_large: 'Один из файлов внутри книги слишком большой',
  archive_total_too_large: 'Содержимое книги слишком большое',
  archive_too_deep: 'Слишком глубокая вложенность папок внутри книги',
  archive_duplicate_entry: 'Внутри книги найдены файлы с одинаковыми именами',
  archive_empty: 'Внутри книги нет данных',
  archive_corrupt: 'Файл повреждён или не является книгой Excel',

  // --- Ход выполнения задачи -------------------------------------------------
  job_not_found: 'Задача не найдена — возможно, истёк срок её хранения',
  job_processing_failed: 'Ошибка обработки задачи на сервере',
  conversion_failed: 'Не удалось сконвертировать документ',
  conversion_timeout: 'Превышено время конвертации документа',
  uno_unavailable:
    'Конвертер LibreOffice недоступен. Задача будет обработана после его запуска',
  storage_unavailable:
    'Хранилище временно недоступно — попробуйте ещё раз через несколько секунд',
  upload_failed: 'Не удалось сохранить файл на сервере',

  // --- Прочее -----------------------------------------------------------------
  not_found: 'Запрашиваемый ресурс не найден',
  rate_limited: 'Слишком много запросов. Попробуйте ещё раз через несколько секунд',
  internal: 'Внутренняя ошибка сервиса',
};

/**
 * Сообщения по кодам, которые ставит сам клиент.
 *
 * Отдельная карта, потому что эти коды не входят в контракт сервера:
 * они описывают сбой до или после HTTP-обмена.
 */
const UNKNOWN_ERROR_MESSAGE = 'Неизвестная ошибка';

const CLIENT_MESSAGES: Readonly<Record<string, string>> = {
  [CLIENT_ERROR_CODES.network]:
    'Не удалось связаться с сервером. Проверьте подключение',
  [CLIENT_ERROR_CODES.timeout]: 'Сервер не ответил вовремя',
  [CLIENT_ERROR_CODES.invalidResponse]:
    'Ответ сервера не соответствует ожидаемому формату',
  unknown_error: UNKNOWN_ERROR_MESSAGE,
};

/** Сообщение на случай, когда у ошибки нет ни кода, ни текста. */
const FALLBACK_MESSAGE = 'Не удалось выполнить операцию';

/**
 * Подбирает сообщение по коду ошибки.
 *
 * @param code - код ошибки из ответа сервера или от клиента
 * @returns текст для пользователя или undefined, если код неизвестен
 */
function messageForCode(code: string): string | undefined {
  if (isErrorCode(code)) {
    return ERROR_MESSAGES[code];
  }

  return CLIENT_MESSAGES[code];
}

/**
 * Подбирает сообщение для ошибки запроса.
 *
 * @param error - ошибка запроса
 * @returns текст для показа пользователю
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // Сообщение сервера используется только как крайний случай: оно бывает
    // техническим («Некорректные параметры: quality: Ожидалось целое число»)
    return messageForCode(error.code) ?? (error.serverMessage || UNKNOWN_ERROR_MESSAGE);
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Операция отменена';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return UNKNOWN_ERROR_MESSAGE;
}

/**
 * Подбирает сообщение для ошибки, которой сервер завершил задачу.
 *
 * @param jobError - код и текст из поля error ответа о состоянии
 * @returns текст для показа пользователю
 */
export function describeJobError(jobError: { code: string; message: string }): string {
  return messageForCode(jobError.code) ?? (jobError.message || FALLBACK_MESSAGE);
}
