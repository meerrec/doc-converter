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
 *
 * Адаптер под интерфейс логгера NestJS (`LoggerService`) живёт не здесь,
 * а в API: он нужен только ему, а этот пакет читает и воркер, которому
 * зависимость от `@nestjs/*` ни к чему.
 */

import { createRequire } from 'node:module';
import type pino from 'pino';

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
