/**
 *Express сервер для API конвертации документов.
 *
 * Настраивает:
 * - Middleware (rate limit, request ID, audit log, body parser, etc.)
 * - Маршруты (POST /ConvertService.ashx, GET /status/:taskId, GET /health)
 * - Обработку ошибок
 *
 * Все комментарии на русском языке.
 */

import express from 'express';
import pinoHttp from 'pino-http';
import {
  rateLimitMiddleware,
  requestIdMiddleware,
  auditLogMiddleware,
  bodyTimeoutMiddleware,
  validateBodyMiddleware,
  validateContentMiddleware
} from './middleware/index.js';
import { API_PORT, SYNC_ENABLED, CONVERTER_VERSION } from '../config/index.js';
import convertRouter from './routes/convert.js';
import statusRouter from './routes/status.js';
import resultsRouter from './routes/results.js';
import { createRequire } from 'module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

/**
 * Создаёт Express приложение.
 *
 * @returns {Express} - Express app
 */
export function createApp() {
  const app = express();
  
  // ==========================================================================
  // Middleware
  // ==========================================================================
  
  // Request ID
  app.use(requestIdMiddleware());
  
  // Audit logging
  app.use(auditLogMiddleware());
  
  // Rate limiting
  app.use(rateLimitMiddleware());
  
  // Body parser с лимитом
  app.use(express.json({
    limit: `${process.env.MAX_BODY_BYTES || 104857600}`, // 100 MiB
    strict: true // Только JSON объекты, не массивы
  }));
  
  // Body timeout
  app.use(bodyTimeoutMiddleware());
  
  // CORS заголовки (для development)
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
      res.setHeader('Access-Control-Max-Age', '86400');
      
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      
      next();
    });
  }
  
  // Версия конвертера
  app.use((req, res, next) => {
    res.set('X-Converter-Version', CONVERTER_VERSION || packageJson.version);
    next();
  });
  
  // Заголовки безопасности
  app.use((req, res, next) => {
    // X-Content-Type-Options: nosniff
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // X-Frame-Options: DENY
    res.setHeader('X-Frame-Options', 'DENY');
    
    // X-XSS-Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Content-Security-Policy (только для production)
    if (process.env.NODE_ENV === 'production') {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
      );
    }
    
    next();
  });
  
  // COOP/COEP/CORP заголовки для WASM
  // КРИТИЧНО: без этих заголовков браузер не отдаст SharedArrayBuffer
  // и многопоточный WASM-движок LibreOffice не запустится
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  
  // Cache-Control для результатов
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
  });
  
  // ==========================================================================
  //Health check
  // ==========================================================================
  
  app.get('/health', (req, res) => {
    const wasmReady = true; // TODO: check WASM initialization
    
    res.json({
      status: wasmReady ? 'ok' : 'initializing',
      wasm: wasmReady,
      version: CONVERTER_VERSION || packageJson.version
    });
  });
  
  // ==========================================================================
  // Маршруты
  // ==========================================================================
  
  // Импортируем маршруты (импорты объявлены в начале модуля)

  // Настраиваем маршруты
  app.use('/ConvertService.ashx', validateBodyMiddleware(), validateContentMiddleware, convertRouter);
  app.use('/status', statusRouter);

  // Отдача готовых результатов.
  // Монтируется по двум путям: '/results' — форма асинхронного пути,
  // '/storage/results' — форма синхронного. Клиент использует fileUrl дословно,
  // поэтому должны работать обе. Rate limit здесь не дублируется — он уже
  // навешан глобально выше.
  app.use('/results', resultsRouter);
  app.use('/storage/results', resultsRouter);
  
  // ==========================================================================
  // Обработка ошибок
  // ==========================================================================
  
  // 404 для неизвестных маршрутов
  app.use((req, res) => {
    res.status(404).json({
      error: 'not_found',
      message: 'Route not found'
    });
  });
  
  // Обработка ошибок
  app.use((err, req, res, next) => {
    console.error('[server] Ошибка:', err);
    
    // Определяем статус код и сообщение
    let statusCode = err.statusCode || 500;
    let errorCode = err.code || 'internal';
    let message = err.message || 'Internal server error';
    
    // Логируем ошибку
    if (req.auditLog) {
      req.auditLog.error({
        event: 'server_error',
        error: errorCode,
        message,
        statusCode,
        path: req.path,
        method: req.method,
        requestId: req.requestId
      });
    }
    
    // Отвечаем с ошибкой
    res.status(statusCode).json({
      error: errorCode,
      message: message,
      requestId: req.requestId
    });
  });
  
  return app;
}

/**
 * Создаёт и запускает сервер.
 *
 * @returns {Promise<{app: Express, server: http.Server}>}
 */
export async function createServer() {
  const app = createApp();
  
  const server = app.listen(API_PORT, () => {
    console.log(`[server] API сервер запущен на порту ${API_PORT}`);
    console.log(`[server] Версия конвертера: ${CONVERTER_VERSION || packageJson.version}`);
    console.log(`[server] Синхронный режим: ${SYNC_ENABLED ? 'включён' : 'выключен'}`);
  });
  
  // Обработка ошибок сервера
  server.on('error', (err) => {
    console.error('[server] Ошибка сервера:', err);
  });
  
  // Graceful shutdown
  server.on('close', () => {
    console.log('[server] Сервер остановлен');
  });
  
  return { app, server };
}

/**
 * Запускает сервер (точка входа).
 */
export async function startServer() {
  const { server } = await createServer();
  
  // Обработка сигналов для graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[server] Получен SIGTERM, остановка...');
    server.close(() => {
      console.log('[server] Сервер остановлен');
      process.exit(0);
    });
  });
  
  process.on('SIGINT', () => {
    console.log('[server] Получен SIGINT, остановка...');
    server.close(() => {
      console.log('[server] Сервер остановлен');
      process.exit(0);
    });
  });
  
  return server;
}

export default {
  createApp,
  createServer,
  startServer
};

// ============================================================================
// Точка входа
// ============================================================================

// Запускаем сервер только при прямом вызове файла (node src/api/server.js),
// чтобы импорт модуля в тестах не поднимал слушающий сокет
const isMainModule = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startServer().catch((err) => {
    console.error('[server] Не удалось запустить сервер:', err);
    process.exit(1);
  });
}
