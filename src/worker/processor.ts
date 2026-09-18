/**
 * Процессор задач для BullMQ Worker
 *
 * Отвечает за:
 * - Обработку задач из очереди
 * - Валидацию данных задачи
 * - Выполнение конвертации
 * - Сохранение результата
 * - Обновление статуса
 * - Обработку ошибок
 *
 * Как работает:
 * 1. Получает задачу из очереди
 * 2. Валидирует данные задачи
 * 3. Загружает файл (если нужно)
 * 4. Выполняет конвертацию
 * 5. Сохраняет результат в storage
 * 6. Обновляет статус в Valkey
 * 7. Возвращает результат
 *
 * Примечание:
 * - В async режиме результат сохраняется в storage
 * - В sync режиме результат возвращается напрямую
 * - Ошибки обрабатываются и сохраняются вstatus
 */

import type { Job } from 'bullmq';
import {
  IDEMPOTENCY_TTL_SEC,
} from '../config/index.js';
import { saveFile, generateFileUrl } from '../storage/fileStorage.js';
import {
  setTaskStatus,
  saveTaskResult,
  getTaskMetadata,
} from '../queue/idempotency.js';
import { validateZip } from '../security/zipGuard.js';
import { checkMagicBytes } from '../security/magicBytes.js';
import { getFileExtension, createTaskContext } from './converter.js';
import { mapR7OptionsToLibreOffice } from './optionsMapper.js';
import type { R7Options } from './optionsMapper.js';
import type { TaskContext } from './converter.js';
import { convertWithLimits } from './sandbox.js';

// ===========================================================================
// Типы задачи
// ===========================================================================

/**
 * Данные задачи из очереди конвертации.
 *
 * Все поля, которые проверяет `validateJobData`, необязательны: задача
 * приходит извне, и её состав проверяется во время выполнения.
 */
export interface JobData {
  /** Идентификатор задачи. */
  taskId?: string;
  /** Содержимое исходного файла: base64 или готовый буфер. */
  inputBuffer?: string | Buffer;
  /** Формат входного файла. */
  inputFormat?: string;
  /** Формат выходного файла. */
  outputFormat?: string;
  /** Опции конвертации в формате Р7-Офис. */
  options?: R7Options;
  /** Идентификатор запроса для логов. */
  requestId?: string;
}

/**
 * Данные задачи после проверки: обязательные поля заполнены.
 */
export type ValidatedJobData = JobData &
  Required<Pick<JobData, 'taskId' | 'inputFormat' | 'outputFormat'>>;

/**
 * Результат успешно обработанной задачи.
 */
export interface JobResult {
  /** Признак успеха. */
  success: boolean;
  /** Идентификатор задачи. */
  taskId: string;
  /** Ссылка на результат. */
  fileUrl: string;
  /** Формат файла результата. */
  fileType: string;
  /** Размер результата в байтах. */
  size: number;
}

/**
 * Ошибка в том виде, в каком её читает процессор.
 *
 * Значение из `catch` имеет тип `unknown` — к этой форме оно приводится,
 * чтобы обращаться к `message` и `errorCode` так же, как это делал
 * исходный код.
 */
interface ErrorLike {
  /** Текст ошибки. */
  message?: string;
  /** Код ошибки API. */
  errorCode?: string;
}

// ===========================================================================
// Ошибки
// ===========================================================================

/**
 * Ошибка обработки задачи
 */
export class JobProcessingError extends Error {
  /** Исходная ошибка. */
  originalError: unknown;
  /** HTTP-код для ответа API. */
  statusCode: number;
  /** Код ошибки API. */
  errorCode: string;

  constructor(message?: string, originalError?: unknown) {
    super(message || 'Failed to process job');
    this.name = 'JobProcessingError';
    this.originalError = originalError;
    this.statusCode = 500;
    this.errorCode = 'job_processing_failed';
  }
}

/**
 * Ошибка валидации задачи
 */
export class JobValidationError extends Error {
  /** Поле, которое не прошло проверку. */
  field: string | undefined;
  /** Значение поля. */
  value: unknown;
  /** HTTP-код для ответа API. */
  statusCode: number;
  /** Код ошибки API. */
  errorCode: string;

  constructor(message?: string, field?: string, value?: unknown) {
    super(message || `Job validation failed: ${field}=${value}`);
    this.name = 'JobValidationError';
    this.field = field;
    this.value = value;
    this.statusCode = 400;
    this.errorCode = 'job_validation_failed';
  }
}

// ===========================================================================
// Обработка задачи
// ===========================================================================

