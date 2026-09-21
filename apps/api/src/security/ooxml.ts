/**
 * Определение вида документа внутри контейнера OOXML.
 *
 * Сигнатуры для этого недостаточно: у книги Excel и у документа Word она
 * одна и та же (`PK\x03\x04`), потому что оба являются zip-архивами. Вид
 * документа определяется по оглавлению пакета: у книги есть
 * `xl/workbook.xml`, у текстового документа — `word/document.xml`.
 *
 * Читается только оглавление (central directory): имена записей перечислены
 * в нём целиком, и распаковывать содержимое ради определения формата
 * не нужно. Функция вызывается после zip-гарда, поэтому число записей уже
 * ограничено, а сама она ничего не распаковывает.
 *
 * Имена записей, а не `[Content_Types].xml`: содержимое этого файла —
 * канонический признак, но ради него пришлось бы распаковывать запись,
 * а имена главных частей пакета спецификацией зафиксированы.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import type { InputFormat } from '@doc-converter/contract';

const require = createRequire(import.meta.url);

/** Главная часть пакета книги Excel. */
const WORKBOOK_ENTRY = 'xl/workbook.xml';

/** Главная часть пакета текстового документа Word. */
const DOCUMENT_ENTRY = 'word/document.xml';

/** Минимальная форма zip-библиотеки, которая здесь используется. */
interface ZipEntry {
  fileName: string;
}

interface ZipFile {
  readEntry(): void;
  on(event: string, listener: (...args: never[]) => void): void;
  close(): void;
}

type FromBufferCallback = (err: Error | null, zipFile?: ZipFile) => void;

const yauzl = require('yauzl') as {
  fromBuffer(buffer: Buffer, options: { lazyEntries: boolean }, callback: FromBufferCallback): void;
};

/**
 * Определяет вид документа по содержимому zip-контейнера.
 *
 * Каталог читается до конца, а не до первой находки: если в пакете
 * оказались обе главные части, назвать документ книгой или текстом нельзя,
 * и честнее вернуть null, чем угадывать.
 *
 * @param buffer - содержимое файла
 * @returns вид документа или null, если архив не читается либо это не OOXML
 */
export function detectOoxmlKind(buffer: Buffer): Promise<InputFormat | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: InputFormat | null, zipFile?: ZipFile): void => {
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

      let hasWorkbook = false;
      let hasDocument = false;

      zipFile.on('error', () => finish(null));

      zipFile.on('end', () => {
        if (hasWorkbook === hasDocument) {
          finish(null);
          return;
        }

        finish(hasWorkbook ? 'xlsx' : 'docx');
      });

      zipFile.on('entry', ((entry: ZipEntry) => {
        if (entry.fileName === WORKBOOK_ENTRY) {
          hasWorkbook = true;
        } else if (entry.fileName === DOCUMENT_ENTRY) {
          hasDocument = true;
        }

        zipFile.readEntry();
      }) as (...args: never[]) => void);

      zipFile.readEntry();
    });
  });
}

export default { detectOoxmlKind };
