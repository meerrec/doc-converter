/**
 * Перевод кодов ошибок API в понятные пользователю сообщения.
 *
 * Сервер отвечает кодами в snake_case (см. docs/api.md); показывать их
 * пользователю напрямую нельзя, а сообщение сервера бывает техническим.
 */

import { ApiError } from './client';

/** Сообщения по кодам ошибок API. */
const ERROR_MESSAGES: Record<string, string> = {
  // Схема запроса
  unknown_field: 'Запрос содержит недопустимое поле',
  field_type_mismatch: 'Неверный тип одного из полей запроса',
  exactly_one_source_required: 'Нужно указать ровно один источник файла',
  input_format_not_allowed: 'Такой входной формат не поддерживается',
  output_format_not_allowed: 'Такой формат результата не поддерживается',
  key_invalid_chars: 'Недопустимые символы в идентификаторе задачи',
  title_too_long: 'Слишком длинное название документа',
  region_invalid: 'Неверный код региона. Ожидается вид «ru-RU»',
  codePage_not_allowed: 'Такая кодировка не поддерживается',
  delimiter_not_allowed: 'Такой разделитель не поддерживается',
  data_invalid_base64: 'Не удалось прочитать содержимое файла',
  data_too_large: 'Файл слишком большой для отправки',
  file_too_large: 'Файл слишком большой',

  // Содержимое файла
  magic_mismatch: 'Содержимое файла не совпадает с его расширением',
  magic_buffer_empty: 'Файл пустой',
  magic_buffer_too_small: 'Файл слишком мал, чтобы определить формат',
  magic_unsupported_type: 'Этот формат не поддерживается',
  magic_type_missing: 'Не указан формат файла',

  // Архивы
  archive_forbidden_name: 'Внутри архива найдены недопустимые имена файлов',
  archive_forbidden_extension: 'Внутри архива найдены файлы недопустимых типов',
  archive_ratio_exceeded: 'Файл похож на архив-бомбу и отклонён',
  archive_too_many_entries: 'В архиве слишком много файлов',
  archive_entry_too_large: 'Один из файлов внутри архива слишком большой',
  archive_total_too_large: 'Содержимое архива слишком большое',
  archive_too_deep: 'Слишком глубокая вложенность папок в архиве',
  archive_duplicate_entry: 'В архиве найдены файлы с одинаковыми именами',
  archive_empty: 'Архив пуст',
  archive_corrupt: 'Архив повреждён',
  content_validation_failed: 'Файл не прошёл проверку',

  // Ход выполнения
  incompatible_formats: 'Такое преобразование форматов не поддерживается',
  file_empty: 'Файл пустой',
  output_too_small: 'Не удалось получить корректный результат конвертации',
  conversion_failed: 'Не удалось сконвертировать документ',
  conversion_validation_failed: 'Документ не прошёл проверку перед конвертацией',
  job_processing_failed: 'Ошибка обработки задачи на сервере',
  sync_timeout: 'Превышено время обработки запроса',
  sync_disabled: 'Синхронный режим на сервере выключен',

  // Задачи и результаты
  task_not_found: 'Задача не найдена — возможно, истёк срок её хранения',
  result_not_found: 'Результат не найден — возможно, истёк срок его хранения',
  invalid_result_name: 'Недопустимое имя файла результата',
  result_read_failed: 'Не удалось прочитать файл результата',
  rate_limited: 'Слишком много запросов. Попробуйте ещё раз через несколько секунд',
  not_found: 'Запрашиваемый ресурс не найден',

  // Сеть
  network_error: 'Не удалось связаться с сервером. Проверьте подключение',
  timeout: 'Сервер не ответил вовремя',
  unknown_error: 'Неизвестная ошибка',
};

/**
 * Подбирает понятное сообщение для ошибки.
 *
 * @param error - ошибка запроса
 * @returns текст для показа пользователю
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return ERROR_MESSAGES[error.code] ?? error.serverMessage ?? ERROR_MESSAGES['unknown_error']!;
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Операция отменена';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return ERROR_MESSAGES['unknown_error']!;
}

/**
 * Определяет, нужно ли показать пользователю повторную попытку.
 *
 * @param error - ошибка запроса
 * @returns true, если ошибка временная
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 0 || error.status === 429 || error.status >= 500;
  }

  return false;
}
