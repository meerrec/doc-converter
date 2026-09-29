/**
 * Тексты отказов браузерного пути.
 *
 * Тексты лежат в движке, а не в интерфейсе: знание о том, что означает
 * каждый код, есть только у него, а UI видит лишь исключение.
 *
 * Все комментарии на русском языке.
 */

import { EngineError, ENGINE_ERROR_MESSAGES } from './engine/errors.js';

/**
 * Приводит исключение к тексту для пользователя.
 *
 * @param error - пойманное исключение
 * @returns сообщение
 */
export function describeError(error: unknown): string {
  if (error instanceof EngineError) {
    return ENGINE_ERROR_MESSAGES[error.code];
  }

  return error instanceof Error ? error.message : String(error);
}
