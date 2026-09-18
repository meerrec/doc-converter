/**
 * Маппинг опций Р7-Офис в опции LibreOffice
 * 
 * Отвечает за:
 * - Преобразование опций из форматов Р7-Офис в формат LibreOffice
 * - Валидацию опций
 * - Установку дефолтных значений
 * 
 * Как работает:
 * 1. Получает опции из запроса Р7-Офис
 * 2. Валидирует их
 * 3. Преобразует в формат, понятный LibreOffice WASM
 * 4. Возвращает объект с опциями для конвертации
 * 
 * Примечание:
 * - @matbee/libreoffice-converter имеет свои опции
 * - Р7-Офис имеет свои форматы опций
 * - Нужно преобразовать одно в другое
 * 
 * Поддерживаемые опции Р7-Офис:
 * - documentLayout: drawPlaceHolders, drawFormHighlight, isPrint
 * - spreadsheetLayout: pageSize, margins, fitToWidth, fitToHeight, orientation
 * - documentRenderer: textAssociation
 * - codePage: кодировка текста
 * - delimiter: разделитель для CSV
 * - region: локаль
 * - password: пароль для защищенных документов
 * - thumbnail: миниатюра (в MVP не обрабатывается)
 */

import {
  SUPPORTED_CODE_PAGES,
  SUPPORTED_DELIMITERS,
} from '../config/index.js';

// ===========================================================================
// Ошибки
// ===========================================================================

/**
 * Некорректное значение опции
 */
export class InvalidOptionValueError extends Error {
  constructor(optionName, value, allowedValues) {
    super(`Invalid value for option '${optionName}': ${value}. Allowed: ${allowedValues.join(', ')}`);
    this.name = 'InvalidOptionValueError';
    this.optionName = optionName;
    this.value = value;
    this.allowedValues = allowedValues;
    this.statusCode = 400;
    this.errorCode = 'invalid_option_value';
  }
}

// ===========================================================================
// Маппинг codePage
// ===========================================================================

/**
 * Маппинг codePage в кодировку для LibreOffice
 * 
 * @param {number} codePage - кодовая страница
 * @returns {string}
 */
function mapCodePage(codePage) {
  const codePageMap = {
    // UTF-8
    65001: 'UTF-8',
    
    // Windows
    1251: 'windows-1251',
    1252: 'windows-1252',
    
    // DOS
    866: 'IBM866',
    
    // KOI8
    20866: 'KOI8-R',
    
    // ISO
    28595: 'ISO-8859-5',
  };
  
  return codePageMap[codePage] || 'UTF-8';
}

// ===========================================================================
// Маппинг delimiter
// ===========================================================================

/**
 * Маппинг delimiter в символ для LibreOffice
 * 
 * @param {number} delimiter - разделитель
 * @returns {string}
 */
function mapDelimiter(delimiter) {
  const delimiterMap = {
    1: '\t', // Tab
    2: ';',   // Semicolon
    3: ' ',   // Space
    4: ',',   // Comma
  };
  
  return delimiterMap[delimiter] || ',';
}

// ===========================================================================
// Маппинг region
// ===========================================================================

/**
 * Маппинг region в локаль для LibreOffice
 * 
 * @param {string} region - регион
 * @returns {string}
 */
function mapRegion(region) {
  // LibreOffice использует стандартные локали
  // Пример: ru-RU, en-US, de-DE
  
  if (!region) {
    return 'en-US';
  }
  
  // Если уже в правильном формате
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(region)) {
    return region.toLowerCase();
  }
  
  // Простой маппинг
  const regionMap = {
    'ru': 'ru-RU',
    'en': 'en-US',
    'de': 'de-DE',
    'fr': 'fr-FR',
    'es': 'es-ES',
    'it': 'it-IT',
    'pt': 'pt-PT',
    'pl': 'pl-PL',
    'uk': 'uk-UA',
    'zh': 'zh-CN',
    'ja': 'ja-JP',
  };
  
  const lowerRegion = region.toLowerCase();
  return regionMap[lowerRegion] || 'en-US';
}

// ===========================================================================
// Маппинг documentLayout
// ===========================================================================

/**
 * Маппинг documentLayout в опции LibreOffice
 * 
 * @param {object} layout - опции documentLayout
 * @returns {object}
 */
function mapDocumentLayout(layout) {
  if (!layout) {
    return {};
  }
  
  const {
    drawPlaceHolders = false,
    drawFormHighlight = false,
    isPrint = false,
  } = layout;
  
  return {
    // Эти опции влияют на отображение документа
    DrawPlaceholders: drawPlaceHolders,
    DrawFormHighlight: drawFormHighlight,
    // isPrint - не используется в WASM версии
  };
}

// ===========================================================================
// Маппинг spreadsheetLayout
// ===========================================================================

/**
 * Маппинг spreadsheetLayout в опции LibreOffice
 * 
 * @param {object} layout - опции spreadsheetLayout
 * @returns {object}
 */
function mapSpreadsheetLayout(layout) {
  if (!layout) {
    return {};
  }
  
  const {
    pageSize,
    margins,
    fitToWidth = 0,
    fitToHeight = 0,
    orientation,
  } = layout;
  
  const result = {};
  
  // Размер страницы
  if (pageSize) {
    result.PageSize = {
      Width: pageSize.width || '21cm',
      Height: pageSize.height || '29.7cm',
    };
  }
  
  // Отступы
  if (margins) {
    result.Margins = {
      Left: margins.left || '2cm',
      Right: margins.right || '2cm',
      Top: margins.top || '2cm',
      Bottom: margins.bottom || '2cm',
    };
  }
  
  // Масштабирование
  if (fitToWidth > 0) {
    result.FitToWidth = fitToWidth;
  }
  
  if (fitToHeight > 0) {
    result.FitToHeight = fitToHeight;
  }
  
  // Ориентация
  if (orientation) {
    result.Orientation = orientation.toLowerCase();
  }
  
  return result;
}

