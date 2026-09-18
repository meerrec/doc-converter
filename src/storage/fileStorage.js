/**
 *Файловое хранилище для результатов конвертации.
 *
 * Хранит результаты в /data/storage/results/{taskId}.{ext}
 * Использует атомарную запись (запись во временный файл + rename).
 *
 * Все комментарии на русском языке.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { STORAGE_PATH } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Обеспечивает существование директории.
 *
 * @param {string} dirPath - путь к директории
 * @returns {Promise<void>}
 */
async function ensureDirectory(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw err;
    }
  }
}

/**
 * Получает путь к файлу результата.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {string} - полный путь к файлу
 */
function getResultPath(taskId, extension) {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(STORAGE_PATH, `${taskId}${ext}`);
}

/**
 * Записывает результат конвертации в хранилище.
 * Использует атомарную запись через временный файл.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {Buffer} buffer - данные файла
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<{filePath: string, fileUrl: string}>} - путь к файлу
 * @throws {Error} - если запись не удалась
 */
export async function writeResult(taskId, buffer, extension) {
  // Обеспечиваем существование директории
  await ensureDirectory(STORAGE_PATH);
  
  const filePath = getResultPath(taskId, extension);
  const tempPath = `${filePath}.tmp`;
  
  try {
    // Записываем во временный файл
    await fs.writeFile(tempPath, buffer);
    
    // Атомарно переименовываем временный файл в конечный
    await fs.rename(tempPath, filePath);
    
    // Устанавливаем права доступа (только чтение для всех)
    await fs.chmod(filePath, 0o444);
    
    // Возвращаем путь и URL
    return {
      filePath,
      fileUrl: `/results/${taskId}.${extension}`
    };
  } catch (err) {
    // Пытаемся удалить временный файл при ошибке
    try {
      await fs.unlink(tempPath);
    } catch {
      // Игнорируем ошибку удаления временного файла
    }
    
    throw new Error(`Не удалось записать результат: ${err.message}`);
  }
}

/**
 * Сохраняет результат конвертации.
 *
 * Обёртка над writeResult с порядком аргументов (buffer, taskId, extension),
 * который ожидает обработчик очереди, и размером в результате.
 *
 * @param {Buffer} buffer - данные файла
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<{filePath: string, fileUrl: string, size: number}>}
 */
export async function saveFile(buffer, taskId, extension) {
  const { filePath, fileUrl } = await writeResult(taskId, buffer, extension);

  return {
    filePath,
    fileUrl,
    size: buffer.length
  };
}

/**
 * Формирует URL результата.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {string} - URL результата
 */
export function generateFileUrl(taskId, extension) {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  return `/results/${taskId}.${ext}`;
}

/**
 * Чтение результата из хранилища.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<Buffer>} - данные файла
 * @throws {Error} - если файл не найден
 */
export async function readResult(taskId, extension) {
  const filePath = getResultPath(taskId, extension);
  
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Файл результата не найден: ${taskId}.${extension}`);
    }
    throw err;
  }
}

/**
 * Проверяет существование результата.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<boolean>} - true, если файл существует
 */
export async function resultExists(taskId, extension) {
  const filePath = getResultPath(taskId, extension);
  
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Удаляет результат из хранилища.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<boolean>} - true, если файл был удалён
 */
export async function deleteResult(taskId, extension) {
  const filePath = getResultPath(taskId, extension);
  
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Получает размер файла результата.
 *
 * @param {string} taskId - идентификатор задачи
 * @param {string} extension - расширение файла (без точки)
 * @returns {Promise<number>} - размер файла в байтах
 */
export async function getResultSize(taskId, extension) {
  const filePath = getResultPath(taskId, extension);
  
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

/**
 * Получает список всех файлов результатов.
 * Используется для cleanup.
 *
 * @returns {Promise<string[]>} - список путей к файлам
 */
export async function listResults() {
  try {
    const files = await fs.readdir(STORAGE_PATH);
    return files
      .filter(file => file.endsWith('.pdf') || file.endsWith('.docx') || 
                     file.endsWith('.xlsx') || file.endsWith('.txt'))
      .map(file => path.join(STORAGE_PATH, file));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export default {
  saveFile,
  generateFileUrl,
  writeResult,
  readResult,
  resultExists,
  deleteResult,
  getResultSize,
  listResults
};
