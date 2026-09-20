/**
 * Приём задач на конвертацию и выдача их состояния.
 *
 * Сервис не конвертирует сам: он проверяет файл, кладёт его в объектное
 * хранилище, ставит задачу в очередь нужного уровня сложности и потом
 * отвечает по её состоянию. Конвертация — в отдельном процессе-воркере
 * (`src/worker/uno`), потому что поднимать LibreOffice в API-процессе
 * значило бы держать сотни мегабайт памяти на каждый экземпляр API.
 *
 * Все комментарии на русском языке.
 */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type ConversionOptions,
  type ConvertAccepted,
  type JobStatusResponse,
} from '@doc-converter/contract';
import { AppError } from '../common/app-error.js';
import { logZipBomb } from '@doc-converter/observability';
import { checkMagicBytes, detectFileTypeByMagicBytes } from '../security/magicBytes.js';
import { validateZip } from '../security/zipGuard.js';
import { estimateComplexity } from './complexity.js';
import { addJob, queueName } from '@doc-converter/queue';
import { createJob, getJob, markFailed } from '@doc-converter/queue';
import { inputKey, presignedResultUrl, putObject } from '@doc-converter/storage';
import { MAX_FILE_BYTES } from '@doc-converter/config';

/**
 * Определяет формат файла.
 *
 * Расширение из имени — подсказка, но не доказательство: файл с именем
 * `report.xlsx` может оказаться чем угодно. Поэтому расширение задаёт
 * ожидаемый формат, а содержимое его подтверждает или опровергает.
 *
 * Формат входа ровно один, поэтому функция не столько выбирает, сколько
 * подтверждает: имя без расширения `.xlsx` принимается, если содержимое
 * опознано как zip, — так книга, переименованная при скачивании, всё равно
 * конвертируется.
 *
 * @param originalName - имя загруженного файла
 * @param buffer - содержимое файла
 * @returns имя формата
 * @throws {AppError} - если формат не поддерживается или не совпадает с содержимым
 */
function resolveInputFormat(originalName: string, buffer: Buffer): string {
  const extension = originalName.toLowerCase().split('.').pop() ?? '';
  const expected = extension === 'xlsx' ? extension : null;

  const detected = detectFileTypeByMagicBytes(buffer);

  if (!expected) {
    // Имя без понятного расширения: доверяем содержимому
    if (detected) {
      return detected;
    }

    throw new AppError(
      'unsupported_format',
      'Поддерживаются только книги Excel в формате XLSX',
      415
    );
  }

  const magic = checkMagicBytes(buffer, expected);

  if (!magic.valid) {
    throw new AppError(
      'magic_mismatch',
      magic.error?.message ?? 'Содержимое файла не соответствует расширению',
      415
    );
  }

  return expected;
}

/** Сервис конвертации XLSX → PDF. */
@Injectable()
export class XlsxService {
  private readonly logger = new Logger(XlsxService.name);

  /**
   * Принимает файл и ставит задачу в очередь.
   *
   * @param buffer - содержимое файла
   * @param originalName - имя файла из запроса
   * @param options - параметры конвертации
   * @returns идентификатор задачи и её характеристики
   */
  async submit(
    buffer: Buffer,
    originalName: string,
    options: ConversionOptions
  ): Promise<ConvertAccepted> {
    if (buffer.length === 0) {
      throw new AppError('file_required', 'Файл пуст', 400);
    }

    if (buffer.length > MAX_FILE_BYTES) {
      throw new AppError(
        'file_too_large',
        `Файл больше ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} МиБ`,
        413
      );
    }

    const inputFormat = resolveInputFormat(originalName, buffer);

    // Входной формат ровно один и он является zip-контейнером, поэтому
    // проверка безусловна: распаковкой занимается LibreOffice, и делать это
    // на 100-гигабайтной бомбе поздно
    const zipResult = await validateZip(buffer);

    if (!zipResult.isValid) {
      const violation = zipResult.violations[0];

      logZipBomb({
        originalName,
        sizeBytes: buffer.length,
        violationCode: violation?.code,
        detail: violation?.message,
      });

      throw new AppError(
        'content_validation_failed',
        violation?.message ?? 'Архив не прошёл проверку',
        422
      );
    }

    const { tier, sheets, sizeBytes } = await estimateComplexity(buffer);

    const jobId = randomUUID();
    const key = inputKey(jobId, inputFormat);

    try {
      await putObject(key, buffer);
    } catch (err) {
      // Хранилище — внешняя зависимость: его отказ клиент переживёт повтором,
      // поэтому код отличается от внутренней ошибки сервиса
      throw new AppError(
        'storage_unavailable',
        `Не удалось сохранить файл: ${(err as Error).message}`,
        503
      );
    }

    const record = await createJob(jobId, tier);

    try {
      await addJob(tier, jobId, {
        jobId,
        inputKey: key,
        inputFormat,
        options,
      });
    } catch (err) {
      // Задача не попала в очередь — состояние должно это отражать, иначе
      // клиент будет вечно опрашивать статус `queued`
      await markFailed(jobId, 'storage_unavailable', (err as Error).message);
      throw new AppError('storage_unavailable', 'Не удалось поставить задачу в очередь', 503, jobId);
    }

    this.logger.log(
      `Задача ${jobId} принята: ${sizeBytes} Б, листов ${sheets ?? 'н/д'}, очередь ${tier}`
    );

    return {
      jobId,
      status: record.status,
      tier,
      queue: queueName(tier),
      sheets,
      sizeBytes,
      createdAt: record.createdAt,
    };
  }

  /**
   * Возвращает состояние задачи.
   *
   * @param jobId - идентификатор задачи
   * @returns состояние, а для завершённой задачи — ссылка на результат
   * @throws {AppError} - если задачи нет или ссылку не удалось подписать
   */
  async getStatus(jobId: string): Promise<JobStatusResponse> {
    const record = await getJob(jobId);

    if (!record) {
      throw new AppError('job_not_found', `Задача ${jobId} не найдена`, 404, jobId);
    }

    const response: JobStatusResponse = {
      jobId: record.jobId,
      status: record.status,
      tier: record.tier,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.errorCode
        ? {
            error: {
              code: record.errorCode,
              message: record.errorMessage ?? 'Конвертация не удалась',
            },
          }
        : {}),
    };

    if (record.status === 'completed' && record.resultKey) {
      const { url, expiresAt } = await presignedResultUrl(record.resultKey);

      response.result = {
        url,
        expiresAt,
        sizeBytes: record.sizeBytes ?? 0,
      };
    }

    return response;
  }
}

export default { XlsxService };
