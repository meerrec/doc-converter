/**
 *Rate limiting middleware на основе sliding window per IP.
 *
 * Реализация: In-memory storage с использованием Map для хранения истории запросов.
 *-Algorithm: Sliding window counter (RATE_PER_SEC запросов в секунду, RATE_BURST всплеск).
 *
 * ВНИМАНИЕ: В MVP хранилище in-memory. При кластеризации API нужно переехать
 * на Valkey для shared state между процессами.
 *
 * Все комментарии на русском языке.
 */

import { RATE_PER_SEC, RATE_BURST } from '../../config/index.js';

/**
 * Хранилище истории запросов: IP -> { timestamps: number[], count: number }
 * Очищается автоматически при истечении TTL.
 */
const requestHistory = new Map();

/**
 * TTL для хранения истории (в мс).
 * Обоснование: 60 секунд достаточно для sliding window.
 */
const HISTORY_TTL_MS = 60000;

/**
 * Очищает старые записи из хранилища.
 * Вызывается периодически для предотвращения утечки памяти.
 */
function cleanupHistory() {
  const now = Date.now();
  for (const [ip, data] of requestHistory.entries()) {
    // Удаляем записи старше TTL
    if (now - data.timestamps[0] > HISTORY_TTL_MS) {
      requestHistory.delete(ip);
    }
  }
}

/**
 * Вызывается периодически для очистки старой истории.
 * Интервал: 1 минута.
 */
const cleanupInterval = setInterval(cleanupHistory, 60000);

// Очищаем интервал при завершении процесса
process.on('exit', () => clearInterval(cleanupInterval));
process.on('SIGTERM', () => { clearInterval(cleanupInterval); process.exit(0); });
process.on('SIGINT', () => { clearInterval(cleanupInterval); process.exit(0); });

/**
 * Получает текущий count запросов для IP используя sliding window.
 *
 * @param {string} ip - IP-адрес клиента
 * @returns {number} - количество запросов в текущем окне
 */
function getRequestCount(ip) {
  const now = Date.now();
  const windowStart = now - 1000; // 1 секунда назад
  
  let data = requestHistory.get(ip);
  
  if (!data) {
    data = { timestamps: [], count: 0 };
    requestHistory.set(ip, data);
  }
  
  // Удаляем старые временные метки (вне текущего окна)
  while (data.timestamps.length > 0 && data.timestamps[0] < windowStart) {
    data.timestamps.shift();
    data.count--;
  }
  
  return data.count;
}

/**
 * Увеличивает счётчик запросов для IP.
 *
 * @param {string} ip - IP-адрес клиента
 */
function incrementRequestCount(ip) {
  const now = Date.now();
  let data = requestHistory.get(ip);
  
  if (!data) {
    data = { timestamps: [], count: 0 };
    requestHistory.set(ip, data);
  }
  
  data.timestamps.push(now);
  data.count++;
  
  // Ограничиваем размер массива для предотвращения утечки памяти
  if (data.timestamps.length > RATE_BURST * 2) {
    data.timestamps = data.timestamps.slice(-RATE_BURST * 2);
    data.count = data.timestamps.length;
  }
}

/**
 * Проверяет, превышен ли лимит запросов для IP.
 *
 * @param {string} ip - IP-адрес клиента
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }} - результат проверки
 */
export function checkRateLimit(ip) {
  const currentCount = getRequestCount(ip);
  const allowed = currentCount < RATE_PER_SEC || currentCount <= RATE_BURST;
  
  // В sliding window максимальный count в секунду не должен превышать RATE_PER_SEC
  // Но допускаем всплеск до RATE_BURST
  const isWithinLimit = currentCount < RATE_PER_SEC;
  const isWithinBurst = currentCount <= RATE_BURST;
  
  // Разрешаем, если в пределах лимита или всплеска
  const result = isWithinLimit || isWithinBurst;
  
  return {
    allowed: result,
    remaining: Math.max(0, RATE_BURST - currentCount),
    resetAt: Date.now() + 1000 // Следующая секунда
  };
}

/**
 * Middleware для Express.
 * Добавляет rate limit проверку и соответствующие заголовки.
 *
 * @returns {Function} - Express middleware
 */
export function rateLimitMiddleware() {
  return (req, res, next) => {
    // Получаем IP клиента (учитываем X-Forwarded-For для proxy)
    const ip = req.ip || 
               req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.connection?.remoteAddress ||
               req.socket?.remoteAddress ||
               (req.connection?.socket?.remoteAddress);
    
    const result = checkRateLimit(ip);
    
    if (!result.allowed) {
      // Preflight запросы CORS не должны учитываться в rate limit
      if (req.method === 'OPTIONS') {
        return next();
      }
      
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000) || 1;
      
      res.set({
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(RATE_BURST),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(result.resetAt / 1000))
      });
      
      return res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests. Try again in ${retryAfter} seconds.`
      });
    }
    
    // Добавляем заголовки rate limit для успешных запросов
    res.set({
      'X-RateLimit-Limit': String(RATE_BURST),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.floor(result.resetAt / 1000))
    });
    
    // Увеличиваем счётчик после успешной проверки
    incrementRequestCount(ip);
    
    next();
  };
}

/**
 * Сбрасывает счётчик для IP (для тестов).
 *
 * @param {string} ip - IP-адрес
 */
export function resetRateLimit(ip) {
  requestHistory.delete(ip);
}

/**
 * Сбрасывает все счётчики (для тестов).
 */
export function resetAllRateLimits() {
  requestHistory.clear();
}

/**
 * Получает текущую статистику rate limiting.
 * Используется для мониторинга.
 *
 * @returns {Object} - статистика
 */
export function getRateLimitStats() {
  return {
    totalEntries: requestHistory.size,
    RATE_PER_SEC,
    RATE_BURST
  };
}

export default rateLimitMiddleware;
