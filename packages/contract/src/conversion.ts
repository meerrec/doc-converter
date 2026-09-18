/**
 * Контракт маршрута POST /ConvertService.ashx.
 *
 * Схема повторяет правила из `src/api/middleware/validate.js`: только известные
 * поля (иначе `unknown_field`), ровно один источник (`url` или `data`), allowlist
 * форматов, шаблон ключа и длины. Порядок проверок сохранён — от него зависит,
 * какой код ошибки увидит клиент при нескольких нарушениях сразу.
 */

import { z } from 'zod';
import {
  codePageSchema,
  delimiterSchema,
  regionSchema,
  documentLayoutSchema,
  documentRendererSchema,
  spreadsheetLayoutSchema,
  thumbnailSchema,
} from './options.js';
import { inputFormatSet, outputFormatSet } from './formats.js';
import { taskResultSchema } from './status.js';

/**
 * Максимальная длина названия документа.
 *
 * Обоснование: 255 — предел, после которого имя перестаёт помещаться
 * в большинство файловых систем и в поле title Р7-Офис.
 */
export const TITLE_MAX_LENGTH = 255;

/**
 * Шаблон ключа задачи: буквы, цифры, точка, подчёркивание и дефис.
 *
 * Обоснование: ключ попадает в имя файла результата и в ключи Valkey,
 * поэтому разделители путей и спецсимволы запрещены.
 *
 * Внимание: схема допускает 128 символов, тогда как `reserveTaskId`
 * в `queue/idempotency.js` отвергает всё длиннее 64 — ключ длиной 65–128
 * проходит валидацию и падает с 500. Расхождение известно и должно быть
 * устранено на стороне сервера, а не сужением контракта.
 */
export const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Схема входного формата: только значения из allowlist, без учёта регистра. */
export const inputFormatSchema = z
  .string()
  .refine((value) => inputFormatSet.has(value.toLowerCase()), {
    error: 'input_format_not_allowed',
  });

/** Схема формата результата: только значения из allowlist, без учёта регистра. */
export const outputFormatSchema = z
  .string()
  .refine((value) => outputFormatSet.has(value.toLowerCase()), {
    error: 'output_format_not_allowed',
  });

/** Схема ключа задачи. */
export const keySchema = z.string().regex(KEY_PATTERN, { error: 'key_invalid_chars' });

/** Схема названия документа. */
export const titleSchema = z
  .string()
  .max(TITLE_MAX_LENGTH, { error: 'title_too_long' });

/**
 * Тело запроса POST /ConvertService.ashx.
 *
 * ## Расхождения с текущим поведением сервера
 *
 * Схема строже серверной в трёх местах. Это осознанно: перечисленные случаи —
 * следствие проверок по «истинности» значения в `validate.js`, а не задуманное
 * правило. При переходе сервера на контракт (этап переноса на NestJS) поведение
 * изменится, и это нужно подтвердить отдельно, потому что контракт Р7 внешний.
 *
 * 1. `async` объявлен как `default: false`, но значение по умолчанию нигде
 *    не применяется, а ветвление идёт по истинности. Опущенное поле равносильно
 *    `false` **кроме** проверки `async === false && !SYNC_ENABLED`: при
 *    `SYNC_ENABLED=false` запрос без поля уходит в синхронный путь, хотя
 *    синхронный режим выключен. Здесь поля нет в значении по умолчанию —
 *    решение остаётся за сервером.
 * 2. `key: ''` проходит серверную проверку: условие `body.key && …` ложно для
 *    пустой строки, поэтому шаблон не применяется, а `validated.key || randomUUID()`
 *    подставляет сгенерированный идентификатор. Схема пустую строку отвергает.
 * 3. `codePage: 0` и `delimiter: 0` проходят серверную проверку по той же
 *    причине и падают позже — уже в `optionsMapper`. Схема отвергает их сразу.
 */
export const conversionRequestSchema = z
  .strictObject({
    /** Формат входного файла. */
    filetype: inputFormatSchema,
    /** Формат результата. */
    outputtype: outputFormatSchema,
    /** Ссылка на файл; взаимоисключающе с `data`. */
    url: z.string().optional(),
    /** Содержимое файла в base64; взаимоисключающе с `url`. */
    data: z.string().optional(),
    /** true — конвертация через очередь, false или пусто — синхронно. */
    async: z.boolean().optional(),
    /** Идентификатор задачи; он же ключ идемпотентности. */
    key: keySchema.optional(),
    /** Имя документа. */
    title: titleSchema.optional(),

    codePage: codePageSchema.optional(),
    delimiter: delimiterSchema.optional(),
    region: regionSchema.optional(),
    password: z.string().nullable().optional(),
    documentLayout: documentLayoutSchema.optional(),
    spreadsheetLayout: spreadsheetLayoutSchema.optional(),
    documentRenderer: documentRendererSchema.optional(),
    thumbnail: thumbnailSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasUrl = value.url !== undefined;
    const hasData = value.data !== undefined;

    if (hasUrl === hasData) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly_one_source_required',
        path: [],
      });
    }
  });

/** Тело запроса POST /ConvertService.ashx. */
export type ConversionRequest = z.infer<typeof conversionRequestSchema>;

/**
 * Все поля, допустимые в запросе.
 *
 * Нужен серверу для проверки «неизвестного поля» до разбора схемой: zod
 * сообщает о лишних ключах последними, а сервис исторически отвечает
 * `unknown_field` первым — раньше, чем о недостающих или неверных типах.
 * Порядок проверок — часть внешнего контракта, поэтому список вынесен явно.
 */
export const CONVERSION_REQUEST_FIELDS = [
  'filetype',
  'outputtype',
  'url',
  'data',
  'async',
  'key',
  'title',
  'codePage',
  'delimiter',
  'region',
  'password',
  'documentLayout',
  'spreadsheetLayout',
  'documentRenderer',
  'thumbnail',
] as const;

/** Обязательные поля запроса. */
export const CONVERSION_REQUIRED_FIELDS = ['filetype', 'outputtype'] as const;

/**
 * Ответ в асинхронном режиме.
 *
 * `status` не всегда `queued`: если задача с таким ключом уже выполнялась,
 * сервер возвращает её текущий статус. Если результат готов — он приходит
 * сразу, и опрашивать статус не нужно.
 */
export const conversionAcceptedSchema = z.looseObject({
  status: z.string(),
  taskId: z.string(),
  message: z.string().optional(),
  result: taskResultSchema.optional(),
});

/** Ответ в асинхронном режиме. */
export type ConversionAcceptedResponse = z.infer<typeof conversionAcceptedSchema>;
