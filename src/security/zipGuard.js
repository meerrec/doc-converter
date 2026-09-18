/**
 *Защита от ZIP-бомб и path traversal атак.
 *
 * Этот модуль проверяет ZIP-архивы БЕЗ распаковки содержимого (lazyEntries: true в yauzl).
 * Это критично для безопасности, так как распаковка опасного архива может:
 * 1. Заполнить диск (zip-bomb с огромным relation)
 * 2. Заполнить память (billion laughs attack через сжатие)
 * 3. Вызвать path traversal (../../etc/passwd)
 * 4. Перегрузить CPU (много записей)
 *
 * Все комментарии на русском языке.
 *
 * Используемый модуль: yauzl (lazy parsing, не распаковывает содержимое)
 */

import yauzl from 'yauzl';
import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
  ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  ZIP_MAX_COMPRESSION_RATIO,
  ZIP_MAX_PATH_DEPTH
} from './limits.js';

/**
 * Запрещённые расширения файлов в архиве.
 * Эти файлы не должны встречаться в OOXML/ODF документах и могут быть зловредными.
 */
const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib',
  '.bat', '.cmd', '.ps1', '.sh',
  '.js', '.vbs', '.wsf', '.jar',
  '.scr', '.com', '.msi', '.app',
  // Дополнительные опасные расширения
  '.sys', '.drv', '.ocx', '.cpl',
  '.lnk', '.pif', '.application'
]);

/**
 * Запрещённые символы в именах файлов.
 *.Control characters (0x00-0x1F, 0x7F) и некоторые специальные символы.
 */
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F<>:"|?*\\]/;

/**
 *Pattern для detection Windows drive paths (C:\...).
 */
const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:/;

/**
 *Pattern для detection абсолютных путей Unix (=/...).
 */
const ABSOLUTE_PATH_REGEX = /^\//;

/**
 * Ошибки, которые может выбрасывать zipGuard.
 */
export class ZipGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipGuardError';
    this.code = code;
  }
}

/**
 * Результаты проверки ZIP-архива.
 */
export class ZipGuardResult {
  constructor() {
    this.entries = [];
    this.totalUncompressedBytes = 0;
    this.entryCount = 0;
    this.maxCompressionRatio = 0;
    this.violations = [];
  }
  
  addViolation(code, message, entryName = null) {
    this.violations.push({ code, message, entryName });
  }
  
  get isValid() {
    return this.violations.length === 0;
  }
  
  get firstViolation() {
    return this.violations[0] || null;
  }
}

/**
 * Публичный набор лимитов ZIP-проверки — для использования вне модуля.
 */
export const ZIP_VALIDATION_LIMITS = {
  maxEntries: ZIP_MAX_ENTRIES,
  maxEntryUncompressedBytes: ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
  maxTotalUncompressedBytes: ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxCompressionRatio: ZIP_MAX_COMPRESSION_RATIO,
  maxPathDepth: ZIP_MAX_PATH_DEPTH,
};

/**
 * Проверяет имя файла в ZIP-архиве на безопасность.
 *
 * @param {string} fileName - имя файла из архива
 * @param {number} [maxPathDepth=ZIP_MAX_PATH_DEPTH] - максимальная глубина пути
 * @returns {string|null} - код ошибки или null если безопасно
 */
function validateEntryName(fileName, maxPathDepth = ZIP_MAX_PATH_DEPTH) {
  // Проверка на пустое имя
  if (!fileName || fileName.length === 0) {
    return 'archive_empty_entry_name';
  }

  // Проверка на control characters
  if (CONTROL_CHAR_REGEX.test(fileName)) {
    return 'archive_forbidden_name';
  }

  // Проверка на Windows drive path
  if (WINDOWS_DRIVE_REGEX.test(fileName)) {
    return 'archive_forbidden_name';
  }

  // Проверка на абсолютный путь Unix
  if (ABSOLUTE_PATH_REGEX.test(fileName)) {
    return 'archive_forbidden_name';
  }

  // Проверка на path traversal (../)
  if (fileName.includes('..')) {
    // Разрешаем .. в середине пути только если это не приводит к traversal
    // Но для безопасности проще запретить любое ..
    return 'archive_forbidden_name';
  }

  // Проверка на forbidden extensions
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    return 'archive_forbidden_extension';
  }

  // Проверка на глубину пути
  const depth = fileName.split('/').length;
  if (depth > maxPathDepth) {
    return 'archive_too_deep';
  }

  return null;
}

