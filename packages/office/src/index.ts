/**
 * Движок браузерной конвертации.
 *
 * Сборка LibreOffice (ZetaOffice, allotropia) исполняется в воркере браузера:
 * здесь живёт всё, что нужно, чтобы её поднять, открыть в ней документ,
 * показать его пользователю и выгрузить PDF, — и ничего, что знало бы
 * о конкретной странице.
 *
 * Границы пакета заданы манифестом, а не расположением каталога: React,
 * серверный API и адреса страницы сюда не импортируются, а адреса сборки
 * и canvas приходят параметрами (`boot`). Поэтому движок переносим
 * в любое приложение, а будущий пул воркеров — замена одной функции
 * за интерфейсом очереди, а не правка страницы.
 *
 * Публичный API — только то, что перечислено ниже. Внутренние модули
 * (мост, протокол сообщений с ним, типы UNO, отмена по таймауту) наружу
 * не выходят: их знает лишь сам движок.
 *
 * Все комментарии на русском языке.
 */

export { LocalError, LocalSession } from './session.js';
export {
  BOOT_TIMEOUT_MS,
  OPERATION_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MIN_OUTPUT_BYTES,
  FS_TMP_DIR,
} from './constants.js';
export {
  BROWSER_FORMATS,
  EXPORT_FILTERS,
  browserFormatOf,
  exportFilterFor,
  type BrowserFormat,
} from './filters.js';
export { buildFilterData, type FilterDataEntry } from './filterData.js';
export { preloadAssets, type PreloadProgress, type PreloadedAssets } from './preload.js';
export { LOCAL_ERROR_CODES, type LocalErrorCode } from './protocol.js';
export { ERROR_MESSAGES, describeError } from './messages.js';
export { ensureOffice, officeState, subscribeOffice, type OfficeAssets, type OfficeState } from './office.js';
export {
  createOfficeQueue,
  type OfficeConvertJob,
  type OfficeJob,
  type OfficeOutcome,
  type OfficePhase,
  type OfficePreviewJob,
  type OfficeQueue,
  type OfficeQueueEvents,
} from './queue.js';
