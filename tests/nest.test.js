/**
 * Проверки NestJS-приложения.
 *
 * Тесты работают с исходниками на TypeScript: раннер — Vitest, сборка перед
 * прогоном не нужна.
 *
 * Покрывается каркас: проверка доступности, формат ошибок Р7 и ограничитель
 * частоты. Маршруты конвертации проверяются отдельно, после их переноса.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Порт задаётся до загрузки модулей: config/index.js читает окружение
// в момент импорта
process.env.PORT = '3211';
process.env.HOST = '127.0.0.1';
// Небольшой всплеск, чтобы проверить ограничитель несколькими запросами
process.env.RATE_PER_SEC = '2';
process.env.RATE_BURST = '5';

const { createServer } = await import('../src/nest/bootstrap.js');

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

describe('NestJS: проверка доступности', () => {
  it('GET /health отвечает 200 и формой из контракта', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: expect.any(String),
        wasm: expect.any(Boolean),
        version: expect.any(String),
      })
    );
  });

  it('проставляет версию конвертера в заголовке', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-converter-version']).toBeDefined();
  });

  it('отдаёт заголовки безопасности', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});

describe('NestJS: формат ошибок', () => {
  it('несуществующий маршрут отдаёт { error, message }', async () => {
    // Путь только из ASCII: supertest не экранирует кириллицу в URL
    const response = await request(app).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
    expect(typeof response.body.message).toBe('string');
    // Формат Nest по умолчанию ({ statusCode, error, message }) недопустим:
    // контракт Р7 описывает поле error как код в snake_case
    expect(response.body.statusCode).toBeUndefined();
  });

  it('не раскрывает внутренние детали при ошибке', async () => {
    const response = await request(app).get('/no-such-route');

    // Системные коды Node (ENOENT и подобные) не должны попадать в поле error
    expect(response.body.error).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('NestJS: ограничитель частоты', () => {
  it('пропускает всплеск и отклоняет запросы сверх него', async () => {
    // Всплеск = 5: первые пять запросов проходят, шестой отклоняется.
    // Предыдущие тесты тоже расходовали бюджет, поэтому проверяем не точное
    // число, а сам факт появления 429 и его форму
    const statuses = [];

    for (let i = 0; i < 12; i += 1) {
      const response = await request(app).get('/health');
      statuses.push(response.status);

      if (response.status === 429) {
        expect(response.body.error).toBe('rate_limited');
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
    }

    expect(statuses).toContain(429);
  });
});
