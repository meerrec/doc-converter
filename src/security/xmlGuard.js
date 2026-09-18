/**
 *Защита от XML-атак (XXE, Billion Laughs, Quadratic Blowup).
 *
 * Этот модуль проверяет XML-контент БЕЗ полного парсинга DOM.
 * Используется эвристический подход: подсчёт тегов и проверка на запрещённые
 * конструкции. Это критично, так как:
 *
 * 1. DOCTYPE и ENTITY — признаки XXE атак (OOXML/ODF их не используют)
 * 2. Глубокая вложенность тегов — признак billion laughs
 * 3. Большой размер XML — признак quadratic blowup
 *
 * Все комментарии на русском языке.
 */

import { XML_MAX_BYTES, XML_MAX_ELEMENT_DEPTH } from './limits.js';

/**
 * Запрещённые XML-конструкции.
 * OOXML и ODF спецификации НЕ используют DOCTYPE и ENTITY.
 * Их наличие — явный признак атаки.
 */
const FORBIDDEN_XML_PATTERNS = [
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /SYSTEM/i,
  /PUBLIC/i,
];

/**
 * Ошибки, которые может выбрасывать xmlGuard.
 */
export class XmlGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'XmlGuardError';
    this.code = code;
  }
}

/**
 * Результаты проверки XML.
 */
export class XmlGuardResult {
  constructor() {
    this.violations = [];
    this.elementDepth = 0;
    this.maxDepth = 0;
    this.byteLength = 0;
  }
  
  addViolation(code, message) {
    this.violations.push({ code, message });
  }
  
  get isValid() {
    return this.violations.length === 0;
  }
  
  get firstViolation() {
    return this.violations[0] || null;
  }
}

/**
 * Публичный набор лимитов XML-проверки — для использования вне модуля.
 */
export const XML_VALIDATION_LIMITS = {
  maxBytes: XML_MAX_BYTES,
  maxElementDepth: XML_MAX_ELEMENT_DEPTH,
};

/**
 * Быстрая проверка XML-контента на опасные конструкции.
 *
 * Возвращает причину отклонения в виде читаемой строки — удобно для
 * логирования и тестов.
 *
 * @param {string|Buffer} xmlContent - XML-контент
 * @returns {{isValid: boolean, violation: string|null}} - результат проверки
 */
