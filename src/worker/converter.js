/**
 * Справочник форматов конвертера.
 *
 * Отвечает за:
 * - Соответствие формата результата расширению файла
 * - Создание контекста задачи
 *
 * Примечание:
 * - Сама конвертация выполняется в fork-worker.js, который обращается
 *   напрямую к @matbee/libreoffice-converter. Этот модуль конвертацию
 *   не запускает — здесь только справочные данные о форматах.
 *
 * Все комментарии на русском языке.
 */

import { randomUUID } from 'node:crypto';

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
  getFileExtension,
  createTaskContext,
};
