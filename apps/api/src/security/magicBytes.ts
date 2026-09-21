/**
 * Проверка сигнатур файлов (magic bytes).
 *
 * Первые байты файла указывают на контейнер: и книга Excel, и документ
 * Word — это zip. Проверка не даёт выдать zip за что-то другое: без неё
 * файл с расширением `.xlsx`, но содержимым другого типа попал бы
 * в LibreOffice, где разбор ошибок занял бы минуты вместо мгновенного отказа.
 *
 * Различить XLSX и DOCX сигнатура не может — у обоих `PK\x03\x04`. Этим
 * занимается `ooxml.ts`: он читает оглавление контейнера.
 *
 * Список форматов сужен до входных форматов сервиса: раньше здесь были все
 * форматы Р7-Офис, включая текстовые и PDF, затем к ним добавлялся OLE2
 * старого `.xls` — формат убран, см. `INPUT_FORMATS` в контракте.
 *
 * Все комментарии на русском языке.
 *
 * Источник сигнатур: https://en.wikipedia.org/wiki/List_of_file_signatures
 */

import { MAGIC_BYTES_CHECK_SIZE } from './limits.js';

/** Минимальная длина буфера для содержательной проверки. */
const MIN_CHECK_BYTES = 4;

/**
 * Сигнатуры zip-контейнера.
 *
 * 50 4B 03 04 — обычный архив, 50 4B 05 06 — пустой (встречается у книг
 * без содержимого).
 */
const ZIP_SIGNATURES: Buffer[] = [
  Buffer.from('PK\x03\x04', 'binary'),
  Buffer.from('PK\x05\x06', 'binary'),
];

/**
 * Сигнатуры входных форматов.
 *
 * `null` означало бы «формат без сигнатуры» (так описывались текстовые
 * форматы); для документов OOXML таких нет — у них есть заголовок.
 *
 * Запись на каждый формат нужна не для различения — его здесь нет, — а для
 * `checkMagicBytes`: объявленное расширение обязано иметь сигнатуру, иначе
 * проверка ответит `magic_unsupported_type`.
 */
const SIGNATURES: Record<string, Buffer[]> = {
  xlsx: ZIP_SIGNATURES,
  docx: ZIP_SIGNATURES,
};

/** Сигнатуры поддерживаемых форматов. */
export const MAGIC_SIGNATURES = SIGNATURES;

/** Ошибка проверки: код для HTTP-маппинга и текст сообщения. */
interface MagicCheckError {
  /** Код ошибки из контракта. */
  errorCode: string;
  /** Текст сообщения. */
  message: string;
}

/** Результат проверки сигнатуры. */
interface MagicCheckResult {
  /** Признак совпадения. */
  valid: boolean;
  /** Ошибка при несовпадении. */
  error?: MagicCheckError;
}

/**
 * Сравнивает начало буфера с сигнатурой.
 *
 * @param buffer - данные файла
 * @param signature - ожидаемая сигнатура
 * @returns true, если начало буфера совпадает с сигнатурой
 */
function matchesSignature(buffer: Buffer, signature: Buffer): boolean {
  if (buffer.length < MIN_CHECK_BYTES) {
    return false;
  }

  const compareLength = Math.min(signature.length, buffer.length);

  return buffer.compare(signature, 0, compareLength, 0, compareLength) === 0;
}

/**
 * Проверяет сигнатуру файла и возвращает подробный результат.
 *
 * @param buffer - данные файла
 * @param declaredType - объявленный формат
 * @returns результат проверки
 */
export function checkMagicBytes(buffer: Buffer, declaredType: string): MagicCheckResult {
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      error: { errorCode: 'magic_buffer_empty', message: 'Файл пуст' },
    };
  }

  if (buffer.length < MAGIC_BYTES_CHECK_SIZE) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_buffer_too_small',
        message: `Файл короче ${MAGIC_BYTES_CHECK_SIZE} байт — формат не определить`,
      },
    };
  }

  const signatures = SIGNATURES[declaredType];

  if (!signatures) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_unsupported_type',
        message: `Формат «${declaredType}» не поддерживается`,
      },
    };
  }

  const matched = signatures.some((signature) => matchesSignature(buffer, signature));

  if (!matched) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_mismatch',
        message: `Содержимое файла не соответствует формату «${declaredType}»`,
      },
    };
  }

  return { valid: true };
}

/**
 * Проверяет, что буфер соответствует объявленному формату.
 *
 * @param buffer - данные файла
 * @param declaredType - объявленный формат
 * @returns true, если сигнатура совпадает
 */
export function verifyMagicBytes(buffer: Buffer, declaredType: string): boolean {
  return checkMagicBytes(buffer, declaredType).valid;
}

/** Форматы, для которых объявлена сигнатура. */
export const SUPPORTED_FORMATS = Object.keys(SIGNATURES);

/**
 * Проверяет, поддерживается ли формат.
 *
 * @param fileType - имя формата
 * @returns true, если формат поддерживается
 */
export function isSupportedFormat(fileType: string): boolean {
  return Object.prototype.hasOwnProperty.call(SIGNATURES, fileType);
}

export default {
  MAGIC_SIGNATURES,
  SUPPORTED_FORMATS,
  checkMagicBytes,
  verifyMagicBytes,
  isSupportedFormat,
};
