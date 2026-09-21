/**
 * Приём задач на конвертацию и выдача их состояния.
 *
 * Сервис не конвертирует сам: он проверяет файл, кладёт его в объектное
 * хранилище, ставит задачу в очередь нужного уровня сложности и потом
 * отвечает по её состоянию. Конвертация — в отдельном процессе-воркере
 * (`apps/worker`), потому что поднимать LibreOffice в API-процессе
 * значило бы держать сотни мегабайт памяти на каждый экземпляр API.
 *
 * Все комментарии на русском языке.
 */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  isInputFormat,
  type ConversionOptions,
  type ConvertAccepted,
  type InputFormat,
  type JobStatusResponse,
} from '@doc-converter/contract';
import { AppError } from '../common/app-error.js';
import { logZipBomb } from '@doc-converter/observability';
import { checkMagicBytes } from '../security/magicBytes.js';
import { detectOoxmlKind } from '../security/ooxml.js';
import { validateZip } from '../security/zipGuard.js';
import { estimateComplexity } from './complexity.js';
import { addJob, queueName } from '@doc-converter/queue';
import { createJob, getJob, markFailed } from '@doc-converter/queue';
import { inputKey, presignedResultUrl, putObject } from '@doc-converter/storage';
import { MAX_FILE_BYTES } from '@doc-converter/config';

/**
 * Достаёт расширение из имени файла.
 *
 * Возвращает пустую строку, если расширения нет: имя без точки (`report`)
 * или с точкой в начале (`.gitignore`) расширением не заканчивается.
 *
 * @param originalName - имя загруженного файла
 * @returns расширение в нижнем регистре или пустая строка
 */
function fileExtension(originalName: string): string {
  const dot = originalName.lastIndexOf('.');

  if (dot <= 0 || dot === originalName.length - 1) {
    return '';
  }

  return originalName.slice(dot + 1).toLowerCase();
}

/**
 * Определяет формат, объявленный расширением.
 *
 * Расширение из имени — подсказка, но не доказательство: файл с именем
 * `report.xlsx` может оказаться чем угодно. Оно задаёт ожидание, которое
 * содержимое подтверждает или опровергает.
 *
 * Чужое расширение отвергается сразу, до чтения архива: иначе `.xls`
 * (OLE-контейнер) дошёл бы до zip-гарда и получил ответ «архив повреждён»
 * вместо «формат не поддерживается».
 *
 * @param originalName - имя загруженного файла
 * @returns объявленный формат или null, если расширения нет
 * @throws {AppError} - если формат не поддерживается
 */
function declaredFormat(originalName: string): InputFormat | null {
  const extension = fileExtension(originalName);

  if (extension === '') {
    return null;
  }

  if (!isInputFormat(extension)) {
    throw new AppError(
      'unsupported_format',
      'Поддерживаются книги Excel (XLSX) и документы Word (DOCX)',
      415
    );
  }

  return extension;
}

/**
 * Проверяет, что содержимое файла — zip-контейнер.
 *
 * Сигнатура у книги и документа одна и та же, поэтому проверяется контейнер,
 * а не формат: она отсекает файлы, разбор которых в LibreOffice занял бы
 * минуты вместо мгновенного отказа.
 *
 * @param buffer - содержимое файла
 * @param declared - формат, объявленный расширением
 * @throws {AppError} - если содержимое не является zip-контейнером
 */
function assertZipContainer(buffer: Buffer, declared: InputFormat | null): void {
  // Для файла без расширения сверять не с чем: сигнатуры обоих форматов —
  // это сигнатуры zip, и любая запись из SIGNATURES проверяет одно и то же
  const magic = checkMagicBytes(buffer, declared ?? 'xlsx');

  if (!magic.valid) {
    throw new AppError(
      'magic_mismatch',
      magic.error?.message ?? 'Содержимое файла не соответствует расширению',
      415
    );
  }
}

/**
 * Определяет формат по содержимому контейнера.
 *
 * Вызывается после zip-гарда: распаковкой архива занимается LibreOffice,
 * и разбирать оглавление контейнера, не прошедшего проверку, незачем.
 *
 * Файл без расширения принимается, если содержимое опознано, — так книга
 * или документ, переименованные при скачивании, всё равно конвертируются.
 *
 * @param buffer - содержимое файла
 * @param declared - формат, объявленный расширением
 * @returns формат, определённый по содержимому
 * @throws {AppError} - если это не документ OOXML или содержимое расходится с расширением
 */
async function resolveInputFormat(
  buffer: Buffer,
  declared: InputFormat | null
): Promise<InputFormat> {
  const detected = await detectOoxmlKind(buffer);

  if (!detected) {
    throw new AppError(
      'unsupported_format',
      'Файл не является книгой Excel или документом Word',
      415
    );
  }

  if (declared && declared !== detected) {
    throw new AppError(
      'magic_mismatch',
      `Содержимое файла не соответствует расширению «.${declared}»`,
      415
    );
  }

  return detected;
}

/** Сервис конвертации документов в PDF. */
@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

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

    const declared = declaredFormat(originalName);

    assertZipContainer(buffer, declared);

    // Входных форматов два, но оба являются zip-контейнерами, поэтому
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

    const inputFormat = await resolveInputFormat(buffer, declared);

    const { tier, sheets, pages, sizeBytes } = await estimateComplexity(buffer, inputFormat);

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

    const record = await createJob(jobId, tier, inputFormat);

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

    // Объём документа показывается той мерой, которая к нему применима:
    // у книги это листы, у текстового документа — страницы
    const volume =
      inputFormat === 'xlsx' ? `листов ${sheets ?? 'н/д'}` : `страниц ${pages ?? 'н/д'}`;

    this.logger.log(
      `Задача ${jobId} принята: ${inputFormat}, ${sizeBytes} Б, ${volume}, очередь ${tier}`
    );

    return {
      jobId,
      status: record.status,
      tier,
      queue: queueName(tier),
      inputFormat,
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
      // Поле появилось позже самих задач: у записей, созданных до обновления,
      // формата нет, и подставлять вместо него догадку нельзя
      ...(record.inputFormat ? { inputFormat: record.inputFormat } : {}),
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

export default { ConversionService };
