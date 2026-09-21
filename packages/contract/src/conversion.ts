/**
 * Контракт маршрутов конвертации в PDF: версии PDF и разбор ответов.
 *
 * Zod-схем запроса и ответов здесь нет намеренно — они живут в `schemas.ts`
 * вместе с остальными схемами контракта. Причина в том, что схемы нужны
 * только серверу, а этот модуль импортирует веб-интерфейс: пока вызов
 * `z.object({...})` стоял на верхнем уровне, сборщик оставлял его вместе
 * с импортом валидатора, и весь zod попадал в клиентский бандл. Подробнее —
 * в комментарии к `schemas.ts`.
 *
 * Гарды дублируют проверки схем: типы по-прежнему выводятся из схем,
 * а за согласованностью следит `tests/contract-guards.test.js`.
 */

import { isInputFormat } from './formats.js';
import { isComplexityTier, isJobStatus } from './jobs.js';
import type { ConvertAccepted, JobResult, JobStatusResponse } from './schemas.js';

// ===========================================================================
// Версии PDF
// ===========================================================================

/**
 * Версии PDF, доступные клиенту.
 *
 * Список ограничен тем, что реально умеет `SelectPdfVersion` в LibreOffice:
 * версия по умолчанию (1.6) и три варианта PDF/A. Выбор PDF 1.4–1.7 через
 * FilterData невозможен — проверено перебором значений на LibreOffice 7.4:
 * коды 4 и выше дают тот же файл, что и 0. Обещать в API то, чего экспортёр
 * не делает, хуже, чем не предлагать вариант вовсе.
 *
 * Имена — то, что видит пользователь; числа для FilterData заданы отдельной
 * картой ниже.
 */
export const PDF_VERSIONS = ['default', 'pdfa-1a', 'pdfa-2b', 'pdfa-3b'] as const;

/** Версия PDF. */
export type PdfVersion = (typeof PDF_VERSIONS)[number];

/**
 * Числовые коды `SelectPdfVersion` для FilterData экспортёра PDF.
 *
 * Соответствие проверено на LibreOffice 7.4: 0 — версия по умолчанию,
 * 1 — PDF/A-1a, 2 — PDF/A-2b, 3 — PDF/A-3b. Прочие значения экспортёр
 * игнорирует.
 */
export const PDF_VERSION_CODES: Readonly<Record<PdfVersion, number>> = {
  default: 0,
  'pdfa-1a': 1,
  'pdfa-2b': 2,
  'pdfa-3b': 3,
};

// ===========================================================================
// Гарды ответов
// ===========================================================================

/**
 * Проверяет, что значение — неотрицательное целое число.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является неотрицательным целым
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Проверяет, что значение — ссылка на готовый результат.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является ссылкой на результат
 */
function isJobResult(value: unknown): value is JobResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    typeof result['url'] === 'string' &&
    typeof result['expiresAt'] === 'string' &&
    isNonNegativeInteger(result['sizeBytes'])
  );
}

/**
 * Проверяет, что значение — ответ на постановку задачи.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является ответом на постановку задачи
 */
export function isConvertAccepted(value: unknown): value is ConvertAccepted {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;

  return (
    typeof body['jobId'] === 'string' &&
    isJobStatus(body['status']) &&
    isComplexityTier(body['tier']) &&
    typeof body['queue'] === 'string' &&
    isInputFormat(body['inputFormat']) &&
    // У книги это число листов, у документа Word — всегда null
    (body['sheets'] === null || isNonNegativeInteger(body['sheets'])) &&
    isNonNegativeInteger(body['sizeBytes']) &&
    typeof body['createdAt'] === 'string'
  );
}

/**
 * Проверяет, что значение — ответ о состоянии задачи.
 *
 * @param value - проверяемое значение
 * @returns true, если значение является ответом о состоянии задачи
 */
export function isJobStatusResponse(value: unknown): value is JobStatusResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  const error = body['error'];

  return (
    typeof body['jobId'] === 'string' &&
    isJobStatus(body['status']) &&
    isComplexityTier(body['tier']) &&
    (body['inputFormat'] === undefined || isInputFormat(body['inputFormat'])) &&
    typeof body['createdAt'] === 'string' &&
    (body['startedAt'] === undefined || typeof body['startedAt'] === 'string') &&
    (body['finishedAt'] === undefined || typeof body['finishedAt'] === 'string') &&
    (error === undefined ||
      (typeof error === 'object' &&
        error !== null &&
        typeof (error as Record<string, unknown>)['code'] === 'string' &&
        typeof (error as Record<string, unknown>)['message'] === 'string')) &&
    (body['result'] === undefined || isJobResult(body['result']))
  );
}
