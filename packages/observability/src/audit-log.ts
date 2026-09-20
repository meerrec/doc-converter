/**
 * Аудит-логгер.
 *
 * Отдельный pino-инстанс пишет события в `AUDIT_LOG_PATH`
 * (в Docker — `/var/log/converter/audit.log`, отдельный том). Если путь
 * не задан, события уходят в stdout: писать в `/var/log` без прав root нельзя.
 *
 * DI не подходит: логгер создаётся на уровне модуля и вызывается в том числе
 * из воркера (`worker/uno/processor.ts`) вне Nest-контекста.
 *
 * Логируются: отказы (проверка файла, параметры), успешные конвертации
 * и ошибки конвертации. Набор сужен вместе с переходом на XLSX → PDF:
 * функции для SSRF и XML-атак удалены вместе с путями, которые они защищали.
 *
 * Все комментарии на русском языке.
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
    log: (object: Record<string, unknown>) => ({
      ts: new Date().toISOString(),
      ...object,
    }),
  },
});

/** Аудит-логгер, доступный вызывающему коду. */
export type AuditLogger = typeof auditLogger;

/**
 * Минимальная форма запроса, нужная аудит-логгеру.
 *
 * Описана структурно, а не через тип Express: модуль фреймворк-агностичен,
 * и этой формы достаточно, чтобы принять как запрос Nest, так и объект
 * с полями события из воркера.
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
 * - `logRejection(req, code, message, fields)` — когда доступен запрос;
 * - `logRejection({ requestId, jobId, code, message })` — когда доступны
 *   только поля события (воркер, домен).
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
  const isRequest = Boolean(req && (req as AuditRequest).headers !== undefined);

  const base = isRequest
    ? {
        requestId: (req as AuditRequest).requestId,
        ip: (req as AuditRequest).ip,
        method: (req as AuditRequest).method,
        url: (req as AuditRequest).originalUrl ?? (req as AuditRequest).url,
        code,
        message,
      }
    : (req as AuditFields | null | undefined) ?? {};

  auditLogger.warn({ ...base, ...additionalFields }, 'rejected');
}

/**
 * Логирует успешную конвертацию.
 *
 * @param fields - поля события (jobId, tier, size, durationMs)
 */
export function logSuccess(fields: AuditFields = {}): void {
  auditLogger.info({ ...fields }, 'conversion_succeeded');
}

/**
 * Логирует ошибку конвертации.
 *
 * @param fields - поля события (jobId, tier, code, message, durationMs)
 */
export function logConversionError(fields: AuditFields = {}): void {
  auditLogger.error({ ...fields }, 'conversion_failed');
}

/**
 * Логирует отсечение архива zip-гардом.
 *
 * Отдельная функция, а не `logRejection`: попытка протащить zip-бомбу —
 * это событие безопасности, и искать его в логе удобнее по своему имени.
 *
 * @param fields - поля события (requestId, ip, violationCode, details)
 */
export function logZipBomb(fields: AuditFields = {}): void {
  auditLogger.warn({ ...fields }, 'zip_bomb_rejected');
}

export default {
  logRejection,
  logSuccess,
  logConversionError,
  logZipBomb,
};
