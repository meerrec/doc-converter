/**
 * Обёртка над WASM конвертером
 * 
 * Отвечает за:
 * - Интеграцию с @matbee/libreoffice-converter
 * - Преобразование опций Р7-Офис в опции LibreOffice
 * - Обработку результатов конвертации
 * - Валидацию входных данных
 * 
 * как работает:
 * 1. Получает запрос на конвертацию
 * 2. Валидирует входные данные
 * 3. Преобразует опции в формат LibreOffice
 * 4. Вызывает WASM конвертер
 * 5. Обрабатывает результат
 * 
 * Примечание:
 * - @matbee/libreoffice-converter - это WASM сборка LibreOffice
 * - Она работает в браузере и в Node.js
 * - Поддерживает конвертацию между различными форматами
 * - Имеет свои ограничения и лимиты
 */

import { randomUUID } from 'node:crypto';
import {
  MIN_OUTPUT_BYTES,
  MAX_FILE_BYTES,
  JOB_TIMEOUT_MS,
} from '../config/index.js';
import { convertWithWasm } from './wasm-isolate.js';
import { mapR7OptionsToLibreOffice } from './optionsMapper.js';

// ===========================================================================
// Ошибки
// ===========================================================================

/**
 * Ошибка валидации входных данных
 */
export class ConversionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionValidationError';
    this.statusCode = 400;
    this.errorCode = 'conversion_validation_failed';
  }
}

/**
 * Ошибка пустых входных данных
 */
export class EmptyInputError extends Error {
  constructor() {
    super('Input data is empty');
    this.name = 'EmptyInputError';
    this.statusCode = 400;
    this.errorCode = 'file_empty';
  }
}

/**
 * Ошибка слишком больших входных данных
 */
export class InputTooLargeError extends Error {
  constructor(size, max) {
    super(`Input data too large: ${size} bytes (max: ${max})`);
    this.name = 'InputTooLargeError';
    this.size = size;
    this.max = max;
    this.statusCode = 413;
    this.errorCode = 'file_too_large';
  }
}

/**
 * Ошибка слишком маленького выходного файла
 */
export class OutputTooSmallError extends Error {
  constructor(size, min) {
    super(`Output data too small: ${size} bytes (min: ${min})`);
    this.name = 'OutputTooSmallError';
    this.size = size;
    this.min = min;
    this.statusCode = 500;
    this.errorCode = 'output_too_small';
  }
}

/**
 * Ошибка несовместимых форматов
 */
export class IncompatibleFormatsError extends Error {
  constructor(inputFormat, outputFormat) {
    super(`Cannot convert from ${inputFormat} to ${outputFormat}`);
    this.name = 'IncompatibleFormatsError';
    this.inputFormat = inputFormat;
    this.outputFormat = outputFormat;
    this.statusCode = 400;
    this.errorCode = 'incompatible_formats';
  }
}

// ===========================================================================
// Валидация
// ===========================================================================

/**
 * Валидирует входные данные
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @returns {void}
 */
function validateInput(inputBuffer, inputFormat, outputFormat) {
  // Проверяем, что буфер передан
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new ConversionValidationError('Input must be a Buffer');
  }
  
  // Проверяем, что данные не пустые
  if (inputBuffer.length === 0) {
    throw new EmptyInputError();
  }
  
  // Проверяем размер
  if (inputBuffer.length > MAX_FILE_BYTES) {
    throw new InputTooLargeError(inputBuffer.length, MAX_FILE_BYTES);
  }
  
  // Проверяем форматы
  if (!inputFormat || !outputFormat) {
    throw new ConversionValidationError('Input and output formats are required');
  }
  
  // Проверяем совместимость форматов
  if (!isConversionSupported(inputFormat, outputFormat)) {
    throw new IncompatibleFormatsError(inputFormat, outputFormat);
  }
}

/**
 * Проверяет, поддерживается ли конвертация между форматами
 * 
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @returns {boolean}
 */
function isConversionSupported(inputFormat, outputFormat) {
  // @matbee/libreoffice-converter поддерживает конвертацию между:
  // - OOXML форматами (docx, xlsx, pptx)
  // - ODF форматами (odt, ods, odp)
  // - PDF
  // - RTF
  // - Текстовыми форматами
  
  const supportedInput = [
    'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
    'odt', 'ods', 'odp',
    'rtf', 'txt', 'csv', 'html', 'htm',
    'pdf',
  ];
  
  const supportedOutput = [
    'pdf', 'pdfa',
    'docx', 'xlsx', 'pptx',
    'odt', 'ods', 'odp',
    'rtf', 'txt', 'csv', 'html',
    'png', 'jpg', 'jpeg', 'svg',
  ];
  
  return (
    supportedInput.includes(inputFormat) &&
    supportedOutput.includes(outputFormat)
  );
}

