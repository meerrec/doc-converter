/**
 * Тесты маршрута отдачи результатов (GET /results/:fileName).
 *
 * Покрывает:
 * 1. Отдачу существующего файла и корректные заголовки
 * 2. Алиас /storage/results (форма синхронного пути)
 * 3. 404 для отсутствующего результата
 * 4. Защиту от path traversal и недопустимых имён
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// STORAGE_PATH читается в config/index.js в момент импорта модуля,
// поэтому каталог для тестов задаётся до загрузки модулей сервиса —
// отсюда динамические импорты ниже.
const TEST_STORAGE = path.join(os.tmpdir(), `doc-converter-results-${process.pid}`);
process.env.STORAGE_PATH = TEST_STORAGE;

// Rate limit поднимаем, чтобы опрос не упирался в лимит
process.env.RATE_PER_SEC = '100';
process.env.RATE_BURST = '100';

const { createServer } = await import('../src/api/server.js');
const { writeResult } = await import('../src/storage/fileStorage.js');

let server;
let app;

/** Идентификатор задачи, для которой подготовлен файл результата. */
const TASK_ID = 'test-task-0001';

/** Содержимое тестового PDF (минимальный валидный заголовок). */
const PDF_BODY = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

beforeAll(async () => {
  const serverModule = await createServer();
  app = serverModule.app;
  server = serverModule.server;

  // Готовим результат так же, как это делает воркер очереди
  await writeResult(TASK_ID, PDF_BODY, 'pdf');
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await fs.rm(TEST_STORAGE, { recursive: true, force: true });
});

// ===========================================================================
// Отдача файла
// ===========================================================================

describe('Отдача результатов', () => {
  it('отдаёт сохранённый файл с корректными заголовками', async () => {
    const response = await request(app).get(`/results/${TASK_ID}.pdf`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain(`${TASK_ID}.pdf`);
    expect(response.body.length).toBe(PDF_BODY.length);
  });

  it('отдаёт тот же файл по алиасу /storage/results', async () => {
    const response = await request(app).get(`/storage/results/${TASK_ID}.pdf`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
  });

  it('подставляет человекочитаемое имя из параметра name', async () => {
    const response = await request(app)
      .get(`/results/${TASK_ID}.pdf`)
      .query({ name: 'Отчёт за квартал.pdf' });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    // Имя передаётся в кодировке RFC 5987 (filename*)
    expect(response.headers['content-disposition']).toMatch(/filename\*?=/i);
  });

  it('очищает имя из параметра name от разделителей пути', async () => {
    const response = await request(app)
      .get(`/results/${TASK_ID}.pdf`)
      .query({ name: '../../etc/passwd' });

    expect(response.status).toBe(200);

    // От имени остаётся только последний сегмент — без каталогов и '..'
    const disposition = response.headers['content-disposition'];
    expect(disposition).not.toContain('..');
    expect(disposition).not.toContain('/');
    expect(disposition).not.toContain('\\');
    expect(disposition).toContain('passwd');
  });

  it('возвращает 404 для отсутствующего результата', async () => {
    const response = await request(app).get('/results/no-such-task.pdf');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('result_not_found');
    expect(response.body.taskId).toBe('no-such-task');
  });
});

// ===========================================================================
// Защита от path traversal и недопустимых имён
// ===========================================================================

describe('Защита маршрута результатов', () => {
  const forbiddenNames = [
    '..%2F..%2Fetc%2Fpasswd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '..%5C..%5Cwindows%5Cwin.ini',
    '....%2F%2Fetc%2Fpasswd',
  ];

  for (const name of forbiddenNames) {
    it(`не отдаёт файл по имени ${name}`, async () => {
      const response = await request(app).get(`/results/${name}`);

      expect(response.status).not.toBe(200);
      expect(response.text || '').not.toContain('root:');
    });
  }

  it('не отдаёт файл с недопустимым расширением', async () => {
    // Файл лежит в хранилище, но расширение вне allowlist выходных форматов
    await writeResult(TASK_ID, Buffer.from('#!/bin/sh\n'), 'sh');

    const response = await request(app).get(`/results/${TASK_ID}.sh`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_result_name');
  });

  it('не отдаёт файл со слишком длинным идентификатором задачи', async () => {
    const longTaskId = 'a'.repeat(65);
    const response = await request(app).get(`/results/${longTaskId}.pdf`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_result_name');
  });

  it('не отдаёт файл с абсолютным путём', async () => {
    const response = await request(app).get('/results/%2Fetc%2Fpasswd.pdf');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_result_name');
  });

  it('не отдаёт скрытые файлы (имя начинается с точки)', async () => {
    const response = await request(app).get('/results/.hidden.pdf');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_result_name');
  });

  it('возвращает JSON-404 для неизвестного маршрута', async () => {
    const response = await request(app).get('/unknown-route');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
  });
});
