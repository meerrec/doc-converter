/**
 * Логгер приложения на pino.
 *
 * `nestjs-pino` не подошёл: пакет поставляет исходники на TypeScript
 * и рассчитывает на сборщик. Прямое подключение `pino`
 * и `pino-http` повторяет то, как логирование устроено в Express-версии,
 * и не тянет лишнюю зависимость.
 *
 * Загрузка идёт через `createRequire`, а не через `import`: объявления типов
 * у этих пакетов не экспортируют вызываемую функцию, поэтому `import pino
 * from 'pino'` даёт пространство имён без сигнатуры вызова. Типы при этом
 * берутся обычным импортом типов.
 */

import { createRequire } from 'node:module';
import type pino from 'pino';
import type { LoggerService } from '@nestjs/common';

const require = createRequire(import.meta.url);

/** Фабрика логгера pino. */
type PinoFactory = (options: { level: string }) => pino.Logger;

const pinoFactory = require('pino') as PinoFactory;

/**
 * Создаёт логгер pino.
 *
 * @param level - уровень логирования
 * @returns логгер
 */
export function createLogger(level: string): pino.Logger {
  return pinoFactory({ level });
}

/**
 * Адаптер pino под интерфейс логгера NestJS.
 *
 * Нужен, чтобы системные сообщения Nest (старт приложения, инициализация
 * модулей) уходили в тот же поток, что и логи запросов.
 */
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
