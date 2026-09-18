/**
 *Middleware для аудит-логирования.
 *
 * Отдельный pino-инстанс для аудита записывает все подозрительные события
 * в /var/log/converter/audit.log (отдельный volume).
 *
 * Логируются:
 * - Все ошибки валидации (ValidationError)
 * - Отклонённые запросы по rate limit
 * - Подозрительные URL (SSRF попытки)
 * - Обнаруженные zip-бомбы и XML-атаки
 *
 * Все комментарии на русском языке.
 */

import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Путь к аудит-логу.
 * В Docker это volume /var/log/converter/audit.log (задаётся через AUDIT_LOG_PATH).
 * Если переменная не задана — пишем в stdout: писать в /var/log без прав root нельзя.
 */
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || null;

/**
 * Создаём отдельный pino-инстанс для аудита.
 * Уровень логирования: info (логируем только важные события).
 */
const auditLogger = pino({
  name: 'doc-converter-audit',
  level: process.env.AUDIT_LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  // Файловый транспорт подключаем только при явно заданном пути
  ...(AUDIT_LOG_PATH
    ? {
        transport: {
          target: 'pino/file',
          options: {
            destination: AUDIT_LOG_PATH,
            mkdir: true
          }
        }
      }
    : {}),
  formatters: {
    log: (object) => {
      // Добавляем timestamp в ISO формате
      return {
        ts: new Date().toISOString(),
        ...object
      };
    }
  }
});

/**
 * Middleware для Express.
 * Логирует информацию о запросе для аудита.
 *
 * @returns {Function} - Express middleware
 */
export function auditLogMiddleware() {
  return (req, res, next) => {
    // Сохраняем начальное время запроса
    const startTime = Date.now();
    
    // Добавляем auditLogger к запросу для использования в route handlers
    req.auditLog = auditLogger;
    
    // Логируем начало запроса
    auditLogger.info({
      event: 'request_start',
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      ua: req.headers['user-agent'],
      requestId: req.requestId
    });
    
    // Прослушиваем завершение запроса
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      
      auditLogger.info({
        event: 'request_end',
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: duration,
        ip: req.ip,
        requestId: req.requestId
      });
    });
    
    next();
  };
}

/**
 * Логирует событие отказ (rejection).
 * Вызывается при отклонении запроса по любой причине.
 *
 * Поддерживает две формы вызова:
 * - logRejection(req, code, message, fields) — из middleware
 * - logRejection({ requestId, ip, ua, code, message }) — из обработчиков,
 *   где Express-запрос недоступен
 *
 * @param {Object} req - Express request или объект с полями события
 * @param {string} [code] - код ошибки (при вызове с req)
 * @param {string} [message] - сообщение об ошибке (при вызове с req)
 * @param {Object} [additionalFields] - дополнительные поля для лога
 */
export function logRejection(req, code, message, additionalFields = {}) {
  // Различаем формы вызова по наличию headers у Express-запроса
  const isRequest = req != null &&
    typeof req === 'object' &&
    typeof req.headers === 'object';

  if (!isRequest) {
    const fields = req || {};
    auditLogger.warn({
      event: 'rejected',
      ...fields
    });
    return;
  }

  const auditLog = req.auditLog || auditLogger;

  auditLog.warn({
    event: 'rejected',
    code,
    message,
    ip: req.ip,
    ua: req.headers['user-agent'],
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    ...additionalFields
  });
}

/**
 * Логирует успешное завершение конвертации.
 *
 * @param {Object} fields - поля события (requestId, taskId, fileType, size, durationMs)
 */
export function logSuccess(fields = {}) {
  auditLogger.info({
    event: 'conversion_success',
    ...fields
  });
}

/**
 * Логирует ошибку конвертации.
 *
 * @param {Object} fields - поля события (requestId, taskId, code, message, durationMs)
 */
export function logConversionError(fields = {}) {
  auditLogger.error({
    event: 'conversion_error',
    ...fields
  });
}

/**
 * Логирует SSRF попытку.
 *
 * @param {Object} req - Express request
 * @param {string} url - подозрительный URL
 * @param {string} reason - причина блокировки
 */
export function logSsrfAttempt(req, url, reason) {
  const auditLog = req.auditLog || auditLogger;
  
  auditLog.warn({
    event: 'ssrf_attempt',
    blockedUrl: url,
    reason,
    ip: req.ip,
    requestId: req.requestId
  });
}

/**
 * Логирует обнаружение zip-бомбы.
 *
 * @param {Object} req - Express request
 * @param {string} violationCode - код нарушения
 * @param {Object} details - детали нарушения
 */
export function logZipBomb(req, violationCode, details) {
  const auditLog = req.auditLog || auditLogger;
  
  auditLog.warn({
    event: 'zip_bomb_detected',
    code: violationCode,
    details,
    ip: req.ip,
    requestId: req.requestId
  });
}

/**
 * Логирует обнаружение XML-атаки.
 *
 * @param {Object} req - Express request
 * @param {string} violationCode - код нарушения
 * @param {Object} details - детали нарушения
 */
export function logXmlAttack(req, violationCode, details) {
  const auditLog = req.auditLog || auditLogger;
  
  auditLog.warn({
    event: 'xml_attack_detected',
    code: violationCode,
    details,
    ip: req.ip,
    requestId: req.requestId
  });
}

export default auditLogMiddleware;
export { auditLogger };
