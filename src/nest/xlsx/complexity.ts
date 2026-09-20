/**
 * Оценка сложности задачи — по размеру файла и числу листов книги.
 *
 * Оценка делается до постановки в очередь и не открывает документ
 * в LibreOffice: поднимать soffice ради классификации означало бы потратить
 * на неё больше времени, чем на саму конвертацию мелкого файла.
 *
 * Число листов читается прямо из zip-контейнера XLSX (`xl/workbook.xml`).
 * Файлы старого формата `.xls` — OLE-контейнер, а не zip, поэтому для них
 * классификация идёт только по размеру.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import {
  COMPLEXITY_LIGHT_MAX_BYTES,
  COMPLEXITY_LIGHT_MAX_SHEETS,
  COMPLEXITY_MEDIUM_MAX_BYTES,
  COMPLEXITY_MEDIUM_MAX_SHEETS,
} from '../../config/index.js';
import type { ComplexityTier } from '@doc-converter/contract';

const require = createRequire(import.meta.url);

/**
 * Предельный размер `xl/workbook.xml`, который читается целиком.
 *
 * 8 МиБ — с большим запасом: даже книга с сотнями листов описывается
 * в этом файле десятками килобайт. Ограничение защищает от подмены:
 * под именем workbook.xml может лежать распакованная «бомба».
 */
const MAX_WORKBOOK_XML_BYTES = 8 * 1024 * 1024;

/** Минимальная форма zip-библиотеки, которая здесь используется. */
interface ZipEntry {
  fileName: string;
}

interface ZipFile {
  readEntry(): void;
  openReadStream(
    entry: ZipEntry,
    callback: (err: Error | null, stream?: NodeJS.ReadableStream) => void
  ): void;
  on(event: string, listener: (...args: never[]) => void): void;
  close(): void;
}

type FromBufferCallback = (err: Error | null, zipFile?: ZipFile) => void;

const yauzl = require('yauzl') as {
  fromBuffer(buffer: Buffer, options: { lazyEntries: boolean }, callback: FromBufferCallback): void;
};

/** Результат оценки сложности. */
export interface ComplexityEstimate {
  /** Уровень сложности и, значит, очередь. */
  tier: ComplexityTier;
  /** Число листов книги; null — определить не удалось (не zip или файл повреждён). */
  sheets: number | null;
  /** Размер файла в байтах. */
  sizeBytes: number;
}

/**
 * Считает листы по содержимому `xl/workbook.xml`.
 *
 * Элементы `<sheet .../>` перечислены внутри `<sheets>`; других вхождений
 * этого имени в файле нет, поэтому достаточно подсчёта открывающих тегов.
 *
 * @param xml - содержимое workbook.xml
 * @returns число листов
 */
function countSheetsInXml(xml: string): number {
  const matches = xml.match(/<sheet\b/g);

  return matches ? matches.length : 0;
}

/**
 * Читает `xl/workbook.xml` из zip-контейнера и считает листы.
 *
 * @param buffer - содержимое XLSX
 * @returns число листов или null, если определить не удалось
 */
function readSheetCount(buffer: Buffer): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: number | null, zipFile?: ZipFile): void => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        zipFile?.close();
      } catch {
        // Закрытие уже закрытого архива — не повод менять результат
      }

      resolve(value);
    };

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
      if (err || !zipFile) {
        finish(null);
        return;
      }

      zipFile.on('error', () => finish(null));
      zipFile.on('end', () => finish(null));

      zipFile.on('entry', ((entry: ZipEntry) => {
        if (entry.fileName !== 'xl/workbook.xml') {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            finish(null, zipFile);
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;

          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;

            if (total > MAX_WORKBOOK_XML_BYTES) {
              finish(null, zipFile);
              return;
            }

            chunks.push(chunk);
          });

          stream.on('error', () => finish(null, zipFile));
          stream.on('end', () => {
            finish(countSheetsInXml(Buffer.concat(chunks).toString('utf8')), zipFile);
          });
        });
      }) as (...args: never[]) => void);

      zipFile.readEntry();
    });
  });
}

/**
 * Определяет уровень сложности по размеру файла.
 *
 * @param sizeBytes - размер файла
 * @returns уровень сложности
 */
function tierBySize(sizeBytes: number): ComplexityTier {
  if (sizeBytes <= COMPLEXITY_LIGHT_MAX_BYTES) {
    return 'light';
  }

  if (sizeBytes <= COMPLEXITY_MEDIUM_MAX_BYTES) {
    return 'medium';
  }

  return 'heavy';
}

/**
 * Определяет уровень сложности по числу листов.
 *
 * @param sheets - число листов
 * @returns уровень сложности
 */
function tierBySheets(sheets: number): ComplexityTier {
  if (sheets <= COMPLEXITY_LIGHT_MAX_SHEETS) {
    return 'light';
  }

  if (sheets <= COMPLEXITY_MEDIUM_MAX_SHEETS) {
    return 'medium';
  }

  return 'heavy';
}

/** Порядок уровней от простого к сложному — для выбора старшего. */
const TIER_ORDER: readonly ComplexityTier[] = ['light', 'medium', 'heavy'];

/**
 * Берёт старший из двух уровней.
 *
 * Итоговый уровень — максимум по размеру и по числу листов: книга может быть
 * маленькой, но состоять из сотни листов, и наоборот — один лист может весить
 * десятки мегабайт.
 *
 * @param a - первый уровень
 * @param b - второй уровень
 * @returns старший уровень
 */
function maxTier(a: ComplexityTier, b: ComplexityTier): ComplexityTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Оценивает сложность задачи.
 *
 * @param buffer - содержимое XLSX/XLS
 * @returns уровень сложности, число листов и размер
 */
export async function estimateComplexity(buffer: Buffer): Promise<ComplexityEstimate> {
  const sizeBytes = buffer.length;
  const sheets = await readSheetCount(buffer);

  const bySize = tierBySize(sizeBytes);
  const tier = sheets === null ? bySize : maxTier(bySize, tierBySheets(sheets));

  return { tier, sheets, sizeBytes };
}

export default { estimateComplexity };