/**
 * Идентификатор задачи из BullMQ.
 *
 * Очередь добавляет задачи с явным `jobId` (см. `addConversionJob`),
 * поэтому к моменту обработки идентификатор всегда проставлен — в типе
 * BullMQ он необязателен.
 *
 * @param job - задача BullMQ
 */
function getJobId(job: Job<JobData, JobResult>): string {
  return job.id as string;
}

/**
 * Обрабатывает задачу из очереди
 *
 * @param job - задача BullMQ
 */
export async function processJob(job: Job<JobData, JobResult>): Promise<JobResult> {
  const jobData = job.data;
  const taskId = getJobId(job);

  // Создаем контекст
  const context = createTaskContext(null, taskId);

  try {
    // Валидируем задачу
    validateJobData(jobData);

    // Обновляем прогресс
    await job.updateProgress(10);

    // Получаем метаданные задачи
    // Значение не используется, но чтение оставлено как было:
    // ошибка Valkey должна перевести задачу в failed
    await getTaskMetadata(taskId);

    // Подготавливаем входные данные
    const inputBuffer = await prepareInput(jobData);

    await job.updateProgress(20);

    // Валидируем входные данные
    await validateInputData(inputBuffer, jobData.inputFormat);

    await job.updateProgress(30);

    // Выполняем конвертацию
    const result = await executeConversion(inputBuffer, jobData, context);

    await job.updateProgress(90);

    // Сохраняем результат
    const savedResult = await saveResult(result, jobData, context);

    await job.updateProgress(100);

    // Сохраняем результат в Valkey
    await saveTaskResult(taskId, {
      fileUrl: savedResult.fileUrl,
      fileType: jobData.outputFormat,
      taskId,
      size: savedResult.size,
    }, IDEMPOTENCY_TTL_SEC);

    // Обновляем статус
    await setTaskStatus(taskId, 'completed', IDEMPOTENCY_TTL_SEC);

    return {
      success: true,
      taskId,
      fileUrl: savedResult.fileUrl,
      fileType: jobData.outputFormat,
      size: savedResult.size,
    };
  } catch (err) {
    const error = err as ErrorLike;

    // Логируем ошибку
    console.error(`[PROCESSOR] Job ${taskId} failed: ${error.message}`);

    // Обновляем статус
    try {
      await setTaskStatus(taskId, 'failed', IDEMPOTENCY_TTL_SEC);
      await saveTaskResult(taskId, {
        error: error.message,
        errorCode: error.errorCode || 'unknown',
      }, IDEMPOTENCY_TTL_SEC);
    } catch {
      // Игнорируем ошибки при сохранении статуса
    }

    // Перебрасываем ошибку
    throw err;
  }
}

// ===========================================================================
// Валидация задачи
// ===========================================================================

/**
 * Валидирует данные задачи
 *
 * @param jobData - данные задачи
 */
function validateJobData(
  jobData: JobData
): asserts jobData is ValidatedJobData {
  if (!jobData) {
    throw new JobValidationError('Job data is empty', 'data', jobData);
  }

  if (!jobData.taskId) {
    throw new JobValidationError('Task ID is required', 'taskId', jobData.taskId);
  }

  if (!jobData.inputFormat) {
    throw new JobValidationError('Input format is required', 'inputFormat', jobData.inputFormat);
  }

  if (!jobData.outputFormat) {
    throw new JobValidationError('Output format is required', 'outputFormat', jobData.outputFormat);
  }
}

// ===========================================================================
// Подготовка входных данных
// ===========================================================================

/**
 * Подготавливает входные данные
 *
 * @param jobData - данные задачи
 */
async function prepareInput(jobData: JobData): Promise<Buffer> {
  // Проверяем, что inputBuffer есть
  if (!jobData.inputBuffer) {
    throw new JobValidationError('Input buffer is required', 'inputBuffer', null);
  }

  // Декодируем из base64
  if (typeof jobData.inputBuffer === 'string') {
    return Buffer.from(jobData.inputBuffer, 'base64');
  }

  // Если уже Buffer
  if (Buffer.isBuffer(jobData.inputBuffer)) {
    return jobData.inputBuffer;
  }

  throw new JobValidationError(
    'Input buffer must be string or Buffer',
    'inputBuffer',
    typeof jobData.inputBuffer
  );
}

// ===========================================================================
// Валидация входных данных
// ===========================================================================

/**
 * Валидирует входные данные
 *
 * @param inputBuffer - входные данные
 * @param inputFormat - формат входного файла
 */