/**
 * Проверяет имя записи ZIP-архива на безопасность (boolean-версия).
 *
 * @param {string} fileName - имя файла из архива
 * @returns {boolean} - true, если имя безопасно
 */
export function checkZipEntryName(fileName) {
  return validateEntryName(fileName) === null;
}

/**
 * Проверяет ZIP-архив на безопасность.
 *
 * @param {Buffer} buffer - буфер с данными ZIP-архива
 * @param {Object} [options] - опции проверки
 * @param {number} [options.maxEntries=ZIP_MAX_ENTRIES] - максимальное количество записей
 * @param {number} [options.maxEntryUncompressedBytes=ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES] - max размер одной записи
 * @param {number} [options.maxTotalUncompressedBytes=ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES] - max общий размер
 * @param {number} [options.maxCompressionRatio=ZIP_MAX_COMPRESSION_RATIO] - max коэффициент сжатия
 * @param {number} [options.maxPathDepth=ZIP_MAX_PATH_DEPTH] - max глубина пути
 * @returns {Promise<ZipGuardResult>} - результат проверки
 * @throws {ZipGuardError} - если архив не может быть прочитан
 */
export async function validateZip(buffer, options = {}) {
  const {
    maxEntries = ZIP_MAX_ENTRIES,
    maxEntrySize = ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
    maxTotalSize = ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxCompressionRatio = ZIP_MAX_COMPRESSION_RATIO,
    maxPathDepth = ZIP_MAX_PATH_DEPTH
  } = options;

  // Поддерживаем оба набора имён опций: короткие (maxEntrySize/maxTotalSize)
  // и совпадающие с ZIP_VALIDATION_LIMITS (maxEntryUncompressedBytes/...)
  const entrySizeLimit = options.maxEntryUncompressedBytes ?? maxEntrySize;
  const totalSizeLimit = options.maxTotalUncompressedBytes ?? maxTotalSize;

  const result = new ZipGuardResult();

  return new Promise((resolve, reject) => {
    let totalUncompressedBytes = 0;
    let entryCount = 0;
    let hasEntries = false;
    const seenNames = new Set();
    let settled = false;

    /**
     * Завершает проверку и резолвит результат.
     *
     * @param {Object} [opts] - опции
     * @param {boolean} [opts.skipEmptyCheck=false] - не считать архив пустым
     *   (используется, когда чтение прервано на небезопасном имени)
     */
    const finish = (opts = {}) => {
      if (settled) return;
      settled = true;

      // Проверка на пустой архив
      if (!hasEntries && !opts.skipEmptyCheck) {
        result.addViolation('archive_empty', 'ZIP-архив не содержит записей');
      }

      // Проверка на общий размер
      if (totalUncompressedBytes > totalSizeLimit) {
        result.addViolation(
          'archive_total_too_large',
          `Общий размер ${totalUncompressedBytes} превышает лимит ${totalSizeLimit}`
        );
      }

      result.totalUncompressedBytes = totalUncompressedBytes;
      result.entryCount = entryCount;

      resolve(result);
    };

    /**
     * Завершает проверку ошибкой.
     *
     * @param {string} message - сообщение
     * @param {string} code - код ошибки
     */
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      reject(new ZipGuardError(message, code));
    };

    try {
      yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
        if (err) {
          return fail(`Не удалось прочитать ZIP-архив: ${err.message}`, 'archive_corrupt');
        }

        if (!zipFile) {
          return fail('Пустой или невалидный ZIP-архив', 'archive_empty');
        }

        /**
         * Переходит к следующей записи.
         *
         * При lazyEntries: true yauzl читает ровно одну запись за вызов
         * readEntry(), поэтому его нужно вызывать после каждой обработанной
         * записи — иначе поток чтения останавливается и 'end' не наступает.
         */
        const continueReading = () => {
          if (settled) return;

          // Лимит записей превышен — дальше читать нет смысла
          if (entryCount > maxEntries) {
            try {
              zipFile.close();
            } catch {
              // Игнорируем ошибки закрытия
            }
            finish();
            return;
          }

          zipFile.readEntry();
        };

        zipFile.on('entry', (entry) => {
          hasEntries = true;
          entryCount++;
          totalUncompressedBytes += entry.uncompressedSize;

          result.entries.push({
            fileName: entry.fileName,
            uncompressedLength: entry.uncompressedSize,
            compressedLength: entry.compressedSize
          });

          // Проверка на максимальное количество записей
          if (entryCount > maxEntries) {
            result.addViolation(
              'archive_too_many_entries',
              `Количество записей ${entryCount} превышает лимит ${maxEntries}`,
              entry.fileName
            );
            return continueReading();
          }

          // Проверка на дубликаты имён
          if (seenNames.has(entry.fileName)) {
            result.addViolation('archive_duplicate_entry', 'Дубликат имени записи', entry.fileName);
            return continueReading();
          }
          seenNames.add(entry.fileName);

          // Проверка имени файла
          const nameViolation = validateEntryName(entry.fileName, maxPathDepth);
          if (nameViolation) {
            result.addViolation(nameViolation, 'Запрещённое имя записи', entry.fileName);
            return continueReading();
          }

          // Проверка коэффициента сжатия — главный признак zip-бомбы
          if (entry.compressedSize > 0) {
            const ratio = entry.uncompressedSize / entry.compressedSize;

            if (ratio > result.maxCompressionRatio) {
              result.maxCompressionRatio = ratio;
            }

            if (ratio > maxCompressionRatio) {
              result.addViolation(
                'archive_ratio_exceeded',
                `Сжатие записи ${entry.fileName}: ${ratio.toFixed(2)} > ${maxCompressionRatio}`,
                entry.fileName
              );
            }
          }

          // Проверка на максимальный размер одной записи
          if (entry.uncompressedSize > entrySizeLimit) {
            result.addViolation(
              'archive_entry_too_large',
              `Размер записи ${entry.uncompressedSize} превышает лимит ${entrySizeLimit}`,
              entry.fileName
            );
          }

          continueReading();
        });

        zipFile.on('end', finish);

        zipFile.on('error', (readErr) => {
          const readMessage = readErr.message || '';

          // yauzl сам отвергает небезопасные имена (zip-slip, абсолютные пути).
          // Это нарушение правил архива, а не его повреждение — отдаём как violation.
          if (/invalid relative path|invalid characters in fileName|absolute path/i.test(readMessage)) {
            result.addViolation('archive_forbidden_name', readMessage);
            finish({ skipEmptyCheck: true });
            return;
          }

          fail(`Ошибка чтения ZIP-архива: ${readMessage}`, 'archive_corrupt');
        });

        zipFile.readEntry();
      });
    } catch (err) {
      fail(`Исключение при проверке ZIP: ${err.message}`, 'archive_corrupt');
    }
  });
}

/**
 * Быстрая проверка ZIP-архива (синхронная версия для небольших файлов).
 * Используется для быстрого отклонения явно опасных архивов.
 *
 * @param {Buffer} buffer - буфер с данными ZIP-архива
 * @returns {boolean} - true если архив выглядит безопасным
 */
export function quickZipCheck(buffer) {
  // Проверяем минимальный размер ZIP-архива
  if (buffer.length < 22) {
    return false; // Слишком маленький для валидного ZIP
  }

  // Проверяем сигнатуру ZIP
  const signature = buffer.slice(0, 4);
  const pk34 = Buffer.from('PK\x03\x04', 'binary');
  const pk56 = Buffer.from('PK\x05\x06', 'binary');
  
  if (signature.compare(pk34) !== 0 && signature.compare(pk56) !== 0) {
    return false; // Не ZIP-архив
  }

  return true;
}

export default {
  validateZip,
  quickZipCheck,
  checkZipEntryName,
  ZIP_VALIDATION_LIMITS,
  ZipGuardError,
  ZipGuardResult
};