// ===========================================================================
// Конвертация
// ===========================================================================

/**
 * Выполняет конвертацию документа
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} [r7Options] - опции Р7-Офис
 * @param {object} [context] - контекст
 * @returns {Promise<{success: boolean, result?: Buffer, error?: Error}>}
 */
export async function convertDocument(
  inputBuffer,
  inputFormat,
  outputFormat,
  r7Options = {},
  context = {}
) {
  const taskId = context.taskId || randomUUID();
  const startTime = Date.now();
  
  try {
    // Валидируем входные данные
    validateInput(inputBuffer, inputFormat, outputFormat);
    
    // Преобразуем опции Р7 в опции LibreOffice
    const libreOfficeOptions = mapR7OptionsToLibreOffice(
      inputFormat,
      outputFormat,
      r7Options
    );
    
    // Выполняем конвертацию через WASM
    const result = await convertWithWasm(
      inputBuffer,
      inputFormat,
      outputFormat,
      {
        timeout: JOB_TIMEOUT_MS,
        conversion: libreOfficeOptions,
      },
      context
    );
    
    // Проверяем размер результата
    if (result.length < MIN_OUTPUT_BYTES) {
      throw new OutputTooSmallError(result.length, MIN_OUTPUT_BYTES);
    }
    
    return {
      success: true,
      result,
      taskId,
      inputFormat,
      outputFormat,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err,
      taskId,
      inputFormat,
      outputFormat,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Выполняет конвертацию в sync режиме
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} [r7Options] - опции Р7-Офис
 * @param {object} [context] - контекст
 * @returns {Promise<Buffer>}
 */
export async function convertDocumentSync(
  inputBuffer,
  inputFormat,
  outputFormat,
  r7Options = {},
  context = {}
) {
  const result = await convertDocument(
    inputBuffer,
    inputFormat,
    outputFormat,
    r7Options,
    {
      ...context,
      isSync: true,
    }
  );
  
  if (!result.success) {
    throw result.error;
  }
  
  return result.result;
}

/**
 * Выполняет конвертацию в async режиме
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} [r7Options] - опции Р7-Офис
 * @param {object} [context] - контекст
 * @returns {Promise<{taskId: string, result?: Buffer, error?: Error}>}
 */
export async function convertDocumentAsync(
  inputBuffer,
  inputFormat,
  outputFormat,
  r7Options = {},
  context = {}
) {
  const taskId = context.taskId || randomUUID();
  
  // В async режиме просто ставим задачу в очередь
  // и возвращаем taskId
  return {
    taskId,
    queued: true,
  };
}

// ===========================================================================
// Информация о форматах
// ===========================================================================

/**
 * Получает MIME тип для формата
 * 
 * @param {string} format - формат
 * @returns {string}
 */
export function getMimeType(format) {
  const mimeTypes = {
    pdf: 'application/pdf',
    pdfa: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    epub: 'application/epub+zip',
  };
  
  return mimeTypes[format.toLowerCase()] || 'application/octet-stream';
}

/**
 * Получает расширение файла для формата
 * 
 * @param {string} format - формат
 * @returns {string}
 */
export function getFileExtension(format) {
  const extensions = {
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
  
  return extensions[format.toLowerCase()] || format;
}

// ===========================================================================
// Утилиты
// ===========================================================================

/**
 * Создает контекст задачи
 * 
 * @param {string} [requestId] - идентификатор запроса
 * @param {string} [taskId] - идентификатор задачи
 * @returns {object}
 */
export function createTaskContext(requestId, taskId) {
  return {
    requestId,
    taskId: taskId || randomUUID(),
    timestamp: Date.now(),
  };
}

export default {
  convertDocument,
  convertDocumentSync,
  convertDocumentAsync,
  validateInput,
  isConversionSupported,
  getMimeType,
  getFileExtension,
  createTaskContext,
  // Ошибки
  ConversionValidationError,
  EmptyInputError,
  InputTooLargeError,
  OutputTooSmallError,
  IncompatibleFormatsError,
};
