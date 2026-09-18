/**
 * Тесты пакетного маршрута состояния задач (GET /status?taskIds=…).
 *
 * Покрывает разбор параметра `taskIds` — единственное место маршрута, которое
 * не зависит от доступности Valkey: описание задачи при недоступном хранилище
 * деградирует до статуса `error`, а не до ошибки запроса.
 *
 * Проверяется:
 * 1. Одиночный идентификатор (`?taskIds=abc`) — 200 (расширение контракта)
 * 2. Повторяющийся параметр (`?taskIds=a&taskIds=b`) — 200, обе задачи в ответе
 * 3. Отсутствие параметра — 400 `invalid_request`
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Ограничитель частоты поднимаем: тесты делают несколько запросов подряд
process.env.RATE_PER_SEC = '100';
process.env.RATE_BURST = '100';

const { createServer } = await import('./helpers/server.js');

let app;
let server;

beforeAll(async () => {
  const created = await createServer();

  app = created.app;
  server = created.server;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('Пакетный статус задач', () => {
  it('принимает одиночный taskIds и отвечает 200', async () => {
    const response = await request(app).get('/status?taskIds=abc');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.tasks)).toBe(true);
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.tasks[0].taskId).toBe('abc');
  });

  it('принимает повторяющийся taskIds как массив', async () => {
    const response = await request(app).get('/status?taskIds=aaa&taskIds=bbb');

    expect(response.status).toBe(200);
    expect(response.body.tasks.map((task) => task.taskId)).toEqual(['aaa', 'bbb']);
  });

  it('отвечает 400 invalid_request без параметра taskIds', async () => {
    const response = await request(app).get('/status');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });
});
