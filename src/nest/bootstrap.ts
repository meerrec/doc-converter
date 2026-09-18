/**
 * Сборка и запуск NestJS-приложения.
 *
 * Экспортирует `createServer()` с той же сигнатурой, что и Express-версия
 * (`{ app, server }`), — благодаря этому существующий набор тестов можно
 * направить на новое приложение, не меняя сами тесты. Это и есть критерий
 * готовности к переключению: те же 90 тестов должны остаться зелёными.
 *
 * `app` — именно экземпляр Express, а не Nest-приложение: supertest принимает
 * его напрямую, как и раньше.
 */

import 'reflect-metadata';
import express from 'express';
import { createRequire } from 'node:module';
import type { RequestHandler } from 'express';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, type INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { AppModule } from './app.module.js';
import { R7ExceptionFilter } from './common/r7-exception.filter.js';
import { requestIdMiddleware, type RequestWithId } from './common/request-id.middleware.js';
import { PinoLoggerService, createLogger } from './common/logger.js';
import { resolvePort } from './config/env.js';
import {
  BODY_LIMIT_BYTES,
  applyCors,
  applySecurityHeaders,
} from './common/http-defaults.js';

const require = createRequire(import.meta.url);

/**
 * Фабрика middleware pino-http.
 *
 * Загружается через `createRequire`: объявления типов пакета не экспортируют
 * вызываемую функцию, поэтому обычный импорт даёт пространство имён без
 * сигнатуры вызова. Причина та же, что и в `common/logger.ts`.
 */
const pinoHttp = require('pino-http') as (options: {
  logger: unknown;
  genReqId: (req: RequestWithId) => string;
}) => RequestHandler;

/** Результат создания приложения. */
export interface CreatedServer {
  /** Экземпляр Express — то, что ожидает supertest. */
  app: Express;
  /** Слушающий HTTP-сервер. */
  server: Server;
  /** Nest-приложение: нужно для корректного завершения. */
  nest: INestApplication;
}

/**
 * Создаёт NestJS-приложение без запуска прослушивания.
 *
 * @returns инициализированное приложение
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    // Логи буферизуются до применения логгера, иначе старт пишется в stdout
    // в обход настроенного уровня
    bufferLogs: true,
    // Разборщик тела ставим сами: у встроенного лимит 100 КБ, а сервис
    // принимает документы в base64
    bodyParser: false,
  });

  const config = app.get(ConfigService);
  const nodeEnv = config.get<string>('NODE_ENV');
  const level = config.get<string>('LOG_LEVEL') ?? 'info';

  // Логгером приложения становится pino: и системные сообщения Nest,
  // и логи запросов уходят в один поток
  const logger = createLogger(level);
  app.useLogger(new PinoLoggerService(logger));

  // Идентификатор запроса проставляется раньше остальных обработчиков:
  // его используют и логгер, и фильтр ошибок, и аудит
  app.use(requestIdMiddleware);

  // Логирование запросов: идентификатор берётся уже проставленный, чтобы
  // строки логов сшивались с X-Request-Id в ответе
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: RequestWithId) => req.requestId ?? '',
    })
  );

  applySecurityHeaders(app, nodeEnv === 'production');
  applyCors(app, nodeEnv === 'development');

  // strict: true — только объекты, не массивы (как в Express-версии)
  app.use(express.json({ limit: BODY_LIMIT_BYTES, strict: true }));

  app.useGlobalFilters(new R7ExceptionFilter());

  return app;
}

/**
 * Создаёт и запускает сервер.
 *
 * @returns приложение, слушающий сервер и Nest-приложение
 */
export async function createServer(): Promise<CreatedServer> {
  const nest = await createApp();
  const config = nest.get(ConfigService);

  const port = resolvePort({
    PORT: config.get<number>('PORT'),
    API_PORT: config.get<number>('API_PORT'),
  });
  const host = config.get<string>('HOST') ?? '0.0.0.0';

  await nest.init();

  const server = await nest.listen(port, host);
  const app = nest.getHttpAdapter().getInstance() as Express;

  return { app, server, nest };
}

/**
 * Запускает сервер с обработкой сигналов завершения.
 *
 * @returns слушающий HTTP-сервер
 */
export async function startServer(): Promise<Server> {
  const logger = new Logger('Bootstrap');
  const { server, nest } = await createServer();

  /**
   * Останавливает сервер и закрывает ресурсы приложения.
   *
   * @param signal - полученный сигнал
   */
  const shutdown = (signal: string): void => {
    logger.log(`Получен ${signal}, остановка…`);

    server.close(() => {
      void nest.close().then(() => {
        logger.log('Сервер остановлен');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}
