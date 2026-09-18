/**
 *Middleware для генерации и обработки X-Request-Id.
 *
 * X-Request-Id используется для:
 * 1. Корреляции логов по запросу
 * 2. Отслеживания цепочки запросов
 * 3. Отладки и мониторинга
 *
 * Если клиент передаёт свой X-Request-Id, мы его переиспользуем.
 * Иначе генерацируем новый UUID.
 *
 * Все комментарии на русском языке.
 */

import { randomUUID } from 'crypto';

/**
 * Генерирует уникальный request ID.
 *
 * @returns {string} - UUID v4
 */
function generateRequestId() {
  return randomUUID();
}

/**
 * Middleware для Express.
 * Добавляет requestId к запросу и устанавливает заголовок X-Request-Id в ответе.
 *
 * @returns {Function} - Express middleware
 */
export function requestIdMiddleware() {
  return (req, res, next) => {
    // Пытаемся получить X-Request-Id из заголовков запроса
    const clientRequestId = req.headers['x-request-id'];
    
    // Используем клиентский ID, если он передан и валиден
    if (clientRequestId && typeof clientRequestId === 'string' && clientRequestId.length > 0) {
      req.requestId = clientRequestId;
    } else {
      // Генерируем новый ID
      req.requestId = generateRequestId();
    }
    
    // Устанавливаем заголовок X-Request-Id в ответе
    res.set('X-Request-Id', req.requestId);
    
    // Добавляем requestId в логер, если он есть
    if (req.log && typeof req.log === 'function') {
      req.log = req.log.child({ requestId: req.requestId });
    }
    
    next();
  };
}

/**
 * Возвращает requestId запроса.
 * Если middleware не отработал — генерирует новый, чтобы логирование
 * не теряло корреляцию.
 *
 * @param {Object} req - Express request
 * @returns {string} - request ID
 */
export function getRequestId(req) {
  if (req && typeof req.requestId === 'string' && req.requestId.length > 0) {
    return req.requestId;
  }

  return generateRequestId();
}

export default requestIdMiddleware;
