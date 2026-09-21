/**
 * Защита от ZIP-бомб и path traversal атак.
 *
 * Метаданные архива (имена записей, заявленные размеры) читаются через yauzl
 * в режиме lazyEntries, но лимиты проверяются по **измеренным** размерам:
 * каждая запись читается потоком, и поток обрывается, как только фактический
 * объём превысил заявленный.
 *
 * Почему нельзя проверять лимиты по заявленным числам: `uncompressedSize`
 * и `compressedSize` берутся из central directory, которую пишет автор архива.
 * Подделанный архив объявляет `uncompressedSize == compressedSize`
 * (коэффициент 1, все лимиты пройдены), а в deflate-потоке держит данные
 * с реальным сжатием порядка 1000:1 — при входе в 100 МиБ это десятки гигабайт
 * распаковки силами LibreOffice. `validateEntrySizes` у yauzl для этого
 * не годится: она срабатывает при открытии потока, то есть ровно тогда,
 * когда мы и так читаем запись.
 *
 * Что даёт чтение потоком:
 * 1. Подделанный архив отбраковывается после `заявленный размер + 1` байт,
 *    а не после распаковки бомбы.
 * 2. Лимиты на запись и на сумму считаются по фактическим байтам.
 * 3. Расхождение вниз (фактически меньше заявленного) нарушением не считается:
 *    опасность представляет только недообъявленный объём.
 *
 * Имена записей проверяются до чтения содержимого, поэтому path traversal
 * отсекается без распаковки.
 *
 * Все комментарии на русском языке.
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
const FORBIDDEN_EXTENSIONS = new Set<string>([
  '.exe', '.dll', '.so', '.dylib',
  '.bat', '.cmd', '.ps1', '.sh',
  '.js', '.vbs', '.wsf', '.jar',
  '.scr', '.com', '.msi', '.app',
  // Дополнительные опасные расширения
  '.sys', '.drv', '.ocx', '.cpl',
  '.lnk', '.pif', '.application'
]);

/**
 * Часть пакета OOXML, в которой лежат макросы VBA.
 *
 * Расширение `.bin` безобидно, поэтому в список запрещённых расширений такая
 * часть не попадает — проверяется точное имя: в книгах и документах с
 * макросами она лежит в `xl/` и `word/` соответственно.
 */
const VBA_PROJECT_ENTRY = 'vbaproject.bin';

/**
 * Запрещённые символы в именах файлов.
 *
 * Управляющие символы (0x00–0x1F, 0x7F) и некоторые специальные символы.
 */
// Управляющие символы здесь ищутся намеренно: имена частей архива приходят
// из недоверенного файла, и такие символы в них — признак подделки, а не
// повод для осторожности
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F<>:"|?*\\]/;

/**
 * Шаблон пути Windows с буквой диска (C:\...).
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
  // `declare` не создаёт собственное свойство: `code` присваивается в
  // конструкторе, поэтому порядок ключей остаётся прежним (name, code)
  declare code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ZipGuardError';
    this.code = code;
  }
}

/**
 * Описание записи ZIP-архива, попавшей в результат проверки.
 */
interface ZipEntryInfo {
  fileName: string;
  uncompressedLength: number;
  compressedLength: number;
}

/**
 * Нарушение, найденное в ZIP-архиве.
 */
interface ZipViolation {
  code: string;
  message: string;
  entryName: string | null;
}

/**
 * Опции проверки ZIP-архива.
 *
 * Поддерживаются оба набора имён: короткие (maxEntrySize/maxTotalSize)
 * и совпадающие с ZIP_VALIDATION_LIMITS (maxEntryUncompressedBytes/maxTotalUncompressedBytes).
 */
interface ZipValidationOptions {
  /** Максимальное количество записей (по умолчанию ZIP_MAX_ENTRIES). */
  maxEntries?: number;
  /** Короткое имя для лимита размера одной записи. */
  maxEntrySize?: number;
  /** Короткое имя для лимита общего размера. */
  maxTotalSize?: number;
  /** Максимальный коэффициент сжатия (по умолчанию ZIP_MAX_COMPRESSION_RATIO). */
  maxCompressionRatio?: number;
  /** Максимальная глубина пути (по умолчанию ZIP_MAX_PATH_DEPTH). */
  maxPathDepth?: number;
  /** max размер одной записи (по умолчанию ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES). */
  maxEntryUncompressedBytes?: number;
  /** max общий размер (по умолчанию ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES). */
  maxTotalUncompressedBytes?: number;
}

