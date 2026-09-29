/**
 * Движок браузерной конвертации.
 *
 * Документ разбирает и верстает BetterOffice (Rust/WASM), а PDF из его
 * вёрстки собирает наш экспортёр. Здесь живёт всё, что нужно, чтобы открыть
 * документ, выполнить конвертацию и вернуть PDF, — и ничего, что знало бы
 * о конкретной странице.
 *
 * Границы пакета заданы манифестом, а не расположением каталога: React,
 * серверный API и адреса страницы сюда не импортируются. Движок получает
 * байты и имя файла, поэтому переносим в любое приложение.
 *
 * Все комментарии на русском языке.
 */

export { MAX_FILE_BYTES, MIN_OUTPUT_BYTES } from './constants.js';
export { BROWSER_FORMATS, browserFormatOf, type BrowserFormat } from './filters.js';
export { describeError } from './messages.js';
export { ENGINE_ERROR_CODES, EngineError, type EngineErrorCode } from './engine/errors.js';
export { loadEngine, type EngineModule } from './engine/load.js';
export {
  createLocalQueue,
  type EngineConverter,
  type LocalQueueOptions,
  type OfficeConvertJob,
  type OfficeJob,
  type OfficeOutcome,
  type OfficePhase,
  type OfficePreviewJob,
  type OfficeQueue,
  type OfficeQueueEvents,
} from './engine/queue.js';
export type { ConvertInput, ConvertedDocument } from './engine/convert.js';
