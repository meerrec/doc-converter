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
import { STORAGE_PATH, INPUT_STORAGE_PATH, INPUT_FILE_TTL_MS } from '../config/index.js';

/**
 * Обеспечивает существование директории.
 *
 * @param dirPath - путь к директории
 */
async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw err;
    }
  }
}

/**
 * Получает путь к файлу результата.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns полный путь к файлу
 */
function getResultPath(taskId: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(STORAGE_PATH, `${taskId}${ext}`);
}

/**
 * Записывает результат конвертации в хранилище.
 * Использует атомарную запись через временный файл.
 *
 * @param taskId - идентификатор задачи
 * @param buffer - данные файла
 * @param extension - расширение файла (без точки)
 * @returns путь к файлу
 * @throws {Error} - если запись не удалась
 */
export async function writeResult(
  taskId: string,
  buffer: Buffer,
  extension: string
): Promise<{ filePath: string; fileUrl: string }> {
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
    
    throw new Error(`Не удалось записать результат: ${(err as Error).message}`);
  }
}

/**
 * Сохраняет результат конвертации.
 *
 * Обёртка над writeResult с порядком аргументов (buffer, taskId, extension),
 * который ожидает обработчик очереди, и размером в результате.
 *
 * @param buffer - данные файла
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns путь к файлу, URL и размер
 */
export async function saveFile(
  buffer: Buffer,
  taskId: string,
  extension: string
): Promise<{ filePath: string; fileUrl: string; size: number }> {
  const { filePath, fileUrl } = await writeResult(taskId, buffer, extension);

  return {
    filePath,
    fileUrl,
    size: buffer.length
  };
}

// ===========================================================================
// Входные файлы очереди
// ===========================================================================

/**
 * Расширение файла, в котором входной документ ждёт конвертации.
 *
 * Обоснование: `.in` отсутствует в allowlist выходных форматов
 * (`ALLOWED_RESULT_EXTENSIONS` в `nest/http/results.controller.ts`), поэтому
 * даже ошибочно оказавшись в каталоге результатов такой файл не был бы отдан
 * клиенту. Основная защита — отдельный каталог, это лишь второй барьер.
 */
const INPUT_FILE_EXTENSION = '.in';

/**
 * Собирает путь к входному файлу задачи.
 *
 * @param taskId - идентификатор задачи
 * @returns полный путь к файлу
 */
function getInputPath(taskId: string): string {
  return path.join(INPUT_STORAGE_PATH, `${taskId}${INPUT_FILE_EXTENSION}`);
}

/**
 * Проверяет, что путь лежит внутри каталога входных файлов.
 *
 * Путь приходит из задачи очереди, а её мог создать и старый код, поэтому
 * проверка нужна независимо от того, что ключ задачи ограничен шаблоном
 * `KEY_PATTERN` (разделители путей в нём запрещены).
 *
 * @param filePath - абсолютный путь к файлу
 * @returns true, если путь внутри INPUT_STORAGE_PATH
 */
function isInsideInputStorage(filePath: string): boolean {
  const inputRoot = path.resolve(INPUT_STORAGE_PATH);
  const resolved = path.resolve(filePath);

  return resolved.startsWith(inputRoot + path.sep);
}

/**
 * Записывает входной документ для асинхронной конвертации.
 *
 * Используется та же атомарная схема, что и для результатов
 * (`.tmp` → `rename`): воркер не должен увидеть недописанный файл.
 * Права 0o444 не выставляются — файл удаляется после конвертации, а не отдаётся.
 *
 * @param taskId - идентификатор задачи
 * @param buffer - содержимое исходного файла
 * @returns путь к файлу и его размер
 * @throws {Error} - если запись не удалась
 */