export function checkXmlContent(xmlContent) {
  const xmlString = Buffer.isBuffer(xmlContent)
    ? xmlContent.toString('utf8')
    : (xmlContent ?? '');

  if (xmlString.length === 0) {
    return { isValid: true, violation: null };
  }

  // DOCTYPE — главный признак XXE. Проверяем первым: он перекрывает ENTITY
  if (/<!DOCTYPE/i.test(xmlString)) {
    return { isValid: false, violation: 'DOCTYPE detected' };
  }

  // ENTITY — определение сущностей (XXE / billion laughs)
  if (/<!ENTITY/i.test(xmlString)) {
    return { isValid: false, violation: 'ENTITY declaration detected' };
  }

  // Внешние сущности через SYSTEM/PUBLIC идентификаторы
  if (/\bSYSTEM\s+["']/i.test(xmlString)) {
    return { isValid: false, violation: 'SYSTEM identifier detected' };
  }

  if (/\bPUBLIC\s+["']/i.test(xmlString)) {
    return { isValid: false, violation: 'PUBLIC identifier detected' };
  }

  return { isValid: true, violation: null };
}

/**
 * Проверяет XML-контент на безопасность.
 *
 * @param {string|Buffer} xmlContent - XML-контент
 * @param {Object} [options] - опции проверки
 * @param {number} [options.maxBytes=XML_MAX_BYTES] - максимальный размер в байтах
 * @param {number} [options.maxDepth=XML_MAX_ELEMENT_DEPTH] - максимальная глубина вложенности
 * @returns {Promise<XmlGuardResult>} - результат проверки
 */
export async function validateXml(xmlContent, options = {}) {
  const { maxBytes = XML_MAX_BYTES, maxDepth = XML_MAX_ELEMENT_DEPTH } = options;
  
  const result = new XmlGuardResult();
  
  // Преобразуем в строку, если это Buffer
  const xmlString = Buffer.isBuffer(xmlContent) ? xmlContent.toString('utf8') : xmlContent;
  
  // Проверяем размер
  result.byteLength = Buffer.byteLength(xmlString, 'utf8');
  if (result.byteLength > maxBytes) {
    result.addViolation(
      'xml_part_too_large',
      `XML размером ${result.byteLength} байт превышает лимит ${maxBytes}`
    );
    return result;
  }

  // Проверяем на запрещённые конструкции
  for (const pattern of FORBIDDEN_XML_PATTERNS) {
    if (pattern.test(xmlString)) {
      result.addViolation(
        'xml_forbidden_construct',
        `Запрещённая XML-конструкция: ${pattern.source}`
      );
    }
  }

  // Проверяем глубину вложенности тегов эвристически
  // Подсчитываем вложенность через stack без полного парсинга
  let currentDepth = 0;
  result.maxDepth = 0;
  
  for (let i = 0; i < xmlString.length; i++) {
    // Ищем открывающие теги <tag>
    if (xmlString[i] === '<') {
      // Проверяем, что это не комментарий <!-- и не закрывающий тег </
      if (i + 1 < xmlString.length) {
        // Закрывающий тег </...>
        if (xmlString[i + 1] === '/') {
          currentDepth = Math.max(0, currentDepth - 1);
          i++; // пропускаем /
          continue;
        }
        
        // Комментарий <!-- ... -->
        if (xmlString[i + 1] === '!' && 
            i + 3 < xmlString.length && 
            xmlString[i + 2] === '-' &&
            xmlString[i + 3] === '-') {
          // Пропускаем до конца комментария
          const endComment = xmlString.indexOf('-->', i + 4);
          if (endComment !== -1) {
            i = endComment + 2;
            continue;
          }
        }
        
        // Открывающий тег <tag>
        // Проверяем, что это не <!DOCTYPE или <?xml
        if (xmlString[i + 1] !== '!' && xmlString[i + 1] !== '?') {
          currentDepth++;
          result.maxDepth = Math.max(result.maxDepth, currentDepth);
          
          if (currentDepth > maxDepth) {
            result.addViolation(
              'xml_too_deep',
              `Глубина XML ${currentDepth} превышает лимит ${maxDepth}`
            );
            break;
          }
        }
      }
    }
    
    // Ищем самозакрывающиеся теги <tag/>
    if (xmlString[i] === '/' && i > 0 && xmlString[i - 1] === '<') {
      // Это самозакрывающийся тег, не меняем глубину
      continue;
    }
  }
  
  result.elementDepth = currentDepth;
  
  return result;
}

/**
 * Быстрая синхронная проверка XML на запрещённые конструкции.
 * Используется для быстрого отклонения явно опасных XML.
 *
 * @param {string|Buffer} xmlContent - XML-контент
 * @returns {boolean} - true если XML выглядит безопасным
 */
export function quickXmlCheck(xmlContent) {
  const xmlString = Buffer.isBuffer(xmlContent) ? xmlContent.toString('utf8') : xmlContent;
  
  // Проверяем на DOCTYPE
  if (/<!DOCTYPE/i.test(xmlString)) {
    return false;
  }
  
  // Проверяем на ENTITY
  if (/<!ENTITY/i.test(xmlString)) {
    return false;
  }
  
  return true;
}

/**
 * Извлекает XML-части из ZIP-архива и проверяет их.
 * Используется для проверки OOXML/ODF документов.
 *
 * @param {Buffer} zipBuffer - буфер с ZIP-архивом
 * @param {Object} [options] - опции проверки
 * @returns {Promise<{isValid: boolean, violations: Array}>} - результат проверки
 */
export async function validateXmlInZip(zipBuffer, options = {}) {
  // Для начала просто проверяем сам ZIP
  // Полная реализация потребует parsing ZIP и извлечение XML файлов
  // Это будет сделано в следующей итерации
  
  // Пока что возвращаем positive result для совместимости
  return { isValid: true, violations: [] };
}

export default {
  validateXml,
  quickXmlCheck,
  checkXmlContent,
  validateXmlInZip,
  XML_VALIDATION_LIMITS,
  XmlGuardError,
  XmlGuardResult
};
