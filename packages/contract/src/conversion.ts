/**
 * Контракт маршрутов конвертации XLSX → PDF.
 *
 * `POST /convert/xlsx-to-pdf` принимает файл в multipart/form-data, поэтому
 * все необязательные параметры приходят строками. Схемы это учитывают:
 * булевы и числовые поля разбираются из строк явно, а не через `z.coerce`,
 * который превратил бы строку `"false"` в `true` (любая непустая строка
 * для него истинна).
 */

import { z } from 'zod';
import { COMPLEXITY_TIERS, JOB_STATUSES } from './jobs.js';

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
// Разбор полей multipart
// ===========================================================================

/**
 * Разбирает булево значение, пришедшее строкой.
 *
 * Понимает формы, которые встречаются в реальных запросах: `true/false`,
 * `1/0`, `yes/no`, `on/off`. Пустая строка считается `false`: браузерные
 * формы присылают её для снятого флажка.
 */
export const booleanField = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }

    ctx.addIssue({
      code: 'custom',
      message: `Ожидалось булево значение, получено «${value}»`,
    });

    return z.NEVER;
  });

/**
 * Разбирает целое число из строки.
 *
 * @param min - минимальное допустимое значение
 * @param max - максимальное допустимое значение
 */
function integerField(min: number, max: number) {
  return z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(value.trim());

      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: 'custom', message: `Ожидалось целое число, получено «${value}»` });
        return z.NEVER;
      }

      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `Значение должно быть в диапазоне ${min}–${max}, получено ${parsed}`,
        });
        return z.NEVER;
      }

      return parsed;
    });
}

// ===========================================================================
// Параметры конвертации
// ===========================================================================

/**
 * Параметры конвертации — то, что клиент может попросить у экспортёра PDF.
 *
 * Все они необязательны: без них сервис отдаёт PDF с версией по умолчанию,
 * закладками и таблицей, умещённой на одну страницу.
 */
export const conversionOptionsSchema = z.object({
  /**
   * Текст водяного знака. Пустая строка или отсутствие поля — без знака.
   *
   * Ограничение в 200 символов — от экспортёра: длинный текст он разбивает
   * по странице целиком, и знак перестаёт читаться.
   */
  watermark: z.string().max(200, { message: 'invalid_watermark' }).optional(),

  /**
   * Как наносить водяной знак: один по центру страницы или мозаикой.
   *
   * `single` соответствует FilterData `Watermark`, `tiled` — `TiledWatermark`.
   */
  watermarkMode: z.enum(['single', 'tiled']).default('single'),

  /**
   * Умещать содержимое листа на одну страницу.
   *
   * Реализуется через `ScaleToPagesX = ScaleToPagesY = 1` в страничном стиле:
   * LibreOffice сам подбирает масштаб. Для очень больших таблиц это делает
   * текст нечитаемым — параметр отключаемый.
   */
  fitToOnePage: booleanField.default(true),

  /** Версия PDF (в том числе PDF/A). */
  pdfVersion: z.enum(PDF_VERSIONS).default('default'),

  /**
   * Качество JPEG-сжатия изображений, 1–100.
   *
   * Действует только при включённом сжатии изображений: без него экспортёр
   * сохраняет изображения без потерь.
   */
  quality: integerField(1, 100).default(90),

  /** Пережимать изображения с понижением разрешения. */
  reduceImageResolution: booleanField.default(true),

  /**
   * Предельное разрешение изображений в DPI, 50–1200.
   *
   * Значение выше исходного не увеличивает картинку: экспортёр только
   * понижает разрешение.
   */
  maxImageResolution: integerField(50, 1200).default(300),

  /** Экспортировать закладки по листам книги. */
  exportBookmarks: booleanField.default(true),

  /** Добавлять теги структуры (требуется для доступности PDF/A). */
  taggedPdf: booleanField.default(false),

  /** Пароль на открытие PDF. */
  userPassword: z.string().max(128).optional(),

  /** Пароль владельца — им снимаются ограничения на печать и изменение. */
  ownerPassword: z.string().max(128).optional(),

  /** Включить ограничения прав (печать, изменение, копирование). */
  restrictPermissions: booleanField.default(false),

  /** Разрешить печать при включённых ограничениях. */
  allowPrinting: booleanField.default(true),

  /** Разрешить изменение документа при включённых ограничениях. */
  allowChanges: booleanField.default(false),
});

/** Параметры конвертации. */
export type ConversionOptions = z.infer<typeof conversionOptionsSchema>;

// ===========================================================================
// Ответы
// ===========================================================================

/** Ответ на постановку задачи. */
export const convertAcceptedSchema = z.object({
  jobId: z.string(),
  status: z.enum(JOB_STATUSES),
  tier: z.enum(COMPLEXITY_TIERS),
  /** Имя очереди, в которую попала задача — для диагностики. */
  queue: z.string(),
  /** Число листов книги, если его удалось определить. */
  sheets: z.number().int().nonnegative().nullable(),
  /** Размер принятого файла в байтах. */
  sizeBytes: z.number().int().nonnegative(),
  /** Время постановки в очередь (ISO 8601). */
  createdAt: z.string(),
});

/** Ответ на постановку задачи. */
export type ConvertAccepted = z.infer<typeof convertAcceptedSchema>;

/** Ссылка на готовый результат. */
export const jobResultSchema = z.object({
  /** Presigned URL — ссылка живёт ограниченное время. */
  url: z.string(),
  /** Момент истечения ссылки (ISO 8601). */
  expiresAt: z.string(),
  /** Размер PDF в байтах. */
  sizeBytes: z.number().int().nonnegative(),
});

/** Ссылка на готовый результат. */
export type JobResult = z.infer<typeof jobResultSchema>;

/** Ответ о состоянии задачи. */
export const jobStatusResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(JOB_STATUSES),
  tier: z.enum(COMPLEXITY_TIERS),
  createdAt: z.string(),
  /** Момент, когда воркер взял задачу. */
  startedAt: z.string().optional(),
  /** Момент завершения — успешного или нет. */
  finishedAt: z.string().optional(),
  /** Код и текст ошибки при `failed`. */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  /** Ссылка на результат при `completed`. */
  result: jobResultSchema.optional(),
});

/** Ответ о состоянии задачи. */
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
