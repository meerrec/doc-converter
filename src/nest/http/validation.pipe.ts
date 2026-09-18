/**
 * Валидация тела запроса по схеме контракта.
 *
 * Порядок проверок воспроизводит серверный: сначала неизвестные поля,
 * затем отсутствующие обязательные, затем всё остальное схемой. Zod сообщает
 * о лишних ключах последними, поэтому проверка `unknown_field` выполняется
 * до разбора — иначе при запросе с лишним полем и опечаткой в имени формата
 * клиент получил бы другой код, чем раньше.
 */

import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import {
  CONVERSION_REQUEST_FIELDS,
  CONVERSION_REQUIRED_FIELDS,
  isErrorCode,
  type ErrorCode,
} from '@doc-converter/contract';
import { AppError } from '../common/app-error.js';

/** Поля, допустимые в запросе на конвертацию. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(CONVERSION_REQUEST_FIELDS);

/**
 * Приводит сообщение схемы к коду ошибки контракта.
 *
 * В схемах контракта коды записаны прямо в сообщениях (`key_invalid_chars`,
 * `region_invalid` и прочие): так одна и та же схема служит и валидатором,
 * и источником кода для ответа.
 *
 * @param error - ошибка разбора
 * @returns код ошибки
 */
function codeFromError(error: {
  issues: Array<{ code: string; message: string; path: PropertyKey[] }>;
}): ErrorCode {
  const issue = error.issues[0];

  if (!issue) {
    return 'invalid_request';
  }

  if (issue.code === 'unrecognized_keys') {
    return 'unknown_field';
  }

  // Отсутствующее поле приходит как несоответствие типа с input === undefined
  if (issue.code === 'invalid_type' && 'input' in issue && issue.input === undefined) {
    const field = String(issue.path[0] ?? '');

    if (field === 'filetype' || field === 'outputtype') {
      return `${field}_required`;
    }
  }

  return isErrorCode(issue.message) ? issue.message : 'field_type_mismatch';
}

/** Пайп валидации тела запроса на конвертацию. */
@Injectable()
export class ConversionRequestPipe implements PipeTransform {
  /**
   * @param schema - схема запроса из контракта
   */
  constructor(private readonly schema: ZodType) {}

  /**
   * Проверяет и разбирает тело запроса.
   *
   * @param value - тело запроса
   * @returns разобранное тело
   * @throws {AppError} - если запрос не прошёл проверку
   */
  transform(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AppError('invalid_request', 'Тело запроса должно быть объектом', 400);
    }

    const body = value as Record<string, unknown>;

    for (const field of Object.keys(body)) {
      if (!KNOWN_FIELDS.has(field)) {
        throw new AppError('unknown_field', `Неизвестное поле: ${field}`, 400);
      }
    }

    for (const field of CONVERSION_REQUIRED_FIELDS) {
      if (body[field] === undefined || body[field] === null) {
        throw new AppError(`${field}_required`, `Поле ${field} обязательно`, 400);
      }
    }

    const result = this.schema.safeParse(body);

    if (!result.success) {
      const code = codeFromError(result.error);

      throw new AppError(code, result.error.issues[0]?.message ?? code, 400);
    }

    return result.data;
  }
}
