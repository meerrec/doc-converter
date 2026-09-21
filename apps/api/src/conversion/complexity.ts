/**
 * Оценка сложности задачи — по размеру файла и объёму документа.
 *
 * Оценка делается до постановки в очередь и не открывает документ
 * в LibreOffice: поднимать soffice ради классификации означало бы потратить
 * на неё больше времени, чем на саму конвертацию мелкого файла.
 *
 * Объём берётся из служебных частей контейнера: у книги это число листов
 * (`xl/workbook.xml`), у текстового документа — число страниц
 * (`docProps/app.xml`). Если файл не читается как zip или нужной части в нём
 * нет, задача классифицируется только по размеру: отказывать на этом шаге
 * нельзя — структуру уже проверил zip-гард, а решение о пригодности
 * принимает LibreOffice.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import {
  COMPLEXITY_LIGHT_MAX_BYTES,
  COMPLEXITY_LIGHT_MAX_PAGES,
  COMPLEXITY_LIGHT_MAX_SHEETS,
  COMPLEXITY_MEDIUM_MAX_BYTES,
  COMPLEXITY_MEDIUM_MAX_PAGES,
  COMPLEXITY_MEDIUM_MAX_SHEETS,
} from '@doc-converter/config';
import type { ComplexityTier, InputFormat } from '@doc-converter/contract';

const require = createRequire(import.meta.url);

/**
 * Предельный размер служебного XML, который читается целиком.
 *
 * 8 МиБ — с большим запасом: даже книга с сотнями листов описывается
 * в `workbook.xml` десятками килобайт, а `app.xml` и того меньше.
 * Ограничение защищает от подмены: под служебным именем может лежать
 * распакованная «бомба».
 */
const MAX_META_XML_BYTES = 8 * 1024 * 1024;

/** Часть пакета книги, в которой перечислены листы. */
const WORKBOOK_ENTRY = 'xl/workbook.xml';

/** Часть пакета документа, в которой записаны его свойства. */
const APP_XML_ENTRY = 'docProps/app.xml';

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
  /** Число листов книги; null — определить не удалось или формат не книга. */
  sheets: number | null;
  /** Число страниц документа; null — определить не удалось или формат не документ. */
  pages: number | null;
  /** Размер файла в байтах. */
  sizeBytes: number;
}

/**
 * Читает служебный XML из zip-контейнера.
 *
 * @param buffer - содержимое файла
 * @param entryName - имя части пакета
 * @returns содержимое части или null, если прочитать не удалось
 */
function readEntryText(buffer: Buffer, entryName: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: string | null, zipFile?: ZipFile): void => {
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
        if (entry.fileName !== entryName) {
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

            if (total > MAX_META_XML_BYTES) {
              finish(null, zipFile);
              return;
            }

            chunks.push(chunk);
          });

          stream.on('error', () => finish(null, zipFile));
          stream.on('end', () => {
            finish(Buffer.concat(chunks).toString('utf8'), zipFile);
          });
        });
      }) as (...args: never[]) => void);

      zipFile.readEntry();
    });
  });
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
 * Считает страницы по содержимому `docProps/app.xml`.
 *
 * Число страниц записывает в этот файл приложение-автор, поэтому значение
 * оценочное: оно не пересчитывается при правке документа сторонним
 * редактором. Для выбора очереди этого достаточно, а страхует от промаха
 * вторая ось — размер файла.
 *
 * @param xml - содержимое app.xml
 * @returns число страниц или null, если его в файле нет
 */
function countPagesInXml(xml: string): number | null {
  const match = /<Pages>(\d+)<\/Pages>/.exec(xml);

  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Читает число листов книги из контейнера.
 *
 * @param buffer - содержимое книги XLSX
 * @returns число листов или null, если определить не удалось
 */
async function readSheetCount(buffer: Buffer): Promise<number | null> {
  const xml = await readEntryText(buffer, WORKBOOK_ENTRY);

  return xml === null ? null : countSheetsInXml(xml);
}

/**
 * Читает число страниц документа из контейнера.
 *
 * @param buffer - содержимое документа DOCX
 * @returns число страниц или null, если определить не удалось
 */
async function readPageCount(buffer: Buffer): Promise<number | null> {
  const xml = await readEntryText(buffer, APP_XML_ENTRY);

  return xml === null ? null : countPagesInXml(xml);
}

/**
 * Определяет уровень сложности по значению и двум порогам.
 *
 * @param value - измеренная величина
 * @param lightMax - верхняя граница «лёгкой» задачи
 * @param mediumMax - верхняя граница «средней» задачи
 * @returns уровень сложности
 */
function tierByThresholds(value: number, lightMax: number, mediumMax: number): ComplexityTier {
  if (value <= lightMax) {
    return 'light';
  }

  if (value <= mediumMax) {
    return 'medium';
  }

  return 'heavy';
}

/** Порядок уровней от простого к сложному — для выбора старшего. */
const TIER_ORDER: readonly ComplexityTier[] = ['light', 'medium', 'heavy'];

/**
 * Берёт старший из двух уровней.
 *
 * Итоговый уровень — максимум по размеру и по объёму документа: книга может
 * быть маленькой, но состоять из сотни листов, и наоборот — один лист может
 * весить десятки мегабайт.
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
 * @param buffer - содержимое файла
 * @param inputFormat - формат, определённый по содержимому контейнера
 * @returns уровень сложности, объём документа и размер
 */
export async function estimateComplexity(
  buffer: Buffer,
  inputFormat: InputFormat
): Promise<ComplexityEstimate> {
  const sizeBytes = buffer.length;

  const sheets = inputFormat === 'xlsx' ? await readSheetCount(buffer) : null;
  const pages = inputFormat === 'docx' ? await readPageCount(buffer) : null;

  let tier = tierByThresholds(
    sizeBytes,
    COMPLEXITY_LIGHT_MAX_BYTES,
    COMPLEXITY_MEDIUM_MAX_BYTES
  );

  if (sheets !== null) {
    tier = maxTier(
      tier,
      tierByThresholds(sheets, COMPLEXITY_LIGHT_MAX_SHEETS, COMPLEXITY_MEDIUM_MAX_SHEETS)
    );
  }

  if (pages !== null) {
    tier = maxTier(
      tier,
      tierByThresholds(pages, COMPLEXITY_LIGHT_MAX_PAGES, COMPLEXITY_MEDIUM_MAX_PAGES)
    );
  }

  return { tier, sheets, pages, sizeBytes };
}

export default { estimateComplexity };
