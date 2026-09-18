/**
 * Глобальный фильтр ошибок под контракт Р7-Офис.
 *
 * Nest по умолчанию отвечает `{ statusCode, message, error }` — это несовместимо
 * с форматом сервиса `{ error, message, taskId? }`. Контракт внешний (его
 * понимает Р7-Офис и веб-интерфейс), поэтому формат воспроизводится дословно,
 * включая `requestId` для сверки с логами.
 *
 * Ошибки, которые не являются `AppError`, наружу не раскрываются: клиент
 * получает 500 с общим сообщением, а подробности уходят в лог. Раньше
 * в ответ попадали `err.message` и `err.code`, из-за чего системные ошибки
 * (`ENOENT`, `EACCES`) были видны клиенту.
 */

import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ErrorCode } from '@doc-converter/contract';
import { isAppError } from './app-error.js';

/** Тело ответа об ошибке. */
interface ErrorBody {
  error: string;
  message: string;
  taskId?: string;
  requestId?: string;
}

/**
 * Сопоставляет HTTP-статус с кодом контракта.
 *
 * Нужно для исключений, которые порождает сам Nest: например, ограничитель
 * частоты бросает 429, а обработчик ненайденного маршрута — 404.
 *
 * @param status - HTTP-статус
 * @returns код ошибки из контракта
 */
function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 404:
      return 'not_found';
    case 408:
      return 'body_timeout';
    case 413:
      return 'file_too_large';
    case 429:
      return 'rate_limited';
    default:
      return 'internal';
  }
}

/** Приводит ошибку к телу ответа и HTTP-статусу. */
@Catch()
export class R7ExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(R7ExceptionFilter.name);

  /**
   * @param exception - пойманное исключение
   * @param host - контекст выполнения
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = (request as Request & { requestId?: string }).requestId;
    let status = 500;
    let code: ErrorCode = 'internal';
    let message = 'Internal server error';
    let taskId: string | undefined;

    if (isAppError(exception)) {
      status = exception.statusCode;
      code = exception.code;
      message = exception.message;
      taskId = exception.taskId;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeFromStatus(status);
      // Сообщения исключений Nest безопасны — они не несут внутренних деталей
      const response_ = exception.getResponse();
      message =
        typeof response_ === 'string'
          ? response_
          : ((response_ as { message?: string | string[] }).message as string) ??
            exception.message;

      if (Array.isArray(message)) {
        message = message.join('; ');
      }
    }

    // Подробности — только в лог: наружу уходит обезличенное сообщение
    if (status >= 500) {
      this.logger.error(
        {
          err: exception,
          path: request.path,
          method: request.method,
          requestId,
        },
        'Необработанная ошибка'
      );
    }

    const body: ErrorBody = { error: code, message };

    if (taskId !== undefined) {
      body.taskId = taskId;
    }

    if (requestId !== undefined) {
      body.requestId = requestId;
    }

    response.status(status).json(body);
  }
}
