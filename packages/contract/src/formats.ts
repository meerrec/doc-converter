/**
 * Форматы документов сервиса.
 *
 * Сервис конвертирует электронные таблицы в PDF, поэтому списки форматов
 * схлопнуты до одного направления. Раньше здесь были все форматы Р7-Офис:
 * вместе с переходом на LibreOffice + UNO они больше не поддерживаются,
 * а держать неиспользуемые списки — значит обещать клиенту то, чего нет.
 */

/**
 * Форматы, принимаемые на вход.
 *
 * Только XLSX. Старый бинарный `.xls` убран: он не является zip-контейнером,
 * поэтому не проходит zip-гард, а его структура (OLE2/CFB) проверялась лишь
 * восемью байтами сигнатуры — то есть у него была несопоставимо более слабая
 * защита, чем у XLSX, и атакующему достаточно было выбрать формат. Через
 * `.xls` приходили и макросы Excel 4.0, которых в XLSX не бывает.
 */
export const INPUT_FORMATS = ['xlsx'] as const;

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
