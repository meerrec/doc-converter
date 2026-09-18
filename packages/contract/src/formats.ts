/**
 * Форматы документов и их характеристики.
 *
 * Единственный источник правды по форматам. До появления контракта одни и те же
 * списки были продублированы в четырёх местах: `api/middleware/validate.js`
 * (allowlist), `security/magicBytes.js` (сигнатуры), `worker/converter.js`
 * (карта расширений) и `web/src/config.ts` (списки и подписи интерфейса).
 */

/** Форматы, принимаемые на вход. */
export const INPUT_FORMATS = [
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'txt', 'html', 'htm', 'csv', 'pdf', 'epub',
] as const;

/** Форматы результата. */
export const OUTPUT_FORMATS = [
  'pdf', 'pdfa', 'docx', 'xlsx', 'csv', 'txt', 'html',
  'png', 'jpg', 'jpeg', 'svg', 'odt', 'ods', 'odp', 'rtf', 'epub',
] as const;

/** Формат входного файла. */
export type InputFormat = (typeof INPUT_FORMATS)[number];

/** Формат результата. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Форматы, содержимое которых проверяется как ZIP-контейнер. */
export const ZIP_CONTAINER_FORMATS = [
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub',
] as const;

/** Форматы, для которых имеет смысл выбор кодировки (codePage). */
export const TEXT_INPUT_FORMATS = ['txt', 'csv', 'html', 'htm'] as const;

/** Формат, для которого имеет смысл выбор разделителя (delimiter). */
export const CSV_FORMAT = 'csv';

/** Форматы, для которых имеют смысл ориентация и параметры листа. */
export const SPREADSHEET_INPUT_FORMATS = ['xls', 'xlsx', 'ods', 'csv'] as const;

/**
 * Расширение файла для формата результата.
 *
 * Отдельные форматы сохраняются под другим расширением: `pdfa` → `pdf`,
 * `jpeg` → `jpg`. Синхронный путь берёт outputtype как есть, поэтому карта
 * нужна именно асинхронному — по ней формируется имя файла в хранилище.
 */
export const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  pdf: 'pdf',
  pdfa: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  doc: 'doc',
  xls: 'xls',
  ppt: 'ppt',
  odt: 'odt',
  ods: 'ods',
  odp: 'odp',
  rtf: 'rtf',
  txt: 'txt',
  csv: 'csv',
  html: 'html',
  htm: 'htm',
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  svg: 'svg',
  epub: 'epub',
};

/** Человекочитаемые названия форматов результата для интерфейса. */
export const OUTPUT_FORMAT_LABELS: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  pdfa: 'PDF/A (архивный)',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  csv: 'CSV',
  txt: 'Текст',
  html: 'HTML',
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  svg: 'SVG',
  odt: 'OpenDocument текст (ODT)',
  ods: 'OpenDocument таблица (ODS)',
  odp: 'OpenDocument презентация (ODP)',
  rtf: 'RTF',
  epub: 'EPUB',
};

/** Allowlist входных форматов в виде множества — для проверок на горячем пути. */
export const inputFormatSet: ReadonlySet<string> = new Set(INPUT_FORMATS);

/** Allowlist выходных форматов в виде множества. */
export const outputFormatSet: ReadonlySet<string> = new Set(OUTPUT_FORMATS);

/** Множество форматов-контейнеров ZIP. */
export const zipContainerFormatSet: ReadonlySet<string> = new Set(ZIP_CONTAINER_FORMATS);

/** Множество текстовых входных форматов. */
export const textInputFormatSet: ReadonlySet<string> = new Set(TEXT_INPUT_FORMATS);

/** Множество табличных входных форматов. */
export const spreadsheetInputFormatSet: ReadonlySet<string> = new Set(
  SPREADSHEET_INPUT_FORMATS
);

/**
 * Возвращает расширение файла для формата результата.
 *
 * @param format - формат результата
 * @returns расширение; для неизвестного формата — он сам
 */
export function getFileExtension(format: string): string {
  return FILE_EXTENSIONS[format.toLowerCase()] ?? format;
}
