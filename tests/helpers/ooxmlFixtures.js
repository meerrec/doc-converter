/**
 * Генераторы документов OOXML для тестов.
 *
 * Собираются кодом, а не хранятся в репозитории: нужны книги с разным числом
 * листов и документы с разным числом страниц, а бинарные фикстуры в git
 * невозможно просмотреть и трудно менять. Архив собирается в памяти через
 * yazl — на диск ничего не пишется.
 */

import { deflateSync } from 'node:zlib';
import yazl from 'yazl';

/** Таблица CRC32: её требует каждый блок PNG. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

/**
 * Считает CRC32 блока PNG.
 *
 * @param bytes - байты блока
 * @returns контрольная сумма
 */
function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Собирает блок PNG: длина, тип, данные, контрольная сумма.
 *
 * @param type - тип блока
 * @param data - данные блока
 * @returns байты блока
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/**
 * Собирает настоящий PNG с заливкой — картинку для фикстур.
 *
 * Кодировщик написан здесь, а не взят из зависимости: тесты не должны
 * тянуть пакет движка ради одного изображения, а формат в этой части прост —
 * заголовок, один блок данных и конец файла.
 *
 * @param options - размеры и цвет заливки
 * @param options.width - ширина в пикселях
 * @param options.height - высота в пикселях
 * @param options.color - цвет заливки, по умолчанию синий
 * @returns байты PNG
 */
export function buildPng({ width = 4, height = 4, color = [0, 0, 255] } = {}) {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // truecolor: RGB без прозрачности
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    // Первый байт строки — фильтр: 0 означает «без фильтрации»
    const row = Buffer.alloc(1 + width * 3);

    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = color[0];
      row[2 + x * 3] = color[1];
      row[3 + x * 3] = color[2];
    }

    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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
 * Экранирует текст для XML.
 *
 * @param text - исходная строка
 * @returns строка с заменёнными спецсимволами
 */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Собирает книгу с картинкой на листе.
 *
 * Картинка нужна там, где проверяется её встраивание: печатный display list
 * изображений не содержит, и в PDF они попадают отдельным путём — через
 * объекты листа и часть `xl/media`. Фикстура повторяет ту же структуру,
 * что делает Excel: лист ссылается на drawing, drawing — на медиа.
 *
 * @param options - параметры книги
 * @param options.rows - число строк на листе
 * @returns буфер архива
 */
export async function buildXlsxWithPicture({ rows = 3 } = {}) {
  const { workbook, workbookRels } = buildWorkbook(1);
  const cells = [];

  for (let row = 1; row <= rows; row += 1) {
    cells.push(
      `<row r="${row}"><c r="A${row}" t="n"><v>${row}</v></c><c r="B${row}" t="inlineStr"><is><t>строка ${row}</t></is></c></row>`
    );
  }

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>${cells.join('')}</sheetData>
  <drawing r:id="rId1"/>
</worksheet>`;

  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

  // Якорь на две ячейки: картинка растянута от B1 до D4
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="1" name="Картинка 1"/>
        <xdr:cNvPicPr/>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;

  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`;

  return buildZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/worksheets/_rels/sheet1.xml.rels', sheetRels],
    ['xl/drawings/drawing1.xml', drawing],
    ['xl/drawings/_rels/drawing1.xml.rels', drawingRels],
    ['xl/media/image1.png', buildPng()],
  ]);
}

/**
 * Собирает минимальный, но валидный по структуре DOCX.
 *
 * @param options - параметры документа
 * @param options.pages - число страниц в свойствах документа
 * @param options.paragraphs - число абзацев в теле
 * @param options.lines - тексты абзацев; заданы — вместо «Абзац N»
 * @param options.withAppXml - добавлять ли `docProps/app.xml` с числом страниц
 * @param options.withMacros - добавлять ли проект VBA (макросы)
 * @returns буфер архива
 */
export async function buildDocx({
  pages = 1,
  paragraphs = 5,
  lines = null,
  withAppXml = true,
  withMacros = false,
} = {}) {
  const body = [];

  if (lines !== null) {
    for (const line of lines) {
      body.push(`<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`);
    }
  } else {
    for (let i = 1; i <= paragraphs; i += 1) {
      body.push(`<w:p><w:r><w:t>Абзац ${i}</w:t></w:r></w:p>`);
    }
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
