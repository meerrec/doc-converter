/**
 * Контракт маршрута GET /health.
 */

import type { HealthResponse } from './schemas.js';

/**
 * Проверяет, что значение — ответ проверки доступности.
 *
 * Гард повторяет схему `healthResponseSchema` из `schemas.ts` для
 * потребителей, которым рантайм-zod не нужен: веб-интерфейс разбирает ответы
 * сервера, но не валидирует запросы, и тащить ради этого весь валидатор
 * в браузер незачем. Тип по-прежнему выводится из схемы, а за согласованностью
 * гарда и схемы следит `tests/contract-guards.test.js`.
 *
 * Лишние поля допускаются: схема объявлена как `looseObject`, и сервер вправе
 * добавить поле, не ломая уже собранный клиент.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является ответом проверки доступности
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;

  return (
    typeof body['status'] === 'string' &&
    typeof body['storage'] === 'boolean' &&
    typeof body['version'] === 'string'
  );
}
