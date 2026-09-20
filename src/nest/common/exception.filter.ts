/**
 * Фильтр исключений: единый формат ошибок API.
 *
 * Nest по умолчанию отвечает `{ statusCode, message, error }`, что не совпадает
 * с контрактом сервиса (`packages/contract/src/errors.ts`). Здесь ответ
 * приводится к виду `{ error, message, jobId?, requestId? }`, где `error` —
 * код в snake_case.
 *
 * Всё, что не является `AppError` или `HttpException`, отдаётся как 500
 * с общим текстом: раньше в ответ попадали `err.message` и системный
 * `err.code` вроде `ENOENT`, раскрывая внутреннее устройство сервиса.
 *
 * Все комментарии на русском языке.
 */

import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isErrorCode, type ApiErrorBody } from '@doc-converter/contract';
import { isAppError } from './app-error.js';
import type { RequestWithId } from './request-id.middleware.js';

/**
 * Коды Nest, которые переиспользуют коды контракта.
 *
 * Nest отвечает своим набором (`Not Found`, `Payload Too Large`) и не знает
 * про контракт сервиса, поэтому соответствие задаётся здесь.
 */
const HTTP_STATUS_TO_CODE: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  // 404 у Nest означает неизвестный маршрут. Отсутствие задачи — это
  // `job_not_found`, и его бросает сервис как AppError со своим кодом
  404: 'not_found',
  413: 'file_too_large',
  429: 'rate_limited',
};

/** Фильтр исключений приложения. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  /**
   * @param exception - пойманное исключение
   * @param host - контекст выполнения
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & Partial<RequestWithId>>();

    const requestId = request.requestId;

    // Заголовки могли быть отправлены (например, при разрыве соединения
    // клиентом) — повторная запись бросит ERR_HTTP_HEADERS_SENT
    if (response.headersSent) {
      return;
    }

    if (isAppError(exception)) {
      const body: ApiErrorBody = {
        error: exception.code,
        message: exception.message,
        ...(exception.jobId ? { jobId: exception.jobId } : {}),
        ...(requestId ? { requestId } : {}),
      };

      response.status(exception.statusCode).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const mapped = HTTP_STATUS_TO_CODE[status] ?? 'invalid_request';

      const body: ApiErrorBody = {
        error: isErrorCode(mapped) ? mapped : 'internal',
        message: exception.message,
        ...(requestId ? { requestId } : {}),
      };

      response.status(status).json(body);
      return;
    }

    // Неизвестное исключение: подробности только в лог, клиенту — общий ответ
    this.logger.error(
      `Необработанная ошибка: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined
    );

    const body: ApiErrorBody = {
      error: 'internal',
      message: 'Внутренняя ошибка сервиса',
      ...(requestId ? { requestId } : {}),
    };

    response.status(500).json(body);
  }
}
