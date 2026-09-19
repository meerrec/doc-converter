/**
 * GET /results/:fileName — отдача готового файла.
 *
 * Смонтирован по двум путям: `/results` и `/storage/results`. Исторически
 * синхронный и асинхронный пути формировали разные `fileUrl`, а клиент
 * использует значение из ответа дословно — поэтому обязаны работать обе формы.
 *
 * Имя файла приходит из URL, и путь в хранилище собирается только из его
 * проверенных частей: разделители путей отсекаются, расширение сверяется
 * с allowlist выходных форматов, а итоговый путь дополнительно проверяется
 * на принадлежность каталогу хранилища.
 */

import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import path from 'node:path';
import type { Response } from 'express';
import { FILE_EXTENSIONS, OUTPUT_FORMATS } from '@doc-converter/contract';
import { STORAGE_PATH } from '../../config/index.js';
import { resultExists } from '../../storage/fileStorage.js';
import { logRejection } from '../common/audit-log.js';
import type { RequestWithId } from '../common/request-id.middleware.js';

/**
 * Допустимые расширения файлов результатов.
 *
 * Выводится из списка выходных форматов контракта с учётом переименований:
 * `pdfa` хранится как `pdf`, `jpeg` — как `jpg`.
 */
const ALLOWED_RESULT_EXTENSIONS: ReadonlySet<string> = new Set(
  OUTPUT_FORMATS.map((format) => FILE_EXTENSIONS[format] ?? format)
);

/**
 * Шаблон имени файла результата.
 *
 * Длина идентификатора ограничена 128 символами — столько допускает
 * `MAX_TASK_ID_LENGTH` в `security/limits.ts`; более длинный идентификатор
 * в хранилище попасть не может.
 */
const FILE_NAME_PATTERN = /^([A-Za-z0-9._-]{1,128})\.([A-Za-z0-9]{1,8})$/;

/** Предельная длина имени файла, запрашиваемого через параметр `?name=`. */
const MAX_DOWNLOAD_NAME_LENGTH = 120;

/** Разобранное имя файла результата. */
interface ParsedResultName {
  taskId: string;
  extension: string;
}

/**
 * Разбирает имя файла результата на идентификатор задачи и расширение.
 *
 * @param fileName - имя файла из параметров маршрута
 * @returns части имени или null, если имя недопустимо
 */
function parseResultFileName(fileName: string): ParsedResultName | null {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return null;
  }

  // Отсекаем разделители путей и вложенные конструкции
  if (fileName !== path.basename(fileName)) {
    return null;
  }

  const match = FILE_NAME_PATTERN.exec(fileName);

  if (!match) {
    return null;
  }

  const taskId = match[1];
  const extension = match[2];

  if (!taskId || !extension) {
    return null;
  }

  // Точка не может быть первым или последним символом идентификатора:
  // отсекает имена вида '.hidden.pdf' и 'task..pdf'
  if (taskId.startsWith('.') || taskId.endsWith('.')) {
    return null;
  }

  if (!ALLOWED_RESULT_EXTENSIONS.has(extension.toLowerCase())) {
    return null;
  }

  return { taskId, extension: extension.toLowerCase() };
}

/**
 * Собирает безопасное имя файла для заголовка Content-Disposition.
 *
 * @param requestedName - значение параметра `?name=`
 * @param fallbackName - имя по умолчанию
 * @returns имя для заголовка
 */
function buildDownloadName(requestedName: unknown, fallbackName: string): string {
  if (typeof requestedName !== 'string') {
    return fallbackName;
  }

  // Управляющие символы, разделители путей и запрещённые в именах символы
  const cleaned = path
    .basename(requestedName)
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '')
    .trim();

  if (cleaned.length === 0) {
    return fallbackName;
  }

  return cleaned.slice(0, MAX_DOWNLOAD_NAME_LENGTH);
}

/**
 * Проверяет, что путь лежит внутри каталога хранилища.
 *
 * @param filePath - абсолютный путь к файлу
 * @returns true, если путь внутри STORAGE_PATH
 */
function isInsideStorage(filePath: string): boolean {
  const storageRoot = path.resolve(STORAGE_PATH);
  const resolved = path.resolve(filePath);

  return resolved.startsWith(storageRoot + path.sep);
}

/** Маршрут отдачи результатов. */
@Controller(['results', 'storage/results'])
export class ResultsController {
  /**
   * Отдаёт файл результата.
   *
   * @param fileName - имя файла из адреса
   * @param requestedName - желаемое имя для скачивания
   * @param req - входящий запрос
   * @param res - ответ
   */
  @Get(':fileName')
  async download(
    @Param('fileName') fileName: string,
    @Query('name') requestedName: string | undefined,
    @Req() req: RequestWithId,
    @Res() res: Response
  ): Promise<void> {
    const requestId = req.requestId;
    const ip = req.ip;
    const ua = req.headers['user-agent'];

    const parsed = parseResultFileName(fileName);

    if (!parsed) {
      logRejection({
        requestId,
        ip,
        ua,
        code: 'invalid_result_name',
        message: `Недопустимое имя файла: ${fileName}`,
      });

      res.status(400).json({
        error: 'invalid_result_name',
        message: 'Недопустимое имя файла результата',
      });
      return;
    }

    const { taskId, extension } = parsed;
    const storedName = `${taskId}.${extension}`;
    const filePath = path.join(STORAGE_PATH, storedName);

    // Страховка на случай, если разбор имени когда-нибудь ослабят
    if (!isInsideStorage(filePath)) {
      logRejection({
        requestId,
        ip,
        ua,
        code: 'invalid_result_name',
        message: 'Путь вне хранилища',
      });

      res.status(400).json({
        error: 'invalid_result_name',
        message: 'Недопустимое имя файла результата',
      });
      return;
    }

    try {
      const exists = await resultExists(taskId, extension);

      if (!exists) {
        logRejection({
          requestId,
          ip,
          ua,
          code: 'result_not_found',
          message: `Результат не найден: ${storedName}`,
        });

        res.status(404).json({
          error: 'result_not_found',
          message: 'Результат конвертации не найден или срок его хранения истёк',
          taskId,
        });
        return;
      }

      // Файл отдаётся потоком, а не чтением в буфер: результаты бывают
      // крупными, а heap процесса ограничен (--max-old-space-size=1536)
      const downloadName = buildDownloadName(requestedName, storedName);

      res.download(filePath, downloadName, (error?: Error) => {
        if (!error || res.headersSent) {
          return;
        }

        logRejection({
          requestId,
          ip,
          ua,
          code: 'result_read_failed',
          message: `Не удалось отдать файл: ${error.message}`,
          taskId,
        });

        res.status(500).json({
          error: 'result_read_failed',
          message: 'Не удалось прочитать файл результата',
          taskId,
        });
      });
    } catch (error) {
      logRejection({
        requestId,
        ip,
        ua,
        code: 'result_read_failed',
        message: `Ошибка чтения результата: ${(error as { message?: string }).message}`,
        taskId,
      });

      res.status(500).json({
        error: 'result_read_failed',
        message: 'Не удалось прочитать файл результата',
        taskId,
      });
    }
  }
}
