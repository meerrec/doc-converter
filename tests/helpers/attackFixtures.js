/**
 * Генераторы тестовых фикстур для проверки защиты от атак.
 * 
 * Использует yazl для создания ZIP-бомб и других-dangerous архивов
 * без распаковки на диск.
 * 
 * Все комментарии на русском языке.
 */

import yazl from 'yazl';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';

// ===========================================================================
// ZIP-бомба: высокий коэффициент сжатия
// ===========================================================================

/**
 * Создаёт ZIP-бомбу с заданными параметрами.
 * 
 * @param {Object} options - опции
 * @param {number} [options.uncompressed=100*1024*1024] - размер нессжатых данных в байтах
 * @param {number} [options.compressed=1024] - размер сжатых данных в байтах
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipBomb({ 
  uncompressed = 100 * 1024 * 1024, 
  compressed = 1024 
} = {}) {
  // Создаём поток для ZIP
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Генерируем большой файл с высокой степенью сжатия
  // «A» повторяется много раз и хорошо сжимается
  const bigContent = 'A'.repeat(uncompressed);
  
  // Добавляем файл в архив
  zip.addBuffer(Buffer.from(bigContent), 'bomb.txt');
  
  // Закрываем архив
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  // Ждём завершения и возвращаем буфер
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

// ===========================================================================
// ZIP Traversal: попытка выхода за пределы директории
// ===========================================================================

/**
 * Заменяет все вхождения одной последовательности байт на другую.
 *
 * Длины должны совпадать — иначе поедет структура ZIP-архива.
 *
 * @param {Buffer} buffer - исходный буфер
 * @param {Buffer} from - что искать
 * @param {Buffer} to - на что заменить
 * @returns {Buffer} - новый буфер
 */
function replaceBytes(buffer, from, to) {
  if (from.length !== to.length) {
    throw new Error('replaceBytes: длины искомой и заменяющей строк должны совпадать');
  }

  const result = Buffer.from(buffer);
  let index = result.indexOf(from);

  while (index !== -1) {
    to.copy(result, index);
    index = result.indexOf(from, index + to.length);
  }

  return result;
}

/**
 * Создаёт ZIP-архив с записью, содержащей path traversal.
 *
 * yazl запрещает записывать имена с '..', поэтому архив собирается
 * с безопасным именем-заполнителем той же длины, а затем байты имени
 * подменяются на опасный путь прямо в готовом буфере.
 *
 * @param {string} path - путь с traversal (например, '../../../etc/passwd')
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipTraversal(path) {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();

  // Заполнитель той же длины, что и опасный путь
  const placeholder = 'a'.repeat(Buffer.byteLength(path, 'utf8'));

  zip.addBuffer(Buffer.from('test'), placeholder);

  zip.outputStream.pipe(zipStream);
  zip.end();

  const archive = await new Promise((resolve, reject) => {
    const chunks = [];

    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });

    zipStream.on('error', (err) => {
      reject(err);
    });
  });

  return replaceBytes(
    archive,
    Buffer.from(placeholder, 'utf8'),
    Buffer.from(path, 'utf8')
  );
}

// ===========================================================================
// ZIP с深окой вложенностью
// ===========================================================================

/**
 * Создаёт ZIP-архив с глубоко вложенными директориями.
 * 
 * @param {number} depth - глубина вложенности
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipNested(depth) {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Создаём путь с заданной глубиной
  const pathParts = [];
  for (let i = 0; i < depth; i++) {
    pathParts.push(`dir${i}`);
  }
  const deepPath = `${pathParts.join('/')}/file.txt`;
  
  // Добавляем файл в глубокую директорию
  zip.addBuffer(Buffer.from('deep content'), deepPath);
  
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

// ===========================================================================
// ZIP с запрещёнными расширениями
// ===========================================================================

/**
 * Создаёт ZIP-архив с файлом, имеющим запрещённое расширение.
 * 
 * @param {string} filename - имя файла с запрещённым расширением
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipWithForbiddenExtension(filename) {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Добавляем файл с запрещённым расширением
  zip.addBuffer(Buffer.from('malicious code'), filename);
  
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

// ===========================================================================
// ZIP с дубликатами имён записей
// ===========================================================================

/**
 * Создаёт ZIP-архив с дублирующимися именами записей.
 * 
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipWithDuplicateEntries() {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Добавляем два файла с одинаковым именем
  zip.addBuffer(Buffer.from('content1'), 'duplicate.txt');
  zip.addBuffer(Buffer.from('content2'), 'duplicate.txt');
  
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

// ===========================================================================
// ZIP с большим количеством записей
// ===========================================================================

/**
 * Создаёт ZIP-архив с большим количеством записей.
 * 
 * @param {number} entryCount - количество записей
 * @returns {Promise<Buffer>} - ZIP-архив
 */
