/**
 *Middleware для валидации запросов.
 *
 * Осуществляет:
 * 1. Валидацию JSON-схемы (проверка известных полей и типов)
 * 2. Валидацию content (magic bytes, zip guard, xml guard)
 * 3. Проверку XOR url/data
 * 4. Allowlist форматов
 *
 * Все комментарии на русском языке.
 */

import { MAX_BODY_BYTES, MAX_FILE_BYTES } from '../../config/index.js';
import { verifyMagicBytes, isSupportedFormat } from '../../security/magicBytes.js';
import { validateZip, quickZipCheck } from '../../security/zipGuard.js';
import { validateUrl, quickUrlCheck } from '../../security/urlGuard.js';
import { logRejection } from './auditLog.js';

/**
 * Схема запроса для POST /ConvertService.ashx
 * Только известные поля разрешёны. Неизвестные поля => 400 unknown_field.
 */
const SCHEMA = {
  // Обязательные поля
  filetype: { required: true, type: 'string' },
  outputtype: { required: true, type: 'string' },
  
  // XOR: ровно одно из url или data
  url: { required: false, type: 'string' },
  data: { required: false, type: 'string' },
  
  // Опциональные поля
  async: { required: false, type: 'boolean', default: false },
  key: { required: false, type: 'string' },
  title: { required: false, type: 'string' },
  codePage: { required: false, type: 'number' },
  delimiter: { required: false, type: 'number' },
  documentLayout: { required: false, type: 'object' },
  spreadsheetLayout: { required: false, type: 'object' },
  documentRenderer: { required: false, type: 'object' },
  region: { required: false, type: 'string' },
  password: { required: false, type: ['string', 'null'] },
  thumbnail: { required: false, type: 'object' },
};

/**
 * Allowlist форматов ввода.
 */
export const ALLOWED_INPUT_FORMATS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'txt', 'html', 'htm', 'csv', 'pdf', 'epub'
]);

/**
 * Allowlist форматов вывода.
 */
export const ALLOWED_OUTPUT_FORMATS = new Set([
  'pdf', 'pdfa', 'docx', 'xlsx', 'csv', 'txt', 'html',
  'png', 'jpg', 'jpeg', 'svg', 'odt', 'ods', 'odp', 'rtf', 'epub'
]);

/**
 * Allowlist codePage.
 */
export const ALLOWED_CODE_PAGES = new Set([
  65001, 1251, 1252, 866, 20866, 28595
]);

/**
 * Allowlist delimiter.
 */
export const ALLOWED_DELIMITERS = new Set([1, 2, 3, 4]);

/**
 * Pattern для валидации key.
 */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Pattern для валидации region.
 */
const REGION_PATTERN = /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/;

/**
 * Ошибки валидации.
 */
export class ValidationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Проверяет, что в теле запроса только известные поля.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validateKnownFields(body) {
  const knownFields = new Set(Object.keys(SCHEMA));
  
  for (const field of Object.keys(body)) {
    if (!knownFields.has(field)) {
      return 'unknown_field';
    }
  }
  
  return null;
}

