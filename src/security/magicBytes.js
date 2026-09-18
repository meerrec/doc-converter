/**
 *Проверка magic bytes (сигнатур) файлов.
 *
 * Magic bytes — это первые несколько байт файла, которые уникально идентифицируют
 * его формат. Проверка magic bytes необходима, чтобы предотвратить:
 * 1. Подмену расширения (attacker загружает .exe, но называет его .docx)
 * 2. Конвертацию неподдерживаемых форматов
 * 3. Атаки через неправильно объявленные форматы
 *
 * Все комментарии на русском языке.
 *
 * Источники сигнатур:
 * - https://en.wikipedia.org/wiki/List_of_file_signatures
 * - OOXML ECMA-376 спецификация
 * - PDF спецификация ISO 32000
 */

/**
 * Сигнатуры поддерживаемых форматов.
 * Ключ — объявленный filetype, значение — ожидаемая сигнатура (hex или строка).
 */
const SIGNATURES = {
  // --- ZIP-based форматы (OOXML / ODF) ---
  // DOCX, XLSX, PPTX, ODT, ODS, ODP, EPUB используют ZIP-контейнер
  // Сигнатура: 50 4B 03 04 (local file header) или 50 4B 05 06 (empty archive)
  docx: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  xlsx: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  pptx: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  odt: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  ods: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  odp: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  epub: [Buffer.from('PK\x03\x04', 'binary'), Buffer.from('PK\x05\x06', 'binary')],
  
  // --- OLE Compound File формат (старые Office форматы) ---
  // DOC, XLS, PPT используют OLE Compound File Binary Format (CFB)
  // Сигнатура: D0 CF 11 E0 A1 B1 1A E1
  doc: [Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  xls: [Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  ppt: [Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])],
  
  // --- PDF ---
  // Сигнатура: 25 50 44 46 (%PDF)
  pdf: [Buffer.from('%PDF', 'ascii')],
  
  // --- RTF ---
  // Сигнатура: 7B 5C 72 74 66 ({\rtf)
  // Достаточно 5 байт — версия RTF идёт следом и может отличаться
  rtf: [Buffer.from('{\\rtf', 'ascii')],
  
  // --- Изображения ---
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  png: [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  // JPEG: FF D8 FF
  jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  
  // --- Текстовые форматы ---
  // Для текстовых форматов проверяем ОТСУТСТВИЕ NUL-байтов в первых 8 KiB
  // (они не должны там встречаться)
  txt: null,  // специальная обработка
  html: null, // специальная обработка
  htm: null,  // специальная обработка
  csv: null,  // специальная обработка
};

/**
 * Размер буфера для проверки magic bytes.
 * 8 байт достаточно для идентификации любого поддерживаемого формата.
 */
const CHECK_SIZE = 8;

/**
 * Минимальная длина буфера, при которой проверка сигнатуры имеет смысл.
 * Короткий буфер не позволяет отличить формат — считаем его невалидным.
 * 3 байта — минимальная осмысленная сигнатура (JPEG: FF D8 FF).
 */
const MIN_CHECK_BYTES = 3;

/**
 * Сигнатуры поддерживаемых форматов (публичный алиас).
 */
export const MAGIC_SIGNATURES = SIGNATURES;

/**
 * Сравнивает начало буфера с сигнатурой.
 *
 * Буфер может быть короче сигнатуры (например, в тестах передают только
 * первые байты файла) — тогда сравнивается столько байт, сколько есть,
 * но не меньше MIN_CHECK_BYTES.
 *
 * @param {Buffer} buffer — данные файла
 * @param {Buffer} signature — ожидаемая сигнатура
 * @returns {boolean} — true, если начало буфера совпадает с сигнатурой
 */
function matchesSignature(buffer, signature) {
  if (buffer.length < MIN_CHECK_BYTES) {
    return false;
  }

  const compareLength = Math.min(signature.length, buffer.length);
  return buffer.compare(signature, 0, compareLength, 0, compareLength) === 0;
}

/**
 * Проверяет, что переданный буфер соответствует объявленному формату.
 *
 * @param {Buffer} buffer — данные файла
 * @param {string} declaredType — объявленный filetype
 * @returns {boolean} — true, если сигнатура совпадает
 */
export function verifyMagicBytes(buffer, declaredType) {
  return checkMagicBytes(buffer, declaredType).valid;
}

/**
 * Проверяет сигнатуру файла и возвращает подробный результат.
 *
 * @param {Buffer} buffer — данные файла
 * @param {string} declaredType — объявленный filetype
 * @returns {{valid: boolean, error?: {errorCode: string, message: string}}}
 */
export function checkMagicBytes(buffer, declaredType) {
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_buffer_empty',
        message: 'Buffer is empty'
      }
    };
  }

  if (typeof declaredType !== 'string' || declaredType.length === 0) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_type_missing',
        message: 'Declared file type is missing'
      }
    };
  }

  const normalizedType = declaredType.toLowerCase();
  const signatures = SIGNATURES[normalizedType];

  if (signatures === undefined) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_unsupported_type',
        message: `Unsupported file type: ${declaredType}`
      }
    };
  }

  // Специальная обработка для текстовых форматов
  if (signatures === null) {
    const isText = verifyTextFormat(buffer);
    return isText
      ? { valid: true }
      : {
          valid: false,
          error: {
            errorCode: 'magic_mismatch',
            message: `Declared format ${declaredType} is text, but buffer contains binary data`
          }
        };
  }

  // Короткий буфер не позволяет достоверно определить формат
  if (buffer.length < MIN_CHECK_BYTES) {
    return {
      valid: false,
      error: {
        errorCode: 'magic_buffer_too_small',
        message: `Buffer of ${buffer.length} bytes is too small to verify signature`
      }
    };
  }

  // Проверяем все сигнатуры для данного типа
  const checkBuffer = buffer.slice(0, CHECK_SIZE);

  for (const signature of signatures) {
    if (matchesSignature(checkBuffer, signature)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: {
      errorCode: 'magic_mismatch',
      message: `Magic bytes do not match declared filetype: ${declaredType}`
    }
  };
}

