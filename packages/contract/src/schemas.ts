/**
 * Zod-схемы контракта и выведенные из них типы.
 *
 * Схемы собраны в отдельном модуле намеренно. Валидатор нужен только серверу:
 * он разбирает входящие запросы и проверяет параметры. Веб-интерфейс берёт
 * из контракта типы, константы и рукописные гарды (`isHealthResponse` и
 * соседние), а ответы сервера разбирает ими — тащить ради этого в браузер
 * весь zod незачем.
 *
 * Пока схемы лежали вперемешку с константами, любой импорт из `formats.ts`
 * или `conversion.ts` тянул за собой `zod`: сборщик не может доказать, что
 * вызов `z.object({...})` на верхнем уровне не имеет побочных эффектов,
 * и оставляет его вместе с импортом валидатора. Здесь же схемы изолированы,
 * и модули с константами остаются чистыми.
 *
 * Типы выводятся из схем (`z.infer`) и живут рядом с ними; модули, которым
 * тип нужен, импортируют его через `import type` — такой импорт стирается
 * при сборке и рантайм-связи не создаёт.
 */

import { z } from 'zod';
import { INPUT_FORMATS } from './formats.js';
import { COMPLEXITY_TIERS, JOB_STATUSES } from './jobs.js';
import { PDF_VERSIONS } from './conversion.js';

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
   *
   * Действует только на книги Excel: `ScaleToPages*` — свойства страничного
   * стиля Calc, у документа Writer их нет, и «уместить весь документ
   * на одну страницу» его смыслом не является. Для DOCX параметр
   * игнорируется.
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

  /**
   * Экспортировать закладки.
   *
   * У книги это закладки по листам, у документа Word — по заголовкам:
   * FilterData `ExportBookmarks` у обоих экспортёров общий, различается
   * только то, что попадает в дерево.
   */
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
  /** Формат входного файла, определённый по содержимому контейнера. */
  inputFormat: z.enum(INPUT_FORMATS),
  /** Число листов книги, если его удалось определить; у DOCX всегда null. */
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
  /**
   * Формат входного файла.
   *
   * Необязателен: записи о задачах живут в Redis сутки, и после обновления
   * сервиса среди них есть созданные до появления поля.
   */
  inputFormat: z.enum(INPUT_FORMATS).optional(),
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

/**
 * Тело ответа об ошибке.
 *
 * `jobId` присутствует не всегда: его добавляют только ошибки, привязанные
 * к конкретной задаче. `requestId` сервер добавляет для сверки с логами.
 */
export const apiErrorBodySchema = z.looseObject({
  error: z.string(),
  message: z.string(),
  jobId: z.string().optional(),
  requestId: z.string().optional(),
});

/** Тело ответа об ошибке. */
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/**
 * Ответ проверки доступности.
 *
 * `storage` — доступность объектного хранилища (MinIO/S3). Проверка дешёвая
 * (запрос к сервису), в отличие от готовности конвертера: её проверяет
 * отдельный процесс healthcheck контейнера воркера, подключаясь к UNO.
 */
export const healthResponseSchema = z.looseObject({
  status: z.string(),
  storage: z.boolean(),
  version: z.string(),
});

/** Ответ проверки доступности. */
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ===========================================================================
// Перечисления, используемые только схемами
// ===========================================================================

/** Схема уровня сложности — для разбора значений из очереди и статуса. */
export const complexityTierSchema = z.enum(COMPLEXITY_TIERS);

/** Схема состояния задачи. */
export const jobStatusSchema = z.enum(JOB_STATUSES);
