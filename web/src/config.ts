/**
 * Константы интерфейса.
 *
 * Собраны в одном модуле по тому же принципу, что и src/config/index.js
 * на сервере: у каждого числа — обоснование. Значения встраиваются
 * в сборку, менять их переменными окружения контейнера бессмысленно.
 */

/**
 * Предельный размер загружаемого файла (30 МиБ).
 *
 * Обоснование: сервер принимает тело до 50 МиБ (express.json на маршруте
 * конвертации), а base64 увеличивает объём примерно на треть — то есть
 * потолок около 37,5 МиБ исходного файла. 30 МиБ оставляют запас и дают
 * внятное сообщение вместо ошибки 413 от body-parser.
 */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/** Базовый интервал опроса статусов (мс). */
export const POLL_INTERVAL_MS = 1500;

/** Максимальный интервал опроса при замедлении (мс). */
export const POLL_MAX_INTERVAL_MS = 5000;

/**
 * Предельное время ожидания задачи (мс).
 *
 * Обоснование: сервер держит статус задачи в Valkey час, а на конвертацию
 * отводит 60 с. Пять минут — страховка от «вечного» статуса queued,
 * когда воркер не запущен.
 */
export const POLL_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Сколько задач отправляется одновременно.
 *
 * Обоснование: лимит сервера — около 20 запросов в секунду на IP, причём
 * на маршруте конвертации ограничитель навешан дважды, то есть один POST
 * стоит две единицы бюджета. Две одновременные отправки с паузой 400 мс
 * дают около 5 единиц в секунду — четырёхкратный запас.
 */
export const BATCH_CONCURRENCY = 2;

/** Минимальная пауза между запусками отправок (мс). */
export const BATCH_MIN_INTERVAL_MS = 400;

/**
 * Размер порции идентификаторов в пакетном запросе статусов.
 *
 * Обоснование: идентификатор задачи — 36 символов, при 40 идентификаторах
 * длина URL остаётся в пределах безопасных двух килобайт.
 */
export const STATUS_BATCH_SIZE = 40;

/** Допустимые форматы входных файлов (совпадает с ALLOWED_INPUT_FORMATS). */
export const INPUT_FORMATS = [
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'txt', 'html', 'htm', 'csv', 'pdf', 'epub',
] as const;

/** Допустимые форматы результата (совпадает с ALLOWED_OUTPUT_FORMATS). */
export const OUTPUT_FORMATS = [
  'pdf', 'pdfa', 'docx', 'xlsx', 'csv', 'txt', 'html',
  'png', 'jpg', 'jpeg', 'svg', 'odt', 'ods', 'odp', 'rtf', 'epub',
] as const;

/** Человекочитаемые названия форматов результата. */
export const OUTPUT_FORMAT_LABELS: Record<string, string> = {
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

/** Допустимые кодировки (поле codePage). */
export const CODE_PAGES = [
  { value: 65001, label: 'UTF-8' },
  { value: 1251, label: 'Windows-1251' },
  { value: 1252, label: 'Windows-1252' },
  { value: 866, label: 'DOS (866)' },
  { value: 20866, label: 'KOI8-R' },
  { value: 28595, label: 'ISO-8859-5' },
] as const;

/**
 * Допустимые разделители CSV (поле delimiter).
 *
 * Нумерация Р7-Офис; соответствие символов — mapDelimiter в
 * src/worker/optionsMapper.js.
 */
export const DELIMITERS = [
  { value: 1, label: 'Табуляция' },
  { value: 2, label: 'Точка с запятой (;)' },
  { value: 3, label: 'Пробел' },
  { value: 4, label: 'Запятая (,)' },
] as const;

/** Форматы входа, для которых имеет смысл codePage. */
export const TEXT_INPUT_FORMATS = new Set(['txt', 'csv', 'html', 'htm']);

/** Формат входа, для которого имеет смысл delimiter. */
export const CSV_FORMAT = 'csv';

/** Форматы входа, для которых имеет смысл ориентация и параметры листа. */
export const SPREADSHEET_INPUT_FORMATS = new Set(['xls', 'xlsx', 'ods', 'csv']);
