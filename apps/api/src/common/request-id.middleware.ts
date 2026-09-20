/**
 * Идентификатор запроса для сквозной корреляции логов.
 *
 * Если клиент передал `X-Request-Id`, он переиспользуется — так сохраняется
 * цепочка «браузер → nginx → API». Иначе генерируется новый UUID. Значение
 * доступно обработчикам как `req.requestId` и уходит в заголовке ответа,
 * а также попадает в тело ошибки (см. `R7ExceptionFilter`).
 *
 * Длина ограничена: значение приходит снаружи и попадает в логи и в ответ,
 * поэтому неограниченная строка — это лишний способ нагрузить хранилище логов.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Предельная длина принимаемого идентификатора. */
const MAX_REQUEST_ID_LENGTH = 200;

/** Запрос с идентификатором. */
export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Проставляет идентификатор запроса и возвращает его в заголовке.
 *
 * @param req - входящий запрос
 * @param res - ответ
 * @param next - следующий обработчик
 */
export function requestIdMiddleware(
  req: RequestWithId,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers['x-request-id'];
  const clientId = Array.isArray(header) ? header[0] : header;

  const requestId =
    clientId && clientId.length > 0 && clientId.length <= MAX_REQUEST_ID_LENGTH
      ? clientId
      : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  next();
}
