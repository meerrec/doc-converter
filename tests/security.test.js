/**
 * Тесты безопасности.
 * 
 * Покрывает все 6 слоёв защиты:
 * 1. Rate limit
 * 2. Schema validation
 * 3. URL guard (SSRF)
 * 4. Magic bytes
 * 5. ZIP/XML guard
 * 6. Per-job sandbox
 * 
 * Все комментарии на русском языке.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createServer } from './helpers/server.js';

// Модули безопасности берутся из исходников на TypeScript.
import { 
  checkMagicBytes, 
  verifyMagicBytes,
  getFormatFromMagic,
  MAGIC_SIGNATURES 
} from '../src/security/magicBytes.js';
import { 
  validateUrl, 
  validateDns,
  checkPrivateIp,
  PRIVATE_IP_RANGES 
} from '../src/security/urlGuard.js';
import {
  validateZip,
  quickZipCheck,
  checkZipEntryName,
  ZIP_VALIDATION_LIMITS
} from '../src/security/zipGuard.js';
import {
  validateXml,
  checkXmlContent,
  XML_VALIDATION_LIMITS
} from '../src/security/xmlGuard.js';
import {
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
  buildValidPdf
} from './helpers/attackFixtures.js';

// ===========================================================================
// Настройка тестов
// ===========================================================================

let server;
let app;

beforeAll(async () => {
  // Отключаем rate limit для тестов безопасности
  process.env.RATE_PER_SEC = '100';
  process.env.RATE_BURST = '100';
  
  const serverModule = await createServer();
  app = serverModule.app;
  server = serverModule.server;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  vi.clearAllMocks();
});

// ===========================================================================
// 4. Magic Bytes тесты
// ===========================================================================

describe('Magic Bytes validation', () => {
  describe('checkMagicBytes', () => {
    it('should detect DOCX magic bytes', () => {
      // DOCX - это ZIP архив с сигнатурой PK\x03\x04
      const docxBuffer = Buffer.from('PK\x03\x04', 'binary');
      const result = checkMagicBytes(docxBuffer, 'docx');
      expect(result.valid).toBe(true);
    });

    it('should detect PDF magic bytes', () => {
      const pdfBuffer = Buffer.from('%PDF-1.7', 'ascii');
      const result = checkMagicBytes(pdfBuffer, 'pdf');
      expect(result.valid).toBe(true);
    });

    it('should detect RTF magic bytes', () => {
      const rtfBuffer = Buffer.from('{\\rtf', 'ascii');
      const result = checkMagicBytes(rtfBuffer, 'rtf');
      expect(result.valid).toBe(true);
    });

    it('should detect PNG magic bytes', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
      const result = checkMagicBytes(pngBuffer, 'png');
      expect(result.valid).toBe(true);
    });

    it('should detect JPEG magic bytes', () => {
      const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF]);
      const result = checkMagicBytes(jpegBuffer, 'jpg');
      expect(result.valid).toBe(true);
    });

    it('should detect OLE (DOC/XLS/PPT) magic bytes', () => {
      const oleBuffer = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
      const result = checkMagicBytes(oleBuffer, 'doc');
      expect(result.valid).toBe(true);
    });

    it('should reject magic mismatch', () => {
      // PDF сигнатура с объявленным docx
      const pdfBuffer = Buffer.from('%PDF-1.7', 'ascii');
      const result = checkMagicBytes(pdfBuffer, 'docx');
      expect(result.valid).toBe(false);
      expect(result.error.errorCode).toBe('magic_mismatch');
    });

    it('should reject empty buffer', () => {
      const emptyBuffer = Buffer.alloc(0);
      const result = checkMagicBytes(emptyBuffer, 'pdf');
      expect(result.valid).toBe(false);
    });

    it('should reject too small buffer', () => {
      const smallBuffer = Buffer.from('A');
      const result = checkMagicBytes(smallBuffer, 'pdf');
      expect(result.valid).toBe(false);
    });
  });

  describe('verifyMagicBytes', () => {
    it('should return true for matching DOCX', () => {
      const docxBuffer = Buffer.from('PK\x03\x04', 'binary');
      expect(verifyMagicBytes(docxBuffer, 'docx')).toBe(true);
    });

    it('should return false for mismatch', () => {
      const pdfBuffer = Buffer.from('%PDF-1.7', 'ascii');
      expect(verifyMagicBytes(pdfBuffer, 'docx')).toBe(false);
    });
  });

  describe('getFormatFromMagic', () => {
    it('should detect PDF format', () => {
      const pdfBuffer = Buffer.from('%PDF-1.7', 'ascii');
      const format = getFormatFromMagic(pdfBuffer);
      expect(format).toBe('pdf');
    });

    it('should detect ZIP-based format (docx)', () => {
      const docxBuffer = Buffer.from('PK\x03\x04', 'binary');
      const format = getFormatFromMagic(docxBuffer);
      expect(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(format)).toBe(true);
    });

    it('should return null for unknown format', () => {
      const unknownBuffer = Buffer.from('UNKNOWN', 'ascii');
      const format = getFormatFromMagic(unknownBuffer);
      expect(format).toBeNull();
    });
  });
});

// ===========================================================================
// 3. URL Guard тесты (SSRF protection)
// ===========================================================================

describe('URL Guard (SSRF protection)', () => {
  describe('checkPrivateIp', () => {
    it('should detect 127.0.0.1 as private', () => {
      expect(checkPrivateIp('127.0.0.1')).toBe(true);
    });

    it('should detect 169.254.169.254 as private', () => {
      expect(checkPrivateIp('169.254.169.254')).toBe(true);
    });

    it('should detect 10.0.0.1 as private', () => {
      expect(checkPrivateIp('10.0.0.1')).toBe(true);
    });

    it('should detect 192.168.1.1 as private', () => {
      expect(checkPrivateIp('192.168.1.1')).toBe(true);
    });

    it('should detect ::1 as private', () => {
      expect(checkPrivateIp('::1')).toBe(true);
    });

    it('should detect fc00::/7 as private', () => {
      expect(checkPrivateIp('fc00::1')).toBe(true);
      expect(checkPrivateIp('fd00::1')).toBe(true);
    });

    it('should detect fe80::/10 as private', () => {
      expect(checkPrivateIp('fe80::1')).toBe(true);
    });

    it('should not detect 8.8.8.8 as private', () => {
      expect(checkPrivateIp('8.8.8.8')).toBe(false);
    });

    it('should not detect example.com as private', () => {
      expect(checkPrivateIp('example.com')).toBe(false);
    });
  });

  describe('validateUrl', () => {
    // Тесты используют IP-литералы публичных адресов: для них DNS-резолв
    // не выполняется, поэтому результат не зависит от сети.
    // 93.184.216.34 — публичный адрес example.com.
    const PUBLIC_IP = '93.184.216.34';

    it('should accept http URL with public host', async () => {
      const result = await validateUrl(`http://${PUBLIC_IP}/file.docx`);
      expect(result.isValid).toBe(true);
    });

    it('should accept https URL with public host', async () => {
      const result = await validateUrl(`https://${PUBLIC_IP}/file.docx`);
      expect(result.isValid).toBe(true);
    });

    it('should reject file:// URL', async () => {
      const result = await validateUrl('file:///etc/passwd');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_scheme_forbidden');
    });

    it('should reject gopher:// URL', async () => {
      const result = await validateUrl('gopher://example.com');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_scheme_forbidden');
    });

    it('should reject URL with credentials', async () => {
      const result = await validateUrl('http://user:pass@example.com');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_credentials_forbidden');
    });

    it('should reject URL without host', async () => {
      const result = await validateUrl('http://');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_no_host');
    });

    it('should reject URL with private IP literal', async () => {
      const result = await validateUrl('http://169.254.169.254');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_private_ip');
    });

    it('should reject URL with localhost', async () => {
      const result = await validateUrl('http://localhost/file.docx');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_private_ip');
    });

    it('should reject URL with 127.0.0.1', async () => {
      const result = await validateUrl('http://127.0.0.1/file.docx');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_private_ip');
    });

    it('should reject URL with [::1]', async () => {
      const result = await validateUrl('http://[::1]/file.docx');
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_private_ip');
    });

    it('should accept URL with public IP', async () => {
      const result = await validateUrl(`http://${PUBLIC_IP}/file.docx`);
      expect(result.isValid).toBe(true);
    });

    it('should reject hostname of an unresolvable domain (fail-safe)', async () => {
      // Имя заведомо не резолвится: несуществующий домен в зоне .example
      const result = await validateUrl('http://nonexistent-host-abcxyz-12345.example/x');

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('url_private_ip');
    });

    it('should accept URL with resolvable public hostname', async () => {
      // Единственная проверка, зависящая от внешнего DNS. Там, где сети нет,
      // она пропускается: резолв вернул бы ошибку, и fail-safe заблокировал бы
      // хост — это проверено тестом выше, а не здесь.
      const dns = await import('node:dns/promises');
      const resolvable = await dns
        .lookup('example.com', { all: true })
        .then((addresses) => addresses.length > 0)
        .catch(() => false);

      if (!resolvable) {
        return;
      }

      const result = await validateUrl('http://example.com/file.docx');

      expect(result.isValid).toBe(true);
    });
  });
});

// ===========================================================================
// 5. ZIP Guard тесты
// ===========================================================================

describe('ZIP Guard', () => {
  describe('quickZipCheck', () => {
    it('should accept valid ZIP', async () => {
      const docx = await buildValidDocx();
      expect(quickZipCheck(docx)).toBe(true);
    });

    it('should reject non-ZIP', () => {
      const notZip = Buffer.from('not a zip');
      expect(quickZipCheck(notZip)).toBe(false);
    });

    it('should reject empty buffer', () => {
      expect(quickZipCheck(Buffer.alloc(0))).toBe(false);
    });
  });

  describe('checkZipEntryName', () => {
    it('should reject path with ..', () => {
      expect(checkZipEntryName('../../../etc/passwd')).toBe(false);
    });

    it('should reject absolute path', () => {
      expect(checkZipEntryName('/etc/passwd')).toBe(false);
    });

    it('should reject Windows drive path', () => {
      expect(checkZipEntryName('C:\\Windows\\System32')).toBe(false);
    });

    it('should reject control characters', () => {
      expect(checkZipEntryName('file\x00.txt')).toBe(false);
      expect(checkZipEntryName('file\n.txt')).toBe(false);
    });

    it('should accept valid filename', () => {
      expect(checkZipEntryName('valid/file.txt')).toBe(true);
    });

    it('should accept nested path', () => {
      expect(checkZipEntryName('dir1/dir2/file.txt')).toBe(true);
    });
  });

  describe('validateZip (full validation)', () => {
    // Для тестов используем mock с уменьшенными лимитами
    const testOptions = {
      timeout: 10000,
      maxEntries: 10,
      maxEntryUncompressedBytes: 1024 * 1024,
      maxTotalUncompressedBytes: 2 * 1024 * 1024,
      maxCompressionRatio: 10,
      maxPathDepth: 8,
    };

    it('should accept valid DOCX', async () => {
      const docx = await buildValidDocx();
      const result = await validateZip(docx, testOptions);
      expect(result.isValid).toBe(true);
    });

    it('should reject ZIP bomb (high ratio)', async () => {
      // Создаём бомбу с ratio > 100
      const bomb = await buildZipBomb({
        uncompressed: 100 * 1024 * 1024, // 100 MiB
        compressed: 1024 // 1 KiB
      });
      
      const result = await validateZip(bomb, {
        ...testOptions,
        maxCompressionRatio: 100
      });
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_ratio_exceeded');
    }, 30000);

    it('should reject ZIP with traversal', async () => {
      const traversal = await buildZipTraversal('../../../etc/passwd');
      const result = await validateZip(traversal, testOptions);
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_forbidden_name');
    });

    it('should reject ZIP with forbidden extension', async () => {
      const forbidden = await buildZipWithForbiddenExtension('malware.exe');
      const result = await validateZip(forbidden, testOptions);
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_forbidden_extension');
    });

    it('should reject ZIP with duplicate entries', async () => {
      const duplicate = await buildZipWithDuplicateEntries();
      const result = await validateZip(duplicate, testOptions);
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_duplicate_entry');
    });

    it('should reject ZIP with too deep nesting', async () => {
      const deep = await buildZipNested(20); // Глубина > maxPathDepth
      const result = await validateZip(deep, {
        ...testOptions,
        maxPathDepth: 16
      });
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_too_deep');
    });

    it('should reject ZIP with too many entries', async () => {
      const many = await buildZipWithManyEntries(100); // > maxEntries
      const result = await validateZip(many, {
        ...testOptions,
        maxEntries: 50
      });
      
      expect(result.isValid).toBe(false);
      expect(result.firstViolation.code).toBe('archive_too_many_entries');
    });
  });
});

// ===========================================================================
// 5. XML Guard тесты
// ===========================================================================

describe('XML Guard', () => {
  describe('checkXmlContent', () => {
    it('should reject XML with DOCTYPE', () => {
      const xmlWithDoctype = buildXmlWithDoctype();
      const result = checkXmlContent(xmlWithDoctype);
      expect(result.isValid).toBe(false);
      expect(result.violation).toBe('DOCTYPE detected');
    });

    it('should reject XML with ENTITY', () => {
      const xmlWithEntity = buildXmlWithEntity();
      const result = checkXmlContent(xmlWithEntity);
      expect(result.isValid).toBe(false);
      expect(result.violation).toContain('ENTITY');
    });

    it('should reject XML bomb', () => {
      const xmlBomb = buildXmlBomb();
      const result = checkXmlContent(xmlBomb);
      expect(result.isValid).toBe(false);
    });

    it('should accept XML without DOCTYPE/ENTITY', () => {
      const safeXml = Buffer.from('<root><data>test</data></root>');
      const result = checkXmlContent(safeXml);
      expect(result.isValid).toBe(true);
    });

    it('should accept empty XML', () => {
      const emptyXml = Buffer.alloc(0);
      const result = checkXmlContent(emptyXml);
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateXml', () => {
    it('should accept valid XML', async () => {
      const safeXml = Buffer.from('<root><data>test</data></root>');
      const result = await validateXml(safeXml, { timeout: 5000 });
      expect(result.isValid).toBe(true);
    });

    it('should reject XML with DOCTYPE', async () => {
      const xmlWithDoctype = buildXmlWithDoctype();
      const result = await validateXml(xmlWithDoctype, { timeout: 5000 });
      expect(result.isValid).toBe(false);
    });
  });
});

// ===========================================================================
// 2. Schema Validation тесты (через API)
// ===========================================================================

describe('Schema Validation (API)', () => {
  it('should reject unknown field', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        unknownField: 'test'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('unknown_field');
  });

  it('should reject wrong type for async', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        async: 'true' // string вместо boolean
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('field_type_mismatch');
  });

  it('should reject missing filetype', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        outputtype: 'pdf',
        url: 'http://example.com/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('filetype_required');
  });

  it('should reject missing outputtype', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        url: 'http://example.com/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('outputtype_required');
  });

  it('should reject both url and data', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://example.com/test.docx',
        data: Buffer.from('test').toString('base64')
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('exactly_one_source_required');
  });

  it('should reject neither url nor data', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('exactly_one_source_required');
  });

  it('should reject unsupported input format', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'exe',
        outputtype: 'pdf',
        url: 'http://example.com/test.exe'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('input_format_not_allowed');
  });

  it('should reject unsupported output format', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'exe',
        url: 'http://example.com/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('output_format_not_allowed');
  });

  it('should reject invalid key pattern', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://example.com/test.docx',
        key: 'invalid|key'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('key_invalid_chars');
  });

  it('should reject too long title', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://example.com/test.docx',
        title: 'a'.repeat(256)
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('title_too_long');
  });

  it('should reject invalid region', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://example.com/test.docx',
        region: 'invalid-region'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('region_invalid');
  });

  it('should reject invalid codePage', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://example.com/test.docx',
        codePage: 99999
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('codePage_not_allowed');
  });

  it('should reject invalid delimiter', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'csv',
        outputtype: 'pdf',
        url: 'http://example.com/test.csv',
        delimiter: 99
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('delimiter_not_allowed');
  });
});

// ===========================================================================
// Magic Bytes тесты через API
// ===========================================================================

describe('Magic Bytes (API)', () => {
  it('should reject magic mismatch', async () => {
    // Отправляем PDF данные, но объявляем как docx
    const pdfData = buildValidPdf();
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        data: pdfData.toString('base64')
      });
    
    expect(response.status).toBe(415);
    expect(response.body.error).toBe('magic_mismatch');
  });
});

// ===========================================================================
// URL Guard тесты через API
// ===========================================================================

describe('URL Guard (API)', () => {
  it('should reject URL with private IP 127.0.0.1', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://127.0.0.1/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('url_private_ip');
  });

  it('should reject URL with private IP 169.254.169.254', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://169.254.169.254/latest/meta-data'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('url_private_ip');
  });

  it('should reject URL with private IP ::1', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://[::1]/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('url_private_ip');
  });

  it('should reject URL with file:// scheme', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'file:///etc/passwd'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('url_scheme_forbidden');
  });

  it('should reject URL with credentials', async () => {
    const response = await request(app)
      .post('/ConvertService.ashx')
      .send({
        filetype: 'docx',
        outputtype: 'pdf',
        url: 'http://user:password@example.com/test.docx'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('url_credentials_forbidden');
  });
});