async function validateInputData(inputBuffer: Buffer, inputFormat: string): Promise<void> {
  // Проверяем magic bytes
  const magicResult = checkMagicBytes(inputBuffer, inputFormat);
  if (!magicResult.valid) {
    throw new JobValidationError(
      `Magic bytes validation failed: ${magicResult.error?.message}`,
      'magicBytes',
      inputFormat
    );
  }

  // Если формат ZIP (OOXML, ODF, etc.) - валидируем архив
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(inputFormat)) {
    await validateZip(inputBuffer);
  }
}

// ===========================================================================
// Выполнение конвертации
// ===========================================================================

/**
 * Выполняет конвертацию
 *
 * @param inputBuffer - входные данные
 * @param jobData - данные задачи
 * @param context - контекст
 */
async function executeConversion(
  inputBuffer: Buffer,
  jobData: ValidatedJobData,
  context: TaskContext
): Promise<Buffer> {
  const {
    inputFormat,
    outputFormat,
    options = {},
  } = jobData;

  // Опции Р7 преобразуются в формат, ожидаемый конвертером.
  // Движок поддерживает из них только пароль документа — остальные
  // принимаются API, но на результат не влияют (см. docs/architecture.md)
  const libreOfficeOptions = mapR7OptionsToLibreOffice(
    inputFormat,
    outputFormat,
    options
  );

  // Конвертация выполняется в fork-пуле — тем же механизмом, что и
  // синхронный путь: изоляция на уровне ОС, принудительное завершение
  // процесса по истечении JOB_TIMEOUT_MS. Бросает при неудаче.
  const result = await convertWithLimits(
    inputBuffer,
    inputFormat,
    outputFormat,
    libreOfficeOptions,
    { ...context, isSync: false }
  );

  // Конвертация завершилась успешно — результат всегда есть:
  // при неудаче runTask отклоняет промис, и управление уходит в catch
  return result.result as Buffer;
}

// ===========================================================================
// Сохранение результата
// ===========================================================================

/**
 * Сохраняет результат конвертации
 *
 * @param resultBuffer - результат конвертации
 * @param jobData - данные задачи
 * @param _context - контекст
 */
async function saveResult(
  resultBuffer: Buffer,
  jobData: ValidatedJobData,
  _context: TaskContext
): Promise<{ fileUrl: string; size: number; taskId: string; extension: string }> {
  const taskId = jobData.taskId;
  const outputFormat = jobData.outputFormat;

  // Получаем расширение файла
  const extension = getFileExtension(outputFormat);

  // Сохраняем файл
  const saved = await saveFile(resultBuffer, taskId, extension);

  // Генерируем URL
  const fileUrl = generateFileUrl(taskId, extension);

  return {
    fileUrl,
    size: saved.size,
    taskId,
    extension,
  };
}

// ===========================================================================
// Утилиты
// ===========================================================================

/**
 * Создает контекст для задачи
 *
 * @param job - задача BullMQ
 */
export function createJobContext(job: Job<JobData, JobResult>): {
  taskId: string;
  requestId: string | undefined;
  timestamp: number;
} {
  return {
    taskId: getJobId(job),
    requestId: job.data.requestId,
    timestamp: Date.now(),
  };
}

/**
 * Обновляет прогресс задачи
 *
 * @param job - задача BullMQ
 * @param progress - прогресс (0-100)
 */
export async function updateJobProgress(
  job: Job<JobData, JobResult>,
  progress: number
): Promise<void> {
  await job.updateProgress(progress);
}

/**
 * Отмечает задачу как успешную
 *
 * @param _job - задача BullMQ
 * @param result - результат
 */
export async function markJobCompleted<T>(
  _job: Job<JobData, JobResult>,
  result: T
): Promise<T> {
  // У BullMQ job.returnvalue — это значение, а не объект с сеттером:
  // результат сохраняет сам Worker из возвращённого процессором значения
  return result;
}

/**
 * Отмечает задачу как неудачную
 *
 * @param _job - задача BullMQ
 * @param error - ошибка
 */
export async function markJobFailed(
  _job: Job<JobData, JobResult>,
  error: Error & { errorCode?: string }
): Promise<{ error: string | undefined; errorCode: string }> {
  // См. markJobCompleted: результат отдаётся возвратом, а не сеттером
  return {
    error: error.message,
    errorCode: error.errorCode || 'unknown',
  };
}

export default {
  processJob,
  validateJobData,
  prepareInput,
  validateInputData,
  executeConversion,
  saveResult,
  createJobContext,
  updateJobProgress,
  markJobCompleted,
  markJobFailed,
  // Ошибки
  JobProcessingError,
  JobValidationError,
};
