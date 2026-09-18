/**
 * Ошибка приложения с кодом из контракта.
 *
 * Заменяет практику, при которой обработчик ошибок брал `err.code` наугад:
 * у системных ошибок Node в этом поле лежит `ENOENT`, `EACCES` и подобное,
 * и такое значение уходило клиенту в поле `error` ответа. Здесь код —
 * типизированное значение из `packages/contract`, а всё, что не является
 * `AppError`, фильтр превращает в 500 без подробностей.
 */

import type { ErrorCode } from '@doc-converter/contract';

/** Ошибка с кодом контракта и HTTP-статусом. */
export class AppError extends Error {
  /**
   * @param code - код ошибки из контракта
   * @param message - сообщение для клиента
   * @param statusCode - HTTP-статус ответа
   * @param taskId - идентификатор задачи, если ошибка к ней привязана
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number = 400,
    readonly taskId?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Проверяет, что значение является `AppError`.
 *
 * @param error - проверяемое значение
 * @returns true, если это ошибка приложения
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