// ===========================================================================
// Маппинг documentRenderer
// ===========================================================================

/**
 * Маппинг documentRenderer в опции LibreOffice
 * 
 * @param {object} renderer - опции documentRenderer
 * @returns {object}
 */
function mapDocumentRenderer(renderer) {
  if (!renderer) {
    return {};
  }
  
  const { textAssociation = false } = renderer;
  
  return {
    TextAssociation: textAssociation,
  };
}

// ===========================================================================
// Основная функция маппинга
// ===========================================================================

/**
 * Преобразует опции Р7-Офис в опции LibreOffice
 * 
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} r7Options - опции Р7-Офис
 * @returns {object}
 */
export function mapR7OptionsToLibreOffice(
  inputFormat,
  outputFormat,
  r7Options = {}
) {
  const {
    codePage,
    delimiter,
    region,
    documentLayout,
    spreadsheetLayout,
    documentRenderer,
    password,
    // thumbnail не обрабатывается в MVP
  } = r7Options;
  
  const options = {};
  
  // codePage
  if (codePage !== undefined) {
    if (!SUPPORTED_CODE_PAGES.includes(codePage)) {
      throw new InvalidOptionValueError('codePage', codePage, SUPPORTED_CODE_PAGES);
    }
    options.CharSet = mapCodePage(codePage);
  }
  
  // delimiter
  if (delimiter !== undefined) {
    if (!SUPPORTED_DELIMITERS.includes(delimiter)) {
      throw new InvalidOptionValueError('delimiter', delimiter, SUPPORTED_DELIMITERS);
    }
    options.FieldDelimiter = mapDelimiter(delimiter);
  }
  
  // region
  if (region !== undefined) {
    options.Locale = mapRegion(region);
  }
  
  // documentLayout
  if (documentLayout !== undefined) {
    Object.assign(options, mapDocumentLayout(documentLayout));
  }
  
  // spreadsheetLayout
  if (spreadsheetLayout !== undefined) {
    Object.assign(options, mapSpreadsheetLayout(spreadsheetLayout));
  }
  
  // documentRenderer
  if (documentRenderer !== undefined) {
    Object.assign(options, mapDocumentRenderer(documentRenderer));
  }
  
  // password
  if (password !== undefined && password !== null) {
    options.Password = password;
  }
  
  // Специфичные опции для форматов
  const formatSpecificOptions = mapFormatSpecificOptions(
    inputFormat,
    outputFormat,
    r7Options
  );
  Object.assign(options, formatSpecificOptions);
  
  return options;
}

// ===========================================================================
// Специфичные опции для форматов
// ===========================================================================

/**
 * Маппинг специфичных опций для форматов
 * 
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} r7Options - опции Р7-Офис
 * @returns {object}
 */
function mapFormatSpecificOptions(inputFormat, outputFormat, r7Options) {
  const options = {};
  
  // Для XLSX -> PDF
  if (inputFormat === 'xlsx' && outputFormat === 'pdf') {
    // singlePageSheets - одна страница на лист
    options.SinglePageSheets = true;
    
    // exportNotes - экспортировать примечания
    options.ExportNotes = true;
    
    // exportHiddenSheets - экспортировать скрытые листы
    options.ExportHiddenSheets = false;
  }
  
  // Для DOCX -> PDF
  if (inputFormat === 'docx' && outputFormat === 'pdf') {
    // exportBookmarks - экспортировать закладки
    options.ExportBookmarks = true;
    
    // exportBookmarkText - экспортировать текст закладок
    options.ExportBookmarkText = true;
    
    // exportHeadings - экспортировать заголовки
    options.ExportHeadings = true;
  }
  
  // Для PPTX -> PDF
  if (inputFormat === 'pptx' && outputFormat === 'pdf') {
    // exportNotes - экспортировать примечания
    options.ExportNotes = true;
    
    // exportHiddenSlides - экспортировать скрытые слайды
    options.ExportHiddenSlides = false;
  }
  
  // Для текстовых форматов
  if (['txt', 'csv', 'html', 'htm'].includes(inputFormat)) {
    // Устанавливаем кодировку
    if (r7Options.codePage) {
      options.InputCharSet = mapCodePage(r7Options.codePage);
    }
  }
  
  return options;
}

// ===========================================================================
// Утилиты
// ===========================================================================

/**
 * Создает дефолтные опции для конвертации
 * 
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @returns {object}
 */
export function createDefaultOptions(inputFormat, outputFormat) {
  return mapR7OptionsToLibreOffice(inputFormat, outputFormat, {});
}

/**
 * Объединяет опции с дефолтными
 * 
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} r7Options - опции Р7-Офис
 * @returns {object}
 */
export function mergeOptionsWithDefaults(
  inputFormat,
  outputFormat,
  r7Options = {}
) {
  const defaults = createDefaultOptions(inputFormat, outputFormat);
  const mapped = mapR7OptionsToLibreOffice(inputFormat, outputFormat, r7Options);
  
  return {
    ...defaults,
    ...mapped,
  };
}

export default {
  mapR7OptionsToLibreOffice,
  createDefaultOptions,
  mergeOptionsWithDefaults,
  // Маппинг отдельных опций
  mapCodePage,
  mapDelimiter,
  mapRegion,
  mapDocumentLayout,
  mapSpreadsheetLayout,
  mapDocumentRenderer,
  // Ошибки
  InvalidOptionValueError,
};