export async function writeInput(
  taskId: string,
  buffer: Buffer
): Promise<{ filePath: string; size: number }> {
  const filePath = getInputPath(taskId);

  if (!isInsideInputStorage(filePath)) {
    throw new Error(`Недопустимый идентификатор задачи: ${taskId}`);
  }

  await ensureDirectory(INPUT_STORAGE_PATH);

  const tempPath = `${filePath}.tmp`;

  try {
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, filePath);

    return { filePath, size: buffer.length };
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Игнорируем ошибку удаления временного файла
    }

    throw new Error(`Не удалось записать входной файл: ${(err as Error).message}`);
  }
}

/**
 * Читает входной документ, оставленный api для воркера.
 *
 * @param inputPath - путь, полученный из задачи очереди
 * @returns содержимое файла
 * @throws {Error} - если путь вне каталога или файл недоступен
 */
export async function readInput(inputPath: string): Promise<Buffer> {
  if (!isInsideInputStorage(inputPath)) {
    throw new Error('Путь к входному файлу вне каталога входных файлов');
  }

  try {
    return await fs.readFile(inputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Входной файл не найден: ${path.basename(inputPath)}`);
    }

    throw err;
  }
}

/**
 * Удаляет входной файл после конвертации.
 *
 * Ошибка удаления не пробрасывается: результат уже получен, и падение из-за
 * неудачного `unlink` только пометило бы успешную задачу как проваленную.
 *
 * @param inputPath - путь к файлу
 */
export async function deleteInput(inputPath: string): Promise<void> {
  if (!isInsideInputStorage(inputPath)) {
    return;
  }

  try {
    await fs.unlink(inputPath);
  } catch {
    // Файл уже удалён или недоступен — для уборки это не ошибка
  }
}

/**
 * Удаляет осиротевшие входные файлы.
 *
 * Файл остаётся на диске, если api записал документ, но упал до постановки
 * задачи в очередь, либо если воркер был убит до `deleteInput`. Обход идёт
 * по каталогу, а не по ключам Valkey: к моменту уборки задача уже могла
 * исчезнуть из очереди.
 *
 * @param ttlMs - возраст, после которого файл считается осиротевшим
 * @returns число удалённых файлов
 */
export async function cleanupInputs(
  ttlMs: number = INPUT_FILE_TTL_MS
): Promise<number> {
  let entries: string[];

  try {
    entries = await fs.readdir(INPUT_STORAGE_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw err;
  }

  const deadline = Date.now() - ttlMs;
  let removed = 0;

  for (const entry of entries) {
    const filePath = path.join(INPUT_STORAGE_PATH, entry);

    try {
      const stats = await fs.stat(filePath);

      if (stats.isFile() && stats.mtimeMs < deadline) {
        await fs.unlink(filePath);
        removed += 1;
      }
    } catch {
      // Файл исчез между readdir и stat — это и есть цель уборки
    }
  }

  return removed;
}

/**
 * Формирует URL результата.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns URL результата
 */
export function generateFileUrl(taskId: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  return `/results/${taskId}.${ext}`;
}

/**
 * Чтение результата из хранилища.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns данные файла
 * @throws {Error} - если файл не найден
 */
export async function readResult(taskId: string, extension: string): Promise<Buffer> {
  const filePath = getResultPath(taskId, extension);
  
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Файл результата не найден: ${taskId}.${extension}`);
    }
    throw err;
  }
}

/**
 * Проверяет существование результата.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns true, если файл существует
 */
export async function resultExists(taskId: string, extension: string): Promise<boolean> {
  const filePath = getResultPath(taskId, extension);
  
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Удаляет результат из хранилища.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns true, если файл был удалён
 */
export async function deleteResult(taskId: string, extension: string): Promise<boolean> {
  const filePath = getResultPath(taskId, extension);
  
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Получает размер файла результата.
 *
 * @param taskId - идентификатор задачи
 * @param extension - расширение файла (без точки)
 * @returns размер файла в байтах
 */
export async function getResultSize(taskId: string, extension: string): Promise<number> {
  const filePath = getResultPath(taskId, extension);
  
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
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
  // Входные файлы очереди
  writeInput,
  readInput,
  deleteInput,
  cleanupInputs
};
