/**
 * Опции конвертации: кодировка, разделитель, параметры листа и отрисовки.
 *
 * Вложенные объекты (`documentLayout`, `spreadsheetLayout`, `documentRenderer`,
 * `thumbnail`) описаны «свободными» схемами: сервер исторически принимает их
 * как произвольный объект и разбирает по известным ключам, игнорируя остальные.
 * Ужесточать здесь нельзя — контракт Р7-Офис внешний, лишнее поле в его
 * запросе не должно приводить к отказу.
 */

import { z } from 'zod';

/** Допустимые кодировки (поле codePage). Нумерация Р7-Офис. */
export const CODE_PAGES = [
  { value: 65001, label: 'UTF-8' },
  { value: 1251, label: 'Windows-1251' },
  { value: 1252, label: 'Windows-1252' },
  { value: 866, label: 'DOS (866)' },
  { value: 20866, label: 'KOI8-R' },
  { value: 28595, label: 'ISO-8859-5' },
] as const;

/** Допустимые разделители CSV (поле delimiter). Нумерация Р7-Офис. */
export const DELIMITERS = [
  { value: 1, label: 'Табуляция' },
  { value: 2, label: 'Точка с запятой (;)' },
  { value: 3, label: 'Пробел' },
  { value: 4, label: 'Запятая (,)' },
] as const;

/** Значения codePage, разрешённые к передаче. */
export const ALLOWED_CODE_PAGES = CODE_PAGES.map((page) => page.value);

/** Значения delimiter, разрешённые к передаче. */
export const ALLOWED_DELIMITERS = DELIMITERS.map((delimiter) => delimiter.value);

/** Код региона вида `ru` или `ru-RU`. */
export const REGION_PATTERN = /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/;

/** Значение кодировки. */
export type CodePage = (typeof CODE_PAGES)[number]['value'];

/** Значение разделителя CSV. */
export type Delimiter = (typeof DELIMITERS)[number]['value'];

/**
 * Схема кодировки: только значения из allowlist.
 *
 * Сообщение об ошибке — это код из контракта, а не текст для человека:
 * сервер отдаёт его клиенту как есть, а интерфейс подбирает формулировку
 * по коду (см. `web/src/api/errors.ts`).
 */
export const codePageSchema = z.number().refine(
  (value) => (ALLOWED_CODE_PAGES as readonly number[]).includes(value),
  { error: 'codePage_not_allowed' }
);

/** Схема разделителя CSV: только значения из allowlist. */
export const delimiterSchema = z.number().refine(
  (value) => (ALLOWED_DELIMITERS as readonly number[]).includes(value),
  { error: 'delimiter_not_allowed' }
);

/** Схема региона. */
export const regionSchema = z
  .string()
  .regex(REGION_PATTERN, { error: 'region_invalid' });

/** Параметры отрисовки документа (поле documentLayout). */
export const documentLayoutSchema = z.looseObject({
  drawPlaceHolders: z.boolean().optional(),
  drawFormHighlight: z.boolean().optional(),
  isPrint: z.boolean().optional(),
});

/** Параметры листа (поле spreadsheetLayout). */
export const spreadsheetLayoutSchema = z.looseObject({
  pageSize: z
    .looseObject({
      width: z.string().optional(),
      height: z.string().optional(),
    })
    .optional(),
  margins: z
    .looseObject({
      left: z.string().optional(),
      right: z.string().optional(),
      top: z.string().optional(),
      bottom: z.string().optional(),
    })
    .optional(),
  fitToWidth: z.number().optional(),
  fitToHeight: z.number().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
});

/** Параметры отрисовщика (поле documentRenderer). */
export const documentRendererSchema = z.looseObject({
  textAssociation: z.string().optional(),
});

/** Миниатюра (поле thumbnail). В текущей версии не обрабатывается. */
export const thumbnailSchema = z.looseObject({});

/** Опции конвертации, общие для запроса и для настроек интерфейса. */
export const conversionOptionsSchema = z.looseObject({
  codePage: codePageSchema.optional(),
  delimiter: delimiterSchema.optional(),
  region: regionSchema.optional(),
  password: z.string().nullable().optional(),
  documentLayout: documentLayoutSchema.optional(),
  spreadsheetLayout: spreadsheetLayoutSchema.optional(),
  documentRenderer: documentRendererSchema.optional(),
  thumbnail: thumbnailSchema.optional(),
});

/** Опции конвертации. */
export type ConversionOptions = z.infer<typeof conversionOptionsSchema>;

/** Параметры отрисовки документа. */
export type DocumentLayout = z.infer<typeof documentLayoutSchema>;

/** Параметры листа. */
export type SpreadsheetLayout = z.infer<typeof spreadsheetLayoutSchema>;
