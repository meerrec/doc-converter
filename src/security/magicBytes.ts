/**
 * Проверка сигнатур файлов (magic bytes).
 *
 * Первые байты файла однозначно указывают на контейнер: XLSX — это zip,
 * `.xls` — OLE-документ. Проверка не даёт выдать один формат за другой:
 * без неё файл с расширением `.xlsx`, но содержимым другого типа попал бы
 * в LibreOffice, где разбор ошибок занял бы минуты вместо мгновенного отказа.
 *
 * Список форматов сужен до входных форматов сервиса (XLSX/XLS): раньше здесь
 * были все форматы Р7-Офис, включая текстовые и PDF.
 *
 * Все комментарии на русском языке.
 *
 * Источник сигнатур: https://en.wikipedia.org/wiki/List_of_file_signatures
 */

import { MAGIC_BYTES_CHECK_SIZE } from './limits.js';

/** Минимальная длина буфера для содержательной проверки. */
const MIN_CHECK_BYTES = 4;

/**
 * Сигнатуры входных форматов.
 *
 * `null` означало бы «формат без сигнатуры» (так описывались текстовые
 * форматы); для таблиц таких нет — оба входных формата имеют заголовок.
 */
const SIGNATURES: Record<string, Buffer[]> = {
  // XLSX — zip-контейнер: 50 4B 03 04 (обычный архив)
  // или 50 4B 05 06 (пустой архив, встречается у книг без содержимого)
  xlsx: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  // XLS — OLE2-контейнер (D0 CF 11 E0 A1 B1 1A E1)
  xls: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
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

/**
 * Определяет формат файла по его содержимому.
 *
 * Нужен, когда клиент не указал формат: расширение из имени файла —
 * подсказка, а не доказательство, и опираться на неё одну нельзя.
 *
 * @param buffer - данные файла
 * @returns имя формата или null, если формат не распознан
 */
export function detectFileTypeByMagicBytes(buffer: Buffer): string | null {
  if (!buffer || buffer.length < MIN_CHECK_BYTES) {
    return null;
  }

  for (const [format, signatures] of Object.entries(SIGNATURES)) {
    if (signatures.some((signature) => matchesSignature(buffer, signature))) {
      return format;
    }
  }

  return null;
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
  detectFileTypeByMagicBytes,
  isSupportedFormat,
};
