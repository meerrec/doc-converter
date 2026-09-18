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
 * Контекст задачи.
 */
export interface TaskContext {
  /** Идентификатор запроса. */
  requestId?: string | null;
  /** Идентификатор задачи. */
  taskId: string;
  /** Метка времени создания контекста. */
  timestamp: number;
}

/**
 * Получает расширение файла для формата
 *
 * @param format - формат
 */
export function getFileExtension(format: string): string {
  const extensions: Record<string, string> = {
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
 * @param requestId - идентификатор запроса
 * @param taskId - идентификатор задачи
 */
export function createTaskContext(
  requestId?: string | null,
  taskId?: string
): TaskContext {
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