/**
 * Проверяет наличие обязательных полей.
 *
 * Итерируемся по схеме, а не по телу запроса: отсутствующее поле
 * не попадёт в Object.entries(body), поэтому проверять его нужно явно.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validateRequiredFields(body) {
  for (const [field, schema] of Object.entries(SCHEMA)) {
    if (!schema.required) continue;

    const value = body[field];
    if (value === undefined || value === null) {
      return `${field}_required`;
    }
  }

  return null;
}

/**
 * Проверяет типы полей.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validateFieldTypes(body) {
  for (const [field, value] of Object.entries(body)) {
    const schema = SCHEMA[field];
    if (!schema) continue;
    
    const expectedType = schema.type;
    const actualValue = body[field];
    
    // Проверяем обязательные поля
    if (schema.required && (actualValue === undefined || actualValue === null)) {
      return `${field}_required`;
    }
    
    // Пропускаем опциональные поля, если они не переданы
    if (actualValue === undefined || actualValue === null) {
      continue;
    }
    
    // Проверяем тип
    if (Array.isArray(expectedType)) {
      // TYPE UNION
      const typeMatch = expectedType.some(type => {
        if (type === 'object') {
          return typeof actualValue === 'object' && !Array.isArray(actualValue) && actualValue !== null;
        }
        return typeof actualValue === type;
      });
      
      if (!typeMatch) {
        return 'field_type_mismatch';
      }
    } else if (expectedType === 'object') {
      if (typeof actualValue !== 'object' || Array.isArray(actualValue) || actualValue === null) {
        return 'field_type_mismatch';
      }
    } else {
      if (typeof actualValue !== expectedType) {
        return 'field_type_mismatch';
      }
    }
  }
  
  return null;
}

/**
 * Проверяет XOR url/data.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validateSourceXOR(body) {
  const hasUrl = body.url !== undefined && body.url !== null;
  const hasData = body.data !== undefined && body.data !== null;
  
  if (hasUrl && hasData) {
    return 'exactly_one_source_required';
  }
  
  if (!hasUrl && !hasData) {
    return 'exactly_one_source_required';
  }
  
  return null;
}

/**
 * Проверяет allowlist форматов.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validateFormats(body) {
  if (body.filetype && !ALLOWED_INPUT_FORMATS.has(body.filetype.toLowerCase())) {
    return 'input_format_not_allowed';
  }
  
  if (body.outputtype && !ALLOWED_OUTPUT_FORMATS.has(body.outputtype.toLowerCase())) {
    return 'output_format_not_allowed';
  }
  
  return null;
}

/**
 * Проверяет паттерны полей.
 *
 * @param {Object} body - тело запроса
 * @returns {string|null} - код ошибки или null
 */
function validatePatterns(body) {
  if (body.key && !KEY_PATTERN.test(body.key)) {
    return 'key_invalid_chars';
  }
  
  if (body.title && body.title.length > 255) {
    return 'title_too_long';
  }
  
  if (body.region && !REGION_PATTERN.test(body.region)) {
    return 'region_invalid';
  }
  
  if (body.codePage && !ALLOWED_CODE_PAGES.has(body.codePage)) {
    return 'codePage_not_allowed';
  }
  
  if (body.delimiter && !ALLOWED_DELIMITERS.has(body.delimiter)) {
    return 'delimiter_not_allowed';
  }
  
  return null;
}

/**
 * Middleware для валидации тела запроса.
 *
 * @returns {Function} - Express middleware
 */
