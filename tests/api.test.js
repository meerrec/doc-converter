/**
 * Проверки маршрутов конвертации.
 *
 * Тесты намеренно не доходят до объектного хранилища и очереди: проверяется
 * то, что сервис обязан отсеять до обращения к инфраструктуре — пустой
 * запрос, подмену формата, некорректные параметры, неверный идентификатор
 * задачи. Так набор проходит без Redis и MinIO, а поведение при живом
 * хранилище проверяется отдельно, интеграционным прогоном.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildXlsx, buildDocx, buildPlainZip, buildZipBomb } from './helpers/ooxmlFixtures.js';

// Окружение задаётся до импорта модулей: config читает его при загрузке
process.env.PORT = '3212';
process.env.HOST = '127.0.0.1';
process.env.RATE_PER_SEC = '100';
process.env.RATE_BURST = '200';
process.env.S3_ENDPOINT = '127.0.0.1';
process.env.S3_PORT = '1';

// Хелпер выставляет API_PORT/PORT в 0 («любой свободный»), поэтому наборы
// тестов, идущие параллельно, не конфликтуют за порт
const { createServer } = await import('./helpers/server.js');

let app;
let server;
let nest;

beforeAll(async () => {
  const created = await createServer();

  app = created.app;
  server = created.server;
  nest = created.nest;
});

afterAll(async () => {
  if (nest) {
    await nest.close();
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('POST /convert/to-pdf: обязательный файл', () => {
  it('без файла отвечает 400 file_required', async () => {
    const response = await request(app).post('/convert/to-pdf').field('watermark', 'тест');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('file_required');
  });
});

describe('POST /convert/to-pdf: параметры', () => {
  it('некорректное число в параметре отвечает 400', async () => {
    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', Buffer.from('не таблица'), 'report.xlsx')
      .field('quality', '999');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_option_value');
    // Сообщение перечисляет конкретное поле — иначе клиенту неясно,
    // что именно править
    expect(response.body.message).toContain('quality');
  });

  it('неизвестная версия PDF отвечает 400', async () => {
    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', Buffer.from('не таблица'), 'report.xlsx')
      .field('pdfVersion', '2.0');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_option_value');
  });

  it('слишком длинный водяной знак отвечает 400', async () => {
    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', Buffer.from('не таблица'), 'report.xlsx')
      .field('watermark', 'я'.repeat(300));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_option_value');
  });
});

describe('POST /convert/to-pdf: содержимое файла', () => {
  it('текст с расширением .xlsx отвечает 415 magic_mismatch', async () => {
    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', Buffer.from('это обычный текст, а не книга'), 'report.xlsx');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('magic_mismatch');
  });

  it('старый формат .xls больше не принимается', async () => {
    // OLE2-контейнер: сигнатура верная для .xls, но формат убран из allowlist
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512, 0x00),
    ]);

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', ole, 'report.xls');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_format');
  });

  it('старый формат .doc больше не принимается', async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512, 0x00),
    ]);

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', ole, 'report.doc');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_format');
  });

  it('OLE-содержимое под именем .xlsx отвечает 415 magic_mismatch', async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512, 0x00),
    ]);

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', ole, 'report.xlsx');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('magic_mismatch');
  });

  it('zip-бомба отсекается до конвертации', async () => {
    // Книга с огромной распакованной записью: соотношение сжатия выдаёт бомбу
    const bomb = await buildZipBomb(200 * 1024 * 1024);

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', bomb, 'report.xlsx');

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('content_validation_failed');
  });

  it('документ с макросами отсекается до конвертации', async () => {
    // Проект VBA лежит отдельной частью пакета и по структуре контейнера
    // неотличим от обычного документа: ловится только zip-гардом
    const docx = await buildDocx({ withMacros: true });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', docx, 'report.docx');

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('content_validation_failed');
  });

  it('файл с именем без расширения распознаётся по содержимому', async () => {
    // Дальше проверки формата дело не идёт: хранилище в тестах недоступно,
    // но важно, что формат определён и запрос дошёл до постановки задачи
    const xlsx = await buildXlsx({ sheets: 1 });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', xlsx, 'report');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('storage_unavailable');
  });
});

describe('POST /convert/to-pdf: различение форматов', () => {
  it('документ Word принимается', async () => {
    // Сигнатура у XLSX и DOCX одна и та же, поэтому проверяется именно
    // разбор контейнера: без него документ ушёл бы в конвертацию как книга
    const docx = await buildDocx({ pages: 3 });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', docx, 'report.docx');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('storage_unavailable');
  });

  it('документ Word под именем .xlsx отвечает 415 magic_mismatch', async () => {
    const docx = await buildDocx({ pages: 3 });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', docx, 'report.xlsx');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('magic_mismatch');
  });

  it('книга Excel под именем .docx отвечает 415 magic_mismatch', async () => {
    const xlsx = await buildXlsx({ sheets: 1 });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', xlsx, 'report.docx');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('magic_mismatch');
  });

  it('zip-архив, не являющийся документом OOXML, отвечает 415 unsupported_format', async () => {
    const zip = await buildPlainZip();

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', zip, 'report.docx');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_format');
  });

  it('zip-архив без расширения отвечает 415 unsupported_format', async () => {
    const zip = await buildPlainZip();

    const response = await request(app).post('/convert/to-pdf').attach('file', zip, 'report');

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_format');
  });
});

describe('POST /convert/to-pdf: недоступное хранилище', () => {
  it('отвечает 503, а не 500', async () => {
    const xlsx = await buildXlsx({ sheets: 1 });

    const response = await request(app)
      .post('/convert/to-pdf')
      .attach('file', xlsx, 'report.xlsx');

    // Отказ хранилища — состояние, которое клиент может пережить повтором,
    // поэтому код отличается от внутренней ошибки
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('storage_unavailable');
  });
});

describe('GET /convert/status/:id', () => {
  it('идентификатор неверного формата отвечает 400', async () => {
    // Путь только из ASCII: supertest не экранирует кириллицу в URL
    const response = await request(app).get('/convert/status/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('идентификатор верного формата доходит до хранилища состояния', async () => {
    // Redis в тестах нет: важно, что запрос прошёл валидацию и упал
    // на инфраструктуре, а не на разборе пути
    const response = await request(app).get(
      '/convert/status/2f1a3c4d-5b6e-4a71-8c92-0d1e2f3a4b5c'
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
