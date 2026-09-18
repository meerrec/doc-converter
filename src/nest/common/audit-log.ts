/**
 * Аудит-логгер.
 *
 * Отдельный pino-инстанс пишет подозрительные события в `AUDIT_LOG_PATH`
 * (в Docker — `/var/log/converter/audit.log`, отдельный том). Если путь
 * не задан, события уходят в stdout: писать в `/var/log` без прав root нельзя.
 *
 * Раньше модуль был реэкспортом логгера из Express-слоя; после его удаления
 * реализация переехала сюда. DI не подходит: логгер создаётся на уровне модуля
 * и вызывается в том числе из домена (`worker/sandbox.ts`) вне Nest-контекста.
 *
 * Логируются:
 * - отказы по любой причине (`logRejection`)
 * - успешные конвертации (`logSuccess`) и ошибки конвертации (`logConversionError`)
 * - события безопасности: SSRF, zip-бомбы, XML-атаки
 */

import { createRequire } from 'node:module';
import type pino from 'pino';

const require = createRequire(import.meta.url);

/**
 * Фабрика логгера pino.
 *
 * Загружается через `createRequire`: объявления типов пакета не экспортируют
 * вызываемую функцию, поэтому обычный импорт даёт пространство имён без
 * сигнатуры вызова. Причина та же, что и в `common/logger.ts`.
 */
type PinoFactory = ((options: pino.LoggerOptions) => pino.Logger) & {
  stdTimeFunctions: { isoTime: () => string };
};

const pinoFactory = require('pino') as PinoFactory;

/**
 * Путь к аудит-логу.
 *
 * Читается напрямую из окружения, минуя `config`: инстанс создаётся
 * в момент импорта модуля, а `config/index.ts` к этому моменту может быть
 * ещё не загружен.
 */
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || null;

/** Инстанс pino для аудит-событий. */
const auditLogger = pinoFactory({
  name: 'doc-converter-audit',
  level: process.env.AUDIT_LOG_LEVEL || 'info',
  timestamp: pinoFactory.stdTimeFunctions.isoTime,
  // Файловый транспорт подключаем только при явно заданном пути
  ...(AUDIT_LOG_PATH
    ? {
        transport: {
          target: 'pino/file',
          options: {
            destination: AUDIT_LOG_PATH,
            mkdir: true,
          },
        },
      }
    : {}),
  formatters: {
    log: (object: Record<string, unknown>) => {
      // Добавляем timestamp в ISO формате
      return {
        ts: new Date().toISOString(),
        ...object,
      };
    },
  },
});

/** Аудит-логгер, доступный вызывающему коду. */
export type AuditLogger = typeof auditLogger;

/**
 * Минимальная форма запроса, нужная аудит-логгеру.
 *
 * Описана структурно, а не через тип Express: модуль фреймворк-агностичен,
 * и этой формы достаточно, чтобы принять как запрос Nest, так и объект
 * с полями события.
 */
export interface AuditRequest {
  headers?: Record<string, unknown>;
  ip?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
  requestId?: string;
  auditLog?: AuditLogger;
}

/** Поля события аудита. */
export type AuditFields = Record<string, unknown>;

/**
 * Логирует событие отказа.
 *
 * Поддерживает две формы вызова:
 * - `logRejection(req, code, message, fields)` — когда запрос доступен
 * - `logRejection({ requestId, ip, ua, code, message })` — когда доступны
 *   только поля события (обработчики очереди, домен)
 *
 * @param req - запрос или объект с полями события
 * @param code - код ошибки (при вызове с запросом)
 * @param message - сообщение об ошибке (при вызове с запросом)
 * @param additionalFields - дополнительные поля для лога
 */
export function logRejection(
  req: AuditRequest | AuditFields | null | undefined,
  code?: string,
  message?: string,
  additionalFields: AuditFields = {}
): void {
  // Различаем формы вызова по наличию headers у запроса
  const isRequest =
    req != null && typeof req === 'object' && typeof (req as AuditRequest).headers === 'object';

  if (!isRequest) {
    const fields = (req ?? {}) as AuditFields;

    auditLogger.warn({
      event: 'rejected',
      ...fields,
    });
    return;
  }

  const request = req as AuditRequest;
  const auditLog = request.auditLog ?? auditLogger;

  auditLog.warn({
    event: 'rejected',
    code,
    message,
    ip: request.ip,
    ua: request.headers?.['user-agent'],
    requestId: request.requestId,
    method: request.method,
    url: request.originalUrl,
    ...additionalFields,
  });
}

/**
 * Логирует успешное завершение конвертации.
 *
 * @param fields - поля события (requestId, taskId, fileType, size, durationMs)
 */
export function logSuccess(fields: AuditFields = {}): void {
  auditLogger.info({
    event: 'conversion_success',
    ...fields,
  });
}

/**
 * Логирует ошибку конвертации.
 *
 * @param fields - поля события (requestId, taskId, code, message, durationMs)
 */
export function logConversionError(fields: AuditFields = {}): void {
  auditLogger.error({
    event: 'conversion_error',
    ...fields,
  });
}

/**
 * Логирует попытку SSRF.
 *
 * @param req - запрос или объект с полями события
 * @param url - подозрительный URL
 * @param reason - причина блокировки
 */
export function logSsrfAttempt(
  req: AuditRequest | AuditFields,
  url: string,
  reason: string
): void {
  const auditLog = (req as AuditRequest).auditLog ?? auditLogger;

  auditLog.warn({
    event: 'ssrf_attempt',
    blockedUrl: url,
    reason,
    ip: (req as AuditRequest).ip,
    requestId: (req as AuditRequest).requestId,
  });
}

/**
 * Логирует обнаружение zip-бомбы.
 *
 * @param req - запрос или объект с полями события
 * @param violationCode - код нарушения
 * @param details - детали нарушения
 */
export function logZipBomb(
  req: AuditRequest | AuditFields,
  violationCode: string,
  details: unknown
): void {
  const auditLog = (req as AuditRequest).auditLog ?? auditLogger;

  auditLog.warn({
    event: 'zip_bomb_detected',
    code: violationCode,
    details,
    ip: (req as AuditRequest).ip,
    requestId: (req as AuditRequest).requestId,
  });
}

/**
 * Логирует обнаружение XML-атаки.
 *
 * @param req - запрос или объект с полями события
 * @param violationCode - код нарушения
 * @param details - детали нарушения
 */
export function logXmlAttack(
  req: AuditRequest | AuditFields,
  violationCode: string,
  details: unknown
): void {
  const auditLog = (req as AuditRequest).auditLog ?? auditLogger;

  auditLog.warn({
    event: 'xml_attack_detected',
    code: violationCode,
    details,
    ip: (req as AuditRequest).ip,
    requestId: (req as AuditRequest).requestId,
  });
}

export { auditLogger };