/**
 * Результаты проверки ZIP-архива.
 */
export class ZipGuardResult {
  entries: ZipEntryInfo[];

  totalUncompressedBytes: number;

  entryCount: number;

  maxCompressionRatio: number;

  violations: ZipViolation[];

  constructor() {
    this.entries = [];
    this.totalUncompressedBytes = 0;
    this.entryCount = 0;
    this.maxCompressionRatio = 0;
    this.violations = [];
  }

  addViolation(code: string, message: string, entryName: string | null = null): void {
    this.violations.push({ code, message, entryName });
  }

  get isValid(): boolean {
    return this.violations.length === 0;
  }

  get firstViolation(): ZipViolation | null {
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
 * @param fileName - имя файла из архива
 * @param maxPathDepth - максимальная глубина пути (по умолчанию ZIP_MAX_PATH_DEPTH)
 * @returns - код ошибки или null если безопасно
 */
function validateEntryName(fileName: string, maxPathDepth: number = ZIP_MAX_PATH_DEPTH): string | null {
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

  // Проект VBA: макросы документа. Расширения `.xlsm`/`.docm` сервис
  // не принимает, но по структуре контейнера они не отличаются от обычных
  // книг и документов — входной формат определяется по главной части пакета,
  // и макросодержащий файл прошёл бы эту проверку, не будь её здесь.
  const baseName = fileName.slice(fileName.lastIndexOf('/') + 1).toLowerCase();
  if (baseName === VBA_PROJECT_ENTRY) {
    return 'archive_forbidden_name';
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
 * @param fileName - имя файла из архива
 * @returns - true, если имя безопасно
 */
export function checkZipEntryName(fileName: string): boolean {
  return validateEntryName(fileName) === null;
}

/**
 * Проверяет ZIP-архив на безопасность.
 *
 * @param buffer - буфер с данными ZIP-архива
 * @param options - опции проверки
 * @param options.maxEntries - максимальное количество записей (по умолчанию ZIP_MAX_ENTRIES)
 * @param options.maxEntryUncompressedBytes - max размер одной записи (по умолчанию ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES)
 * @param options.maxTotalUncompressedBytes - max общий размер (по умолчанию ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES)
 * @param options.maxCompressionRatio - max коэффициент сжатия (по умолчанию ZIP_MAX_COMPRESSION_RATIO)
 * @param options.maxPathDepth - max глубина пути (по умолчанию ZIP_MAX_PATH_DEPTH)
 * @returns - результат проверки
 * @throws {ZipGuardError} - если архив не может быть прочитан
 */
export async function validateZip(buffer: Buffer, options: ZipValidationOptions = {}): Promise<ZipGuardResult> {
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

  return new Promise<ZipGuardResult>((resolve, reject) => {
    let totalUncompressedBytes = 0;
    let entryCount = 0;
    let hasEntries = false;
    const seenNames = new Set<string>();
    let settled = false;

    /**
     * Завершает проверку и резолвит результат.
     *
     * @param opts - опции
     * @param opts.skipEmptyCheck - не считать архив пустым
     *   (используется, когда чтение прервано на небезопасном имени)
     */
    const finish = (opts: { skipEmptyCheck?: boolean } = {}): void => {
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
     * @param message - сообщение
     * @param code - код ошибки
     */
    const fail = (message: string, code: string): void => {
      if (settled) return;
      settled = true;
      reject(new ZipGuardError(message, code));
    };

    try {
      // validateEntrySizes выключена намеренно: проверка размеров выполняется
      // здесь по фактически прочитанным байтам (см. verifyEntry). Встроенная
      // проверка yauzl срабатывает только при открытии потока и одинаково
      // отвергает оба расхождения, тогда как опасность представляет лишь
      // недообъявленный объём
      yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: false }, (err, zipFile) => {
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
        const continueReading = (): void => {
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

        /**
         * Читает запись потоком и сверяет фактический объём с заявленным.
         *
         * Поток обрывается на первом же байте сверх заявленного: подделанный
         * архив стоит `заявленный размер + 1` байт чтения, а не распаковки
         * бомбы. Честная запись читается целиком — её объём и так ограничен
         * лимитом на запись и суммой.
         *
         * @param entry - проверяемая запись
         * @param done - продолжить обход архива
         */
        const verifyEntry = (entry: yauzl.Entry, done: () => void): void => {
          const declared = entry.uncompressedSize;

          // Защита от повторного завершения: 'data' с нарушением, 'error'
          // и 'end' могут прийти на одну и ту же запись
          let closed = false;

          /**
           * Завершает проверку записи и продолжает обход.
           *
           * @param measured - фактически прочитанный объём
           */
          const closeEntry = (measured: number): void => {
            if (closed) return;
            closed = true;

            totalUncompressedBytes += measured;

            result.entries.push({
              fileName: entry.fileName,
              uncompressedLength: measured,
              compressedLength: entry.compressedSize
            });

            done();
          };

          zipFile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              result.addViolation(
                'archive_corrupt',
                `Не удалось прочитать запись: ${streamErr?.message ?? 'поток недоступен'}`,
                entry.fileName
              );
              closeEntry(0);
              return;
            }

            let actual = 0;

            /**
             * Прерывает чтение записи с нарушением.
             *
             * @param code - код нарушения
             * @param message - описание
             */
            const abortWith = (code: string, message: string): void => {
              result.addViolation(code, message, entry.fileName);
              stream.destroy();
              closeEntry(0);
            };

            stream.on('data', (chunk: Buffer) => {
              actual += chunk.length;

              // Расхождение вниз нарушением не считается: если данных меньше
              // заявленного, опасно как раз обратное
              if (actual > declared) {
                abortWith(
                  'archive_size_mismatch',
                  `Запись распаковывается больше заявленного (${declared} Б) — central directory недостоверна`
                );
                return;
              }

              if (actual > entrySizeLimit) {
                abortWith(
                  'archive_entry_too_large',
                  `Фактический размер записи превышает лимит ${entrySizeLimit}`
                );
                return;
              }

              if (totalUncompressedBytes + actual > totalSizeLimit) {
                abortWith(
                  'archive_total_too_large',
                  `Фактический суммарный размер превышает лимит ${totalSizeLimit}`
                );
              }
            });

            stream.on('error', (readErr: Error) => {
              result.addViolation(
                'archive_corrupt',
                `Ошибка чтения записи: ${readErr.message}`,
                entry.fileName
              );
              closeEntry(0);
            });

            stream.on('end', () => closeEntry(actual));
          });
        };

        zipFile.on('entry', (entry: yauzl.Entry) => {
          hasEntries = true;
          entryCount++;

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

          // Проверка коэффициента сжатия по заявленным числам — дешёвый
          // признак, который отсекает архив до чтения. Окончательное решение
          // принимает verifyEntry: заявленным числам доверять нельзя
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
              return continueReading();
            }
          }

          // Заявленный размер превышает лимит — читать такую запись незачем
          if (entry.uncompressedSize > entrySizeLimit) {
            result.addViolation(
              'archive_entry_too_large',
              `Заявленный размер записи ${entry.uncompressedSize} превышает лимит ${entrySizeLimit}`,
              entry.fileName
            );
            return continueReading();
          }

          verifyEntry(entry, continueReading);
        });

        zipFile.on('end', finish);

        zipFile.on('error', (readErr: Error) => {
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
      fail(`Исключение при проверке ZIP: ${(err as Error).message}`, 'archive_corrupt');
    }
  });
}

/**
 * Быстрая проверка ZIP-архива (синхронная версия для небольших файлов).
 * Используется для быстрого отклонения явно опасных архивов.
 *
 * @param buffer - буфер с данными ZIP-архива
 * @returns - true если архив выглядит безопасным
 */
export function quickZipCheck(buffer: Buffer): boolean {
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
