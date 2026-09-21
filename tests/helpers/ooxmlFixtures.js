/**
 * Генераторы документов OOXML для тестов.
 *
 * Собираются кодом, а не хранятся в репозитории: нужны книги с разным числом
 * листов и документы с разным числом страниц, а бинарные фикстуры в git
 * невозможно просмотреть и трудно менять. Архив собирается в памяти через
 * yazl — на диск ничего не пишется.
 */

import yazl from 'yazl';

/**
 * Собирает zip-архив из набора записей.
 *
 * @param entries - пары «имя записи, содержимое»
 * @returns буфер архива
 */
async function buildZip(entries) {
  const zip = new yazl.ZipFile();

  for (const [name, content] of entries) {
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), name);
  }

  zip.end();

  const chunks = [];

  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/** Типы содержимого пакета книги. */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${''}
</Types>`;

/** Корневые связи пакета книги. */
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/** Типы содержимого пакета текстового документа. */
const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${''}
</Types>`;

/** Корневые связи пакета текстового документа. */
const ROOT_RELS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * Описание книги: листы и их связи.
 *
 * @param sheetCount - число листов
 * @returns содержимое workbook.xml и его связей
 */
function buildWorkbook(sheetCount) {
  const sheets = [];
  const rels = [];

  for (let i = 1; i <= sheetCount; i += 1) {
    sheets.push(`<sheet name="Sheet${i}" sheetId="${i}" r:id="rId${i}"/>`);
    rels.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
    );
  }

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('')}
</Relationships>`;

  return { workbook, workbookRels };
}

/**
 * Собирает минимальный, но валидный по структуре XLSX.
 *
 * @param options - параметры книги
 * @param options.sheets - число листов
 * @param options.rows - число строк на листе
 * @returns буфер архива
 */
export async function buildXlsx({ sheets = 1, rows = 5 } = {}) {
  const { workbook, workbookRels } = buildWorkbook(sheets);

  const entries = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
  ];

  for (let i = 1; i <= sheets; i += 1) {
    const cells = [];

    for (let row = 1; row <= rows; row += 1) {
      cells.push(
        `<row r="${row}"><c r="A${row}" t="n"><v>${row}</v></c><c r="B${row}" t="inlineStr"><is><t>строка ${row}</t></is></c></row>`
      );
    }

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${cells.join('')}</sheetData>
</worksheet>`;

    entries.push([`xl/worksheets/sheet${i}.xml`, sheet]);
  }

  return buildZip(entries);
}

/**
 * Собирает минимальный, но валидный по структуре DOCX.
 *
 * @param options - параметры документа
 * @param options.pages - число страниц в свойствах документа
 * @param options.paragraphs - число абзацев в теле
 * @param options.withAppXml - добавлять ли `docProps/app.xml` с числом страниц
 * @param options.withMacros - добавлять ли проект VBA (макросы)
 * @returns буфер архива
 */
export async function buildDocx({
  pages = 1,
  paragraphs = 5,
  withAppXml = true,
  withMacros = false,
} = {}) {
  const body = [];

  for (let i = 1; i <= paragraphs; i += 1) {
    body.push(`<w:p><w:r><w:t>Абзац ${i}</w:t></w:r></w:p>`);
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body.join('')}</w:body>
</w:document>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Pages>${pages}</Pages>
</Properties>`;

  const entries = [
    ['[Content_Types].xml', CONTENT_TYPES_DOCX],
    ['_rels/.rels', ROOT_RELS_DOCX],
    ['word/document.xml', document],
  ];

  if (withAppXml) {
    entries.push(['docProps/app.xml', appXml]);
  }

  if (withMacros) {
    entries.push(['word/vbaProject.bin', Buffer.alloc(64, 0)]);
  }

  return buildZip(entries);
}

/**
 * Собирает zip-архив, который не является документом OOXML.
 *
 * @returns буфер архива
 */
export async function buildPlainZip() {
  return buildZip([['notes.txt', 'просто файл']]);
}

/**
 * Собирает zip-бомбу: крошечный архив с огромной распакованной записью.
 *
 * @param sizeBytes - размер распакованных данных
 * @param name - имя записи внутри архива
 * @returns буфер архива
 */
export async function buildZipBomb(sizeBytes = 200 * 1024 * 1024, name = 'xl/worksheets/sheet1.xml') {
  return buildZip([[name, Buffer.alloc(sizeBytes, 0x41)]]);
}

/**
 * Собирает архив с недостоверным central directory.
 *
 * В отличие от `buildZipBomb`, которая объявляет большой распакованный размер
 * честно (и потому ловится проверкой коэффициента сжатия), здесь заявленный
 * размер подменяется на сжатый. По метаданным запись выглядит безобидно —
 * коэффициент сжатия 1, размеры в пределах лимитов, — а в deflate-потоке
 * лежат данные, разворачивающиеся в сотни раз. Проверка, доверяющая central
 * directory, такой архив пропускает.
 *
 * @param sizeBytes - фактический размер распакованных данных
 * @param name - имя записи внутри архива
 * @returns буфер архива
 */
export async function buildLyingZipBomb(sizeBytes = 4 * 1024 * 1024, name = 'xl/worksheets/sheet1.xml') {
  // Нули сжимаются почти бесплатно: реальный коэффициент получается огромным,
  // а заявленный мы подделаем
  const buffer = await buildZip([[name, Buffer.alloc(sizeBytes, 0)]]);

  patchCentralDirectorySizes(buffer);

  return buffer;
}

/** Сигнатура записи central directory. */
const CD_SIGNATURE = 0x02014b50;

/** Сигнатура конца central directory. */
const EOCD_SIGNATURE = 0x06054b50;

/** Смещение поля «распакованный размер» внутри записи central directory. */
const CD_UNCOMPRESSED_SIZE_OFFSET = 24;

/** Смещение поля «сжатый размер» внутри записи central directory. */
const CD_COMPRESSED_SIZE_OFFSET = 20;

/**
 * Подменяет в central directory распакованный размер на сжатый.
 *
 * Правка идёт от записи End of central directory: поиск сигнатуры по всему
 * буферу дал бы ложные срабатывания внутри сжатых данных.
 *
 * @param buffer - буфер архива (правится на месте)
 */
function patchCentralDirectorySizes(buffer) {
  let eocd = -1;

  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) {
    throw new Error('Не найден конец central directory — фикстура собрана неверно');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CD_SIGNATURE) {
      throw new Error(`Запись central directory ${i} не найдена по ожидаемому смещению`);
    }

    const compressed = buffer.readUInt32LE(cursor + CD_COMPRESSED_SIZE_OFFSET);
    buffer.writeUInt32LE(compressed, cursor + CD_UNCOMPRESSED_SIZE_OFFSET);

    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

export default { buildXlsx, buildDocx, buildPlainZip, buildZipBomb, buildLyingZipBomb };