export function validateBodyMiddleware() {
  return (req, res, next) => {
    // Проверяем, что тело — это объект
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      const error = new ValidationError(
        'body_must_be_object',
        'Request body must be a JSON object',
        400
      );
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    // Проверяем известные поля
    const knownFieldsError = validateKnownFields(req.body);
    if (knownFieldsError) {
      const error = new ValidationError(knownFieldsError, `Unknown field detected`, 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    // Проверяем обязательные поля
    const requiredError = validateRequiredFields(req.body);
    if (requiredError) {
      const error = new ValidationError(requiredError, `Required field missing`, 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }

    // Проверяем типы полей
    const typeError = validateFieldTypes(req.body);
    if (typeError) {
      const error = new ValidationError(typeError, `Field type mismatch`, 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    // Проверяем XOR url/data
    const xorError = validateSourceXOR(req.body);
    if (xorError) {
      const error = new ValidationError(xorError, 'Exactly one of url or data must be provided', 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    // Проверяем allowlist форматов
    const formatError = validateFormats(req.body);
    if (formatError) {
      const error = new ValidationError(formatError, 'File format not allowed', 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    // Проверяем паттерны
    const patternError = validatePatterns(req.body);
    if (patternError) {
      const error = new ValidationError(patternError, 'Field pattern mismatch', 400);
      logRejection(req, error.code, error.message);
      return res.status(400).json({ error: error.code, message: error.message });
    }
    
    next();
  };
}

/**
 * Middleware для валидации контента.
 * Проверяет:
 * - Magic bytes
 * - ZIP guard (для архивов)
 * - Размер файла
 *
 * @returns {Function} - Express middleware
 */
export async function validateContentMiddleware(req, res, next) {
  try {
    const { filetype, url, data } = req.body;
    
    // Если есть URL, проверяем его
    if (url) {
      const urlCheck = await validateUrl(url);
      if (!urlCheck.isValid) {
        const error = new ValidationError(urlCheck.code, urlCheck.error, 400);
        logRejection(req, error.code, error.message, { url, declaredExt: filetype });
        return res.status(400).json({ error: error.code, message: error.message });
      }
      
      // URL прошёл проверку, но нам нужно загрузить файл
      // Это будет сделано в route handler
      return next();
    }
    
    // Если есть data (base64), декодируем и проверяем
    if (data) {
      let buffer;
      
      try {
        buffer = Buffer.from(data, 'base64');
      } catch (err) {
        const error = new ValidationError(
          'data_invalid_base64',
          'Invalid base64 data',
          400
        );
        logRejection(req, error.code, error.message);
        return res.status(400).json({ error: error.code, message: error.message });
      }
      
      // Проверяем размер
      if (buffer.length > MAX_FILE_BYTES) {
        const error = new ValidationError(
          'file_too_large',
          `File size ${buffer.length} exceeds maximum ${MAX_FILE_BYTES}`,
          413
        );
        logRejection(req, error.code, error.message, { size: buffer.length });
        return res.status(413).json({ error: error.code, message: error.message });
      }
      
      // Проверяем magic bytes
      if (!verifyMagicBytes(buffer, filetype)) {
        const error = new ValidationError(
          'magic_mismatch',
          `Magic bytes do not match declared filetype: ${filetype}`,
          415
        );
        logRejection(req, error.code, error.message, { declaredExt: filetype });
        return res.status(415).json({ error: error.code, message: error.message });
      }
      
      // Для ZIP-форматов проверяем архив
      const zipFormats = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub']);
      if (zipFormats.has(filetype.toLowerCase())) {
        if (quickZipCheck(buffer)) {
          // Полная проверка ZIP
          try {
            const zipResult = await validateZip(buffer);
            if (!zipResult.isValid) {
              const violation = zipResult.firstViolation;
              const error = new ValidationError(
                violation.code,
                violation.message,
                422
              );
              logRejection(req, error.code, error.message, {
                declaredExt: filetype,
                violation: violation.code
              });
              return res.status(422).json({ error: error.code, message: error.message });
            }
          } catch (err) {
            const error = new ValidationError(
              'archive_corrupt',
              `Invalid ZIP archive: ${err.message}`,
              422
            );
            logRejection(req, error.code, error.message, { declaredExt: filetype });
            return res.status(422).json({ error: error.code, message: error.message });
          }
        }
      }
      
      // Сохраняем буфер для использования в route handler
      req.fileBuffer = buffer;
    }
    
    next();
  } catch (err) {
    const error = new ValidationError(
      'content_validation_failed',
      `Content validation error: ${err.message}`,
      422
    );
    logRejection(req, error.code, error.message);
    return res.status(422).json({ error: error.code, message: error.message });
  }
}

/**
 * Валидирует весь запрос на конвертацию.
 * 
 * @param {Object} body - тело запроса
 * @param {Object} [context] - контекст (req, res)
 * @returns {Object} - валидированные данные
 */
export function validateConversionRequest(body, context = {}) {
  // Проверяем, что тело — это объект
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body_must_be_object', 'Request body must be a JSON object', 400);
  }
  
  // Проверяем известные поля
  const knownFields = new Set(Object.keys(SCHEMA));
  for (const field of Object.keys(body)) {
    if (!knownFields.has(field)) {
      throw new ValidationError('unknown_field', `Unknown field: ${field}`, 400);
    }
  }
  
  // Проверяем обязательные поля
  for (const [field, schema] of Object.entries(SCHEMA)) {
    if (!schema.required) continue;

    const value = body[field];
    if (value === undefined || value === null) {
      throw new ValidationError(`${field}_required`, `Field ${field} is required`, 400);
    }
  }

  // Проверяем типы полей
  for (const [field, value] of Object.entries(body)) {
    const schema = SCHEMA[field];
    if (!schema) continue;
    
    const expectedType = schema.type;
    const actualValue = body[field];
    
    // Проверяем обязательные поля
    if (schema.required && (actualValue === undefined || actualValue === null)) {
      throw new ValidationError(`${field}_required`, `Field ${field} is required`, 400);
    }
    
    // Пропускаем опциональные поля, если они не переданы
    if (actualValue === undefined || actualValue === null) {
      continue;
    }
    
    // Проверяем тип
    if (Array.isArray(expectedType)) {
      const typeMatch = expectedType.some(type => {
        if (type === 'object') {
          return typeof actualValue === 'object' && !Array.isArray(actualValue) && actualValue !== null;
        }
        return typeof actualValue === type;
      });
      
      if (!typeMatch) {
        throw new ValidationError('field_type_mismatch', `Field ${field} has wrong type`, 400);
      }
    } else if (expectedType === 'object') {
      if (typeof actualValue !== 'object' || Array.isArray(actualValue) || actualValue === null) {
        throw new ValidationError('field_type_mismatch', `Field ${field} must be an object`, 400);
      }
    } else {
      if (typeof actualValue !== expectedType) {
        throw new ValidationError('field_type_mismatch', `Field ${field} must be ${expectedType}`, 400);
      }
    }
  }
  
  // Проверяем XOR url/data
  const hasUrl = body.url !== undefined && body.url !== null;
  const hasData = body.data !== undefined && body.data !== null;
  
  if (hasUrl && hasData) {
    throw new ValidationError('exactly_one_source_required', 'Exactly one of url or data must be provided', 400);
  }
  
  if (!hasUrl && !hasData) {
    throw new ValidationError('exactly_one_source_required', 'Exactly one of url or data must be provided', 400);
  }
  
  // Проверяем allowlist форматов
  if (body.filetype && !ALLOWED_INPUT_FORMATS.has(body.filetype.toLowerCase())) {
    throw new ValidationError('input_format_not_allowed', `Input format ${body.filetype} not allowed`, 400);
  }
  
  if (body.outputtype && !ALLOWED_OUTPUT_FORMATS.has(body.outputtype.toLowerCase())) {
    throw new ValidationError('output_format_not_allowed', `Output format ${body.outputtype} not allowed`, 400);
  }
  
  // Проверяем паттерны
  if (body.key && !KEY_PATTERN.test(body.key)) {
    throw new ValidationError('key_invalid_chars', 'Key contains invalid characters', 400);
  }
  
  if (body.title && body.title.length > 255) {
    throw new ValidationError('title_too_long', 'Title exceeds maximum length of 255 characters', 400);
  }
  
  if (body.region && !REGION_PATTERN.test(body.region)) {
    throw new ValidationError('region_invalid', 'Region format is invalid', 400);
  }
  
  if (body.codePage && !ALLOWED_CODE_PAGES.has(body.codePage)) {
    throw new ValidationError('codePage_not_allowed', `Code page ${body.codePage} not allowed`, 400);
  }
  
  if (body.delimiter && !ALLOWED_DELIMITERS.has(body.delimiter)) {
    throw new ValidationError('delimiter_not_allowed', `Delimiter ${body.delimiter} not allowed`, 400);
  }
  
  // Возвращаем валидированные данные с дефолтными значениями
  return {
    async: body.async !== undefined ? body.async : false,
    filetype: body.filetype.toLowerCase(),
    outputtype: body.outputtype.toLowerCase(),
    url: body.url,
    data: body.data,
    key: body.key,
    title: body.title,
    codePage: body.codePage,
    delimiter: body.delimiter,
    documentLayout: body.documentLayout,
    spreadsheetLayout: body.spreadsheetLayout,
    documentRenderer: body.documentRenderer,
    region: body.region,
    password: body.password,
    thumbnail: body.thumbnail,
  };
}

/**
 * Декодирует base64 строку в Buffer.
 * 
 * @param {string} base64Data - base64 строка
 * @param {number} maxSize - максимальный размер в байтах
 * @returns {Buffer} - декодированный буфер
 */
export function parseBase64(base64Data, maxSize) {
  if (!base64Data || typeof base64Data !== 'string') {
    throw new ValidationError('data_invalid_base64', 'Invalid base64 data', 400);
  }
  
  let buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch (err) {
    throw new ValidationError('data_invalid_base64', 'Invalid base64 data', 400);
  }
  
  if (buffer.length > maxSize) {
    throw new ValidationError(
      'data_too_large',
      `Data size ${buffer.length} exceeds max ${maxSize}`,
      413
    );
  }
  
  return buffer;
}

export default {
  validateBodyMiddleware,
  validateContentMiddleware,
  ValidationError,
  ALLOWED_INPUT_FORMATS,
  ALLOWED_OUTPUT_FORMATS,
  validateConversionRequest,
  parseBase64,
};