export async function buildZipWithManyEntries(entryCount) {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Добавляем много файлов
  for (let i = 0; i < entryCount; i++) {
    zip.addBuffer(Buffer.from(`content${i}`), `file${i}.txt`);
  }
  
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

// ===========================================================================
// XML-бомба: DOCTYPE с внешними entity
// ===========================================================================

/**
 * Создаёт XML с DOCTYPE и внешними entity.
 * 
 * @returns {Buffer} - XML-контент
 */
export function buildXmlBomb() {
  // XML с DOCTYPE - признак XXE атаки
  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE root [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY internal "test" >
]>
<root>
  <data>&xxe;</data>
  <data>&internal;</data>
</root>`;
  
  return Buffer.from(xmlContent, 'utf8');
}

/**
 * Создаёт XML с простым DOCTYPE.
 * 
 * @returns {Buffer} - XML-контент
 */
export function buildXmlWithDoctype() {
  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html>
  <body>Test</body>
</html>`;
  
  return Buffer.from(xmlContent, 'utf8');
}

/**
 * Создаёт XML с ENTITY.
 * 
 * @returns {Buffer} - XML-контент
 */
export function buildXmlWithEntity() {
  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <!ENTITY internal "test">
  <data>&internal;</data>
</root>`;
  
  return Buffer.from(xmlContent, 'utf8');
}

// ===========================================================================
// Простые фикстуры для тестирования
// ===========================================================================

/**
 * Создаёт валидный DOCX файл (минимальная структура).
 * 
 * @returns {Promise<Buffer>} - DOCX-архив
 */
export async function buildValidDocx() {
  const zipStream = new PassThrough();
  const zip = new yazl.ZipFile();
  
  // Минимальная структура DOCX
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`;
  
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
  
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>Hello World</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;
  
  // Добавляем файлы DOCX структуры
  zip.addBuffer(Buffer.from(contentTypes), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(relationships), '_rels/.rels');
  zip.addBuffer(Buffer.from(document), 'word/document.xml');
  
  zip.outputStream.pipe(zipStream);
  zip.end();
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    zipStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    zipStream.on('end', () => {
      const result = Buffer.concat(chunks);
      resolve(result);
    });
    
    zipStream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Создаёт валидный TXT файл.
 * 
 * @returns {Buffer} - текст
 */
export function buildValidTxt() {
  return Buffer.from('Hello World from text file', 'utf8');
}

/**
 * Создаёт валидный PDF файл (минимальный).
 * 
 * @returns {Buffer} - PDF
 */
export function buildValidPdf() {
  // Минимальный валидный PDF
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'utf8');
}

export default {
  buildZipBomb,
  buildZipTraversal,
  buildZipNested,
  buildZipWithForbiddenExtension,
  buildZipWithDuplicateEntries,
  buildZipWithManyEntries,
  buildXmlBomb,
  buildXmlWithDoctype,
  buildXmlWithEntity,
  buildValidDocx,
  buildValidTxt,
  buildValidPdf,
};
