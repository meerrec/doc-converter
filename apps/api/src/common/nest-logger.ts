/**
 * Адаптер pino под интерфейс логгера NestJS.
 *
 * Нужен, чтобы системные сообщения Nest (старт приложения, инициализация
 * модулей) уходили в тот же поток, что и логи запросов.
 *
 * Живёт в API, а не в `@doc-converter/observability`: интерфейс
 * `LoggerService` принадлежит Nest, а тот пакет читает и воркер, которому
 * зависимость от `@nestjs/*` не нужна.
 *
 * Все комментарии на русском языке.
 */

import type { LoggerService } from '@nestjs/common';
import type pino from 'pino';

/** Адаптер pino под интерфейс логгера NestJS. */
export class PinoLoggerService implements LoggerService {
  /**
   * @param logger - логгер pino
   */
  constructor(private readonly logger: pino.Logger) {}

  /**
   * @param message - сообщение
   * @param params - дополнительный контекст
   */
  log(message: unknown, ...params: unknown[]): void {
    this.logger.info({ params }, String(message));
  }

  /**
   * @param message - сообщение
   * @param params - дополнительный контекст
   */
  error(message: unknown, ...params: unknown[]): void {
    this.logger.error({ params }, String(message));
  }

  /**
   * @param message - сообщение
   * @param params - дополнительный контекст
   */
  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn({ params }, String(message));
  }

  /**
   * @param message - сообщение
   * @param params - дополнительный контекст
   */
  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug({ params }, String(message));
  }

  /**
   * @param message - сообщение
   * @param params - дополнительный контекст
   */
  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.trace({ params }, String(message));
  }
}
