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
  const zip = new yazl.ZipFile();

  // Нули сжимаются почти бесплатно: реальный коэффициент получается огромным,
  // а заявленный мы подделаем
  zip.addBuffer(Buffer.alloc(sizeBytes, 0), name);
  zip.end();

  const chunks = [];

  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

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

export default { buildXlsx, buildZipBomb, buildLyingZipBomb };
