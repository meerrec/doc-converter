/**
 * Согласованность рукописных гардов и zod-схем контракта.
 *
 * Веб-интерфейс разбирает ответы сервера гардами (`isHealthResponse`
 * и соседние), а не схемами: валидатор нужен только серверу, и держать его
 * в клиентском бандле незачем (см. `packages/contract/src/schemas.ts`).
 * Типы по-прежнему выводятся из схем, но рантайм-проверка у сторон теперь
 * разная — и разойтись они могут молча.
 *
 * Этот набор закрывает расхождение: для каждой пары «схема — гард» берётся
 * валидный образец и производятся искажения (пропущенное поле, поле неверного
 * типа, чужие типы целиком), после чего результаты сверяются. Проверяется
 * именно согласие вердиктов, а не конкретный ответ: обе стороны вправе
 * отвергать по-разному, но принимать должны одно и то же.
 */

import { describe, it, expect } from 'vitest';
import {
  healthResponseSchema,
  isHealthResponse,
  apiErrorBodySchema,
  isApiErrorBody,
  convertAcceptedSchema,
  isConvertAccepted,
  jobStatusResponseSchema,
  isJobStatusResponse,
} from '@doc-converter/contract';

/** Значения, которые не являются объектами ни для схемы, ни для гарда. */
const NON_OBJECTS = [
  ['null', null],
  ['undefined', undefined],
  ['число', 42],
  ['строка', 'не объект'],
  ['массив', []],
  ['true', true],
];

/**
 * Производит искажения валидного образца.
 *
 * @param sample - валидный образец ответа
 * @returns список пар «описание — значение»
 */
function distortions(sample) {
  const cases = [...NON_OBJECTS];

  for (const key of Object.keys(sample)) {
    const missing = { ...sample };
    delete missing[key];
    cases.push([`без поля ${key}`, missing]);

    cases.push([`поле ${key} неверного типа`, { ...sample, [key]: { bad: true } }]);
  }

  return cases;
}

/**
 * Сверяет вердикты схемы и гарда на одном значении.
 *
 * @param schema - zod-схема контракта
 * @param guard - рукописный гард
 * @param samples - валидные образцы для производства искажений
 */
function expectAgreement(schema, guard, samples) {
  for (const sample of samples) {
    const parsed = schema.safeParse(sample);
    expect(parsed.success, `схема отвергла валидный образец: ${JSON.stringify(sample)}`).toBe(
      true
    );
    expect(guard(sample), `гард отверг валидный образец: ${JSON.stringify(sample)}`).toBe(true);

    for (const [description, value] of distortions(sample)) {
      const schemaVerdict = schema.safeParse(value).success;
      const guardVerdict = guard(value);

      expect(
        guardVerdict,
        `расхождение на «${description}»: схема — ${schemaVerdict}, гард — ${guardVerdict}`
      ).toBe(schemaVerdict);
    }
  }
}

describe('гарды контракта', () => {
  it('isHealthResponse совпадает со схемой', () => {
    expectAgreement(healthResponseSchema, isHealthResponse, [
      { status: 'ok', storage: true, version: '1.0.0' },
    ]);
  });

  it('isApiErrorBody совпадает со схемой', () => {
    expectAgreement(apiErrorBodySchema, isApiErrorBody, [
      // Минимальное тело: jobId и requestId необязательны
      { error: 'file_required', message: 'Файл не передан' },
      // Полное тело: так отвечает ошибка, привязанная к задаче
      {
        error: 'conversion_failed',
        message: 'Конвертация не удалась',
        jobId: '3f1a2b4c-0000-4000-8000-000000000000',
        requestId: 'req-1',
      },
    ]);
  });

  it('isConvertAccepted совпадает со схемой', () => {
    expectAgreement(convertAcceptedSchema, isConvertAccepted, [
      {
        jobId: '3f1a2b4c-0000-4000-8000-000000000000',
        status: 'queued',
        tier: 'light',
        queue: 'xlsx2pdf.light',
        inputFormat: 'xlsx',
        sheets: 3,
        sizeBytes: 1024,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      // У документа Word число листов не определяется — приходит null
      {
        jobId: '3f1a2b4c-0000-4000-8000-000000000001',
        status: 'processing',
        tier: 'heavy',
        queue: 'xlsx2pdf.heavy',
        inputFormat: 'docx',
        sheets: null,
        sizeBytes: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('isJobStatusResponse совпадает со схемой', () => {
    expectAgreement(jobStatusResponseSchema, isJobStatusResponse, [
      // Задача в очереди: необязательных полей ещё нет
      {
        jobId: '3f1a2b4c-0000-4000-8000-000000000000',
        status: 'queued',
        tier: 'light',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      // Завершённая задача со ссылкой на результат
      {
        jobId: '3f1a2b4c-0000-4000-8000-000000000001',
        status: 'completed',
        tier: 'medium',
        inputFormat: 'docx',
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
        finishedAt: '2026-01-01T00:00:05.000Z',
        result: {
          url: 'https://minio.example/result.pdf?signature=abc',
          expiresAt: '2026-01-01T01:00:00.000Z',
          sizeBytes: 2048,
        },
      },
      // Упавшая задача с кодом ошибки
      {
        jobId: '3f1a2b4c-0000-4000-8000-000000000002',
        status: 'failed',
        tier: 'heavy',
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:02.000Z',
        error: { code: 'conversion_failed', message: 'Конвертация не удалась' },
      },
    ]);
  });
});