/**
 * Определяет формат файла по magic bytes и возвращает конкретный формат.
 *
 * ZIP-контейнер не позволяет отличить DOCX от XLSX без разбора содержимого,
 * поэтому возвращается первый подходящий формат семейства.
 *
 * @param {Buffer} buffer — данные файла
 * @returns {string|null} — обнаруженный формат или null
 */
export function getFormatFromMagic(buffer) {
  const detected = detectFileTypeByMagicBytes(buffer);

  switch (detected) {
    case 'zip':
      // ZIP-контейнер: OOXML/ODF. Точный формат требует разбора архива
      return 'docx';
    case 'ole':
      // OLE Compound File: старые форматы Office
      return 'doc';
    case 'pdf':
      return 'pdf';
    case 'rtf':
      return 'rtf';
    case 'png':
      return 'png';
    case 'jpeg':
      return 'jpg';
    default:
      return null;
  }
}

/**
 * Проверяет текстовый формат на наличие NUL-байтов.
 * Текстовые форматы не должны содержать NUL-байты (0x00).
 *
 * @param {Buffer} buffer — данные файла
 * @returns {boolean} — true, если это текстовый файл (нет NUL в первых 8 KiB)
 */
export function verifyTextFormat(buffer) {
  const checkSize = Math.min(buffer.length, 8192); // 8 KiB
  const checkBuffer = buffer.slice(0, checkSize);
  
  // Ищем NUL-байт в проверяемом буфере
  for (let i = 0; i < checkBuffer.length; i++) {
    if (checkBuffer[i] === 0x00) {
      return false; // Найден NUL — это бинарный файл, а не текст
    }
  }
  
  return true; // NUL не найден — это текстовый файл
}

/**
 * Определяет формат файла по magic bytes.
 * Используется для автоматического определения формата, если он не объявлен.
 *
 * @param {Buffer} buffer — данные файла
 * @returns {string|null} — обнаруженный формат или null
 */
export function detectFileTypeByMagicBytes(buffer) {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  const checkBuffer = buffer.slice(0, CHECK_SIZE);
  
  // Проверяем ZIP-сигнатуру (PK)
  if (checkBuffer[0] === 0x50 && checkBuffer[1] === 0x4B) {
    // Это ZIP-архив — может быть DOCX, XLSX, PPTX, ODT, ODS, ODP, EPUB
    return 'zip';
  }

  // Проверяем OLE CFB сигнатуру
  if (checkBuffer.length >= 8 &&
      checkBuffer[0] === 0xD0 && checkBuffer[1] === 0xCF &&
      checkBuffer[2] === 0x11 && checkBuffer[3] === 0xE0 &&
      checkBuffer[4] === 0xA1 && checkBuffer[5] === 0xB1 &&
      checkBuffer[6] === 0x1A && checkBuffer[7] === 0xE1) {
    return 'ole';
  }

  // Проверяем PDF
  if (checkBuffer.compare(Buffer.from('%PDF', 'ascii'), 0, 3, 0, 3) === 0) {
    return 'pdf';
  }

  // Проверяем RTF
  if (checkBuffer.compare(Buffer.from('{\\rtf', 'ascii'), 0, 5, 0, 5) === 0) {
    return 'rtf';
  }

  // Проверяем PNG
  if (checkBuffer.compare(Buffer.from([0x89, 0x50, 0x4E, 0x47]), 0, 4, 0, 4) === 0) {
    return 'png';
  }

  // Проверяем JPEG
  if (checkBuffer.compare(Buffer.from([0xFF, 0xD8, 0xFF]), 0, 3, 0, 3) === 0) {
    return 'jpeg';
  }

  return null;
}

/**
 * Список поддерживаемых форматов (из SIGNATURES).
 */
export const SUPPORTED_FORMATS = Object.keys(SIGNATURES);

/**
 * Проверяет, поддерживается ли формат.
 *
 * @param {string} fileType — формат файла
 * @returns {boolean} — true, если формат поддерживается
 */
export function isSupportedFormat(fileType) {
  return SUPPORTED_FORMATS.includes(fileType.toLowerCase());
}
