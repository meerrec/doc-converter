/**
 * Маршрут health check
 * 
 * Отвечает за:
 * - Проверку здоровья сервиса
 * - Возврат статуса готовности
 * - Проверку подключения к Valkey
 * - Проверку загрузки WASM
 * 
 * Endpoint: GET /health
 * 
 * Ответ:
 * - 200 OK: сервис полностью готов
 * - 503 Service Unavailable: сервис не готов (WASM не загружен)
 * 
 * Пример ответа:
 * {
 *   "status": "ok",
 *   "wasm": true,
 *   "redis": true
 * }
 */

import express from 'express';
import { checkRedisHealth } from '../../queue/connection.js';
import { isWasmReady, checkWasmHealth } from '../../worker/wasm-isolate.js';
import { CONVERTER_VERSION } from '../../config/index.js';

const router = express.Router();

/**
 * Health check endpoint
 * 
 * @route GET /health
 */
router.get('/', async (req, res) => {
  try {
    // Проверяем Redis (возвращает { healthy, error }, а не boolean)
    const redisHealth = await checkRedisHealth();

    // Проверяем WASM (checkWasmHealth возвращает { healthy, error })
    const wasmHealth = await checkWasmHealth();
    const wasmReady = isWasmReady();

    // Если WASM не загружен - возвращаем 503
    if (!wasmReady && !wasmHealth.healthy) {
      return res.status(503).json({
        status: 'initializing',
        wasm: false,
        redis: redisHealth.healthy,
        version: CONVERTER_VERSION,
      });
    }

    // Сервис готов
    res.json({
      status: 'ok',
      wasm: wasmReady,
      redis: redisHealth.healthy,
      version: CONVERTER_VERSION,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      wasm: false,
      redis: false,
      error: err.message,
      version: CONVERTER_VERSION,
    });
  }
});

/**
 * Проверка readiness (для Kubernetes)
 * 
 * @route GET /health/ready
 */
router.get('/ready', async (req, res) => {
  try {
    const redisHealth = await checkRedisHealth();
    const wasmReady = isWasmReady();

    if (!redisHealth.healthy || !wasmReady) {
      return res.status(503).json({
        ready: false,
        redis: redisHealth.healthy,
        wasm: wasmReady,
      });
    }
    
    res.json({
      ready: true,
      redis: true,
      wasm: true,
    });
  } catch (err) {
    res.status(503).json({
      ready: false,
      error: err.message,
    });
  }
});

/**
 * Проверка liveness (для Kubernetes)
 * 
 * @route GET /health/live
 */
router.get('/live', (req, res) => {
  // Если сервер отвечает - он жив
  res.json({
    live: true,
  });
});

export default router;
