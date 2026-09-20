/**
 * Генераторы XLSX-файлов для тестов.
 *
 * Собираются кодом, а не хранятся в репозитории: нужны книги с разным числом
 * листов, а бинарные фикстуры в git невозможно просмотреть и трудно менять.
 * Архив собирается в памяти через yazl — на диск ничего не пишется.
 */

import yazl from 'yazl';

/** Типы содержимого пакета. */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${''}
</Types>`;

/** Корневые связи пакета. */
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
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
  const zip = new yazl.ZipFile();
  const { workbook, workbookRels } = buildWorkbook(sheets);

  zip.addBuffer(Buffer.from(CONTENT_TYPES, 'utf8'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(ROOT_RELS, 'utf8'), '_rels/.rels');
  zip.addBuffer(Buffer.from(workbook, 'utf8'), 'xl/workbook.xml');
  zip.addBuffer(Buffer.from(workbookRels, 'utf8'), 'xl/_rels/workbook.xml.rels');

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

    zip.addBuffer(Buffer.from(sheet, 'utf8'), `xl/worksheets/sheet${i}.xml`);
  }

  zip.end();

  const chunks = [];

  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Собирает zip-бомбу: крошечный архив с огромной распакованной записью.
 *
 * @param sizeBytes - размер распакованных данных
 * @param name - имя записи внутри архива
 * @returns буфер архива
 */
export async function buildZipBomb(sizeBytes = 200 * 1024 * 1024, name = 'xl/worksheets/sheet1.xml') {
  const zip = new yazl.ZipFile();

  zip.addBuffer(Buffer.alloc(sizeBytes, 0x41), name);
  zip.end();

  const chunks = [];

  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export default { buildXlsx, buildZipBomb };
