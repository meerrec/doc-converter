/**
 * Форматы документов сервиса.
 *
 * Конвертация идёт в одном направлении — в PDF, — поэтому списки форматов
 * схлопнуты до входа и результата. Раньше здесь были все форматы Р7-Офис:
 * вместе с переходом на LibreOffice + UNO они больше не поддерживаются,
 * а держать неиспользуемые списки — значит обещать клиенту то, чего нет.
 */

/**
 * Форматы, принимаемые на вход.
 *
 * Книга Excel и текстовый документ Word. Оба — контейнеры OOXML, то есть
 * zip: проверки архива и лимиты у них общие, а различает их содержимое
 * (`apps/api/src/security/ooxml.ts`), потому что сигнатура у обоих одна
 * и та же — `PK\x03\x04`.
 *
 * Старые бинарные `.xls` и `.doc` убраны: они не являются zip-контейнерами,
 * поэтому не проходят zip-гард, а их структура (OLE2/CFB) проверялась лишь
 * восемью байтами сигнатуры — то есть у них была несопоставимо более слабая
 * защита, чем у OOXML, и атакующему достаточно было выбрать формат. Через
 * `.xls` приходили и макросы Excel 4.0, которых в XLSX не бывает.
 */
export const INPUT_FORMATS = ['xlsx', 'docx'] as const;

/** Форматы результата. Оставлен списком ради расширения (например, PDF/A). */
export const OUTPUT_FORMATS = ['pdf'] as const;

/** Формат входного файла. */
export type InputFormat = (typeof INPUT_FORMATS)[number];

/** Формат результата. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Расширение файла для формата результата.
 *
 * Отдельная карта, а не строка формата: у результата бывают форматы-синонимы
 * (например, `pdfa` сохраняется как `.pdf`), и подстановка имени файла должна
 * брать расширение отсюда, а не из значения поля.
 */
export const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  pdf: 'pdf',
};

/** MIME-типы входных форматов. */
export const INPUT_MIME_TYPES: Readonly<Record<InputFormat, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** MIME-тип результата. */
export const PDF_MIME_TYPE = 'application/pdf';

/**
 * Проверяет, что значение — поддерживаемый входной формат.
 *
 * @param value - проверяемое значение
 * @returns true, если формат поддерживается
 */
export function isInputFormat(value: unknown): value is InputFormat {
  return typeof value === 'string' && (INPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Проверяет, что значение — поддерживаемый формат результата.
 *
 * @param value - проверяемое значение
 * @returns true, если формат поддерживается
 */
export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && (OUTPUT_FORMATS as readonly string[]).includes(value);
}
