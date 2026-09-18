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

import { randomUUID } from 'node:crypto';
import {
  STORAGE_PATH,
  JOB_TIMEOUT_MS,
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
import { validateXml } from '../security/xmlGuard.js';
import { getFileExtension, createTaskContext } from './converter.js';
import { mapR7OptionsToLibreOffice } from './optionsMapper.js';
import { convertWithLimits } from './sandbox.js';

// ===========================================================================
// Ошибки
// ===========================================================================

/**
 * Ошибка обработки задачи
 */
export class JobProcessingError extends Error {
  constructor(message, originalError) {
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
  constructor(message, field, value) {
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
 * Обрабатывает задачу из очереди
 * 
 * @param {import('bullmq').Job} job - задача BullMQ
 * @returns {Promise<object>}
 */
export async function processJob(job) {
  const jobData = job.data;
  const taskId = job.id;
  
  // Создаем контекст
  const context = createTaskContext(null, taskId);
  
  try {
    // Валидируем задачу
    validateJobData(jobData);
    
    // Обновляем прогресс
    await job.updateProgress(10);
    
    // Получаем метаданные задачи
    const metadata = await getTaskMetadata(taskId) || {};
    
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
    // Логируем ошибку
    console.error(`[PROCESSOR] Job ${taskId} failed: ${err.message}`);
    
    // Обновляем статус
    try {
      await setTaskStatus(taskId, 'failed', IDEMPOTENCY_TTL_SEC);
      await saveTaskResult(taskId, {
        error: err.message,
        errorCode: err.errorCode || 'unknown',
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
 * @param {object} jobData - данные задачи
 */
function validateJobData(jobData) {
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
 * @param {object} jobData - данные задачи
 * @returns {Promise<Buffer>}
 */
async function prepareInput(jobData) {
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
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 */
async function validateInputData(inputBuffer, inputFormat) {
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
 * @param {Buffer} inputBuffer - входные данные
 * @param {object} jobData - данные задачи
 * @param {object} context - контекст
 * @returns {Promise<Buffer>}
 */
async function executeConversion(inputBuffer, jobData, context) {
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

  return result.result;
}

// ===========================================================================
// Сохранение результата
// ===========================================================================

/**
 * Сохраняет результат конвертации
 * 
 * @param {Buffer} resultBuffer - результат конвертации
 * @param {object} jobData - данные задачи
 * @param {object} context - контекст
 * @returns {Promise<{fileUrl: string, size: number}>}
 */
async function saveResult(resultBuffer, jobData, context) {
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
 * @param {import('bullmq').Job} job - задача BullMQ
 * @returns {object}
 */
export function createJobContext(job) {
  return {
    taskId: job.id,
    requestId: job.data.requestId,
    timestamp: Date.now(),
  };
}

/**
 * Обновляет прогресс задачи
 * 
 * @param {import('bullmq').Job} job - задача BullMQ
 * @param {number} progress - прогресс (0-100)
 * @returns {Promise<void>}
 */
export async function updateJobProgress(job, progress) {
  await job.updateProgress(progress);
}

/**
 * Отмечает задачу как успешную
 * 
 * @param {import('bullmq').Job} job - задача BullMQ
 * @param {object} result - результат
 * @returns {Promise<void>}
 */
export async function markJobCompleted(job, result) {
  // У BullMQ job.returnvalue — это значение, а не объект с сеттером:
  // результат сохраняет сам Worker из возвращённого процессором значения
  return result;
}

/**
 * Отмечает задачу как неудачную
 * 
 * @param {import('bullmq').Job} job - задача BullMQ
 * @param {Error} error - ошибка
 * @returns {Promise<void>}
 */
export async function markJobFailed(job, error) {
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
