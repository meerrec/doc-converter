/**
 * Основной маршрут конвертации
 * 
 * Endpoint: POST /ConvertService.ashx
 * 
 * Отвечает за:
 * - Прием запросов на конвертацию
 * - Валидацию схемы запроса
 * - Валидацию контента (magic bytes, zip guard, xml guard, url guard)
 * - Выполнение конвертации в sync или async режиме
 * - Идемпотентность по key
 * - Обработку обрыва клиента
 * - Возврат результата
 * 
 * Поддерживаемые режимы:
 * - Sync (async: false): выполнение в том же запросе
 * - Async (async: true): задача ставится в очередь
 * 
 * Пример запроса:
 * {
 *   "async": false,
 *   "filetype": "xlsx",
 *   "outputtype": "pdf",
 *   "url": "http://storage/files/report.xlsx",
 *   "key": "task-123"
 * }
 * 
 * Пример ответа (sync):
 * {
 *   "status": "success",
 *   "fileUrl": "/storage/results/task-123.pdf",
 *   "fileType": "pdf",
 *   "taskId": "task-123"
 * }
 * 
 * Пример ответа (async):
 * {
 *   "status": "queued",
 *   "taskId": "task-123"
 * }
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  SYNC_ENABLED,
  MAX_FILE_BYTES,
  MAX_BODY_BYTES,
  SYNC_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  VALIDATION_TIMEOUT_MS,
} from '../../config/index.js';
import { validateConversionRequest, parseBase64, ValidationError } from '../middleware/validate.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { reserveTaskId, checkKeyConflict, saveTaskMetadata, setTaskStatus, getTaskInfo } from '../../queue/idempotency.js';
import { addConversionJob } from '../../queue/conversionQueue.js';
import { validateUrl } from '../../security/urlGuard.js';
import { checkMagicBytes } from '../../security/magicBytes.js';
import { validateZip } from '../../security/zipGuard.js';
import { convertWithLimits } from '../../worker/sandbox.js';
import { getRequestId } from '../middleware/requestId.js';
import { logRejection, logSuccess, logConversionError } from '../middleware/auditLog.js';

const router = express.Router();

// ===========================================================================
// Middleware для маршрута
// ===========================================================================

// Rate limiting
router.use(rateLimitMiddleware());

// ===========================================================================
// Обработчик POST запроса
// ===========================================================================

/**
 * Обработчик POST /ConvertService.ashx
 */
router.post('/', express.json({ limit: '50mb' }), async (req, res) => {
  const requestId = getRequestId(req);
  const ip = req.ip || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  
  // Настраиваем обработку обрыва клиента
  let clientDisconnected = false;
  let activeFork = null;
  let fetchController = null;
  
  // Обработчик обрыва соединения.
  //
  // Слушаем именно ответ, а не запрос: событие 'close' у запроса приходит
  // и при штатном завершении (тело получено), из-за чего сервер считал
  // клиента ушедшим и не отдавал готовый результат. У ответа признак
  // реального обрыва — соединение закрыто до того, как ответ отправлен.
  const disconnectHandler = () => {
    if (res.writableFinished) {
      return;
    }

    clientDisconnected = true;

    // Отменяем fetch
    if (fetchController) {
      fetchController.abort();
    }

    // Убиваем форк-процесс
    if (activeFork) {
      try {
        activeFork.kill('SIGKILL');
      } catch {
        // Игнорируем
      }
    }
  };

  res.on('close', disconnectHandler);
  
  try {
    // Валидируем запрос
    const validated = validateConversionRequest(req.body, { req, res });
    
    // Проверяем, включен ли sync режим
    if (validated.async === false && !SYNC_ENABLED) {
      logRejection({
        requestId,
        ip,
        ua,
        code: 'sync_disabled',
      });
      
      return res.status(501).json({
        error: 'sync_disabled',
        message: 'Synchronous mode is disabled',
      });
    }
    
    // Получаем source (url или data)
    const { url, data: base64Data, ...requestOptions } = validated;
    
    // Генерируем или используем существующий taskId
    const taskId = validated.key || randomUUID();
    
    // Проверяем идемпотентность
    const { reserved, existing: existingStatus } = await reserveTaskId(taskId);
    
    if (!reserved) {
      // Задача уже существует
      const existingInfo = await getTaskInfo(taskId);
      
      if (!existingInfo) {
        // Задача существует, но информация недоступна
        return res.status(202).json({
          status: existingStatus || 'processing',
          taskId,
        });
      }
      
      // Проверяем конфликт
      const conflictCheck = await checkKeyConflict(taskId, {
        filetype: validated.filetype,
        outputtype: validated.outputtype,
      });
      
      if (conflictCheck.conflict) {
        logRejection({
          requestId,
          ip,
          ua,
          code: 'key_conflict',
          taskId,
        });
        
        return res.status(409).json({
          error: 'key_conflict',
          message: 'Task with same key but different parameters already exists',
          taskId,
          existingTaskId: taskId,
        });
      }
      
      // Задача уже выполняется или выполнена с теми же параметрами
      return res.status(202).json({
        status: existingInfo.status || 'processing',
        taskId,
        ...(existingInfo.result ? { result: existingInfo.result } : {}),
      });
    }
    
    // Сохраняем метаданные задачи
    await saveTaskMetadata(taskId, {
      filetype: validated.filetype,
      outputtype: validated.outputtype,
      url: url,
      data: !!base64Data,
      timestamp: Date.now(),
    });
    
    // Получаем входные данные
    let inputBuffer;
    let sourceType = url ? 'url' : 'data';
    
    if (url) {
      // Загружаем файл по URL
      inputBuffer = await fetchFileFromUrl(url, { timeout: FETCH_TIMEOUT_MS });
      fetchController = new AbortController();
    } else if (base64Data) {
      // Декодируем base64
      try {
        inputBuffer = parseBase64(base64Data, MAX_FILE_BYTES);
      } catch (err) {
        logRejection({
          requestId,
          ip,
          ua,
          code: 'data_too_large',
          declaredExt: validated.filetype,
          size: base64Data.length,
        });
        
        return res.status(413).json({
          error: 'data_too_large',
          message: `Data size ${base64Data.length} exceeds max ${MAX_BODY_BYTES}`,
        });
      }
    }
    
    // Валидируем входные данные
    await validateInputContent(inputBuffer, validated.filetype, {
      timeout: VALIDATION_TIMEOUT_MS,
      requestId,
      ip,
      ua,
    });
    
    // Устанавливаем статус processing
    await setTaskStatus(taskId, 'processing', SYNC_TIMEOUT_MS / 1000);
    
    // Обрабатываем в зависимости от режима
    if (validated.async) {
      // Async режим - ставим задачу в очередь
      const job = await addConversionJob({
        taskId,
        inputBuffer: inputBuffer.toString('base64'),
        inputFormat: validated.filetype,
        outputFormat: validated.outputtype,
        options: requestOptions,
        requestId,
      });
      
      // Устанавливаем статус queued
      await setTaskStatus(taskId, 'queued', SYNC_TIMEOUT_MS / 1000);
      
      // Логируем
      logSuccess({
        requestId,
        taskId,
        fileType: validated.outputtype,
      });
      
      // Устанавливаем заголовки
      res.setHeader('X-Task-Id', taskId);
      
      return res.status(202).json({
        status: 'queued',
        taskId,
        message: 'Task added to queue',
      });
    } else {
      // Sync режим - выполняем конвертацию
      const startTime = Date.now();
      
      // Устанавливаем таймер на весь sync запрос
      const syncTimer = setTimeout(() => {
        if (!res.headersSent) {
          disconnectHandler();
          res.status(504).json({
            error: 'sync_timeout',
            message: `Sync request timeout after ${SYNC_TIMEOUT_MS}ms`,
            taskId,
          });
        }
      }, SYNC_TIMEOUT_MS);
      
      try {
        // Выполняем конвертацию
        const result = await convertWithLimits(
          inputBuffer,
          validated.filetype,
          validated.outputtype,
          requestOptions,
          {
            requestId,
            taskId,
            isSync: true,
          }
        );
        
        clearTimeout(syncTimer);
        
        // Проверяем обрыв клиента
        if (clientDisconnected) {
          // Не пишем результат
          logRejection({
            requestId,
            ip,
            ua,
            code: 'client_disconnected',
            taskId,
          });
          
          return null; // Соединение уже закрыто
        }
        
        if (!result.success) {
          // Устанавливаем статус failed
          await setTaskStatus(taskId, 'failed', SYNC_TIMEOUT_MS / 1000);
          
          logConversionError({
            requestId,
            taskId,
            code: result.error?.errorCode || 'conversion_failed',
            message: result.error?.message,
            durationMs: Date.now() - startTime,
          });
          
          return res.status(500).json({
            error: result.error?.errorCode || 'conversion_failed',
            message: result.error?.message || 'Conversion failed',
            taskId,
          });
        }
        
        // Сохраняем результат
        const extension = validated.outputtype;
        const fileName = `${taskId}.${extension}`;
        
        // Генерируем URL (в реальном коде сохраняем в storage)
        const fileUrl = `/storage/results/${fileName}`;
        
        // Устанавливаем статус completed
        await setTaskStatus(taskId, 'completed', SYNC_TIMEOUT_MS / 1000);
        
        // Логируем
        logSuccess({
          requestId,
          taskId,
          fileType: validated.outputtype,
          size: result.result?.length,
          durationMs: Date.now() - startTime,
        });
        
        // Устанавливаем заголовки
        res.setHeader('X-Task-Id', taskId);
        
        return res.json({
          status: 'success',
          fileUrl,
          fileType: validated.outputtype,
          taskId,
        });
      } catch (err) {
        clearTimeout(syncTimer);
        
        // Устанавливаем статус failed
        try {
          await setTaskStatus(taskId, 'failed', SYNC_TIMEOUT_MS / 1000);
        } catch {
          // Игнорируем
        }
        
        logConversionError({
          requestId,
          taskId,
          code: err.errorCode || 'internal',
          message: err.message,
          durationMs: Date.now() - startTime,
        });
        
        // Определяем статус код
        const statusCode = err.statusCode || 500;
        const errorCode = err.errorCode || 'internal';
        
        return res.status(statusCode).json({
          error: errorCode,
          message: err.message,
          taskId,
        });
      }
    }
  } catch (err) {
    // Обработка ошибок валидации и других
    
    if (err.statusCode) {
      // Это известная ошибка валидации
      logRejection({
        requestId,
        ip,
        ua,
        code: err.errorCode || 'internal',
        message: err.message,
      });
      
      return res.status(err.statusCode).json({
        error: err.errorCode || 'internal',
        message: err.message,
      });
    }
    
    // Неизвестная ошибка
    logRejection({
      requestId,
      ip,
      ua,
      code: 'internal',
      message: err.message,
    });
    
    res.status(500).json({
      error: 'internal',
      message: err.message,
    });
  } finally {
    // Удаляем обработчик
    res.off('close', disconnectHandler);
  }
});

// ===========================================================================
// Валидация контента
// ===========================================================================

/**
 * Валидирует входные данные
 * 
 * @param {Buffer} buffer - буфер с данными
 * @param {string} declaredFormat - объявленный формат
 * @param {object} [options] - опции
 * @param {number} [options.timeout] - таймаут в мс
 * @param {string} [options.requestId] - идентификатор запроса
 * @param {string} [options.ip] - IP адрес
 * @param {string} [options.ua] - User-Agent
 */
async function validateInputContent(buffer, declaredFormat, options = {}) {
  const { timeout, requestId, ip, ua } = options;
  
  // Проверяем magic bytes
  const magicResult = checkMagicBytes(buffer, declaredFormat);

  if (!magicResult.valid) {
    const errorCode = magicResult.error?.errorCode || 'magic_mismatch';

    logRejection({
      requestId,
      ip,
      ua,
      code: errorCode,
      declaredExt: declaredFormat,
      size: buffer.length,
    });

    throw new ValidationError(
      errorCode,
      magicResult.error?.message || 'Magic bytes validation failed',
      415
    );
  }
  
  // Если формат ZIP - валидируем архив
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(declaredFormat)) {
    try {
      await validateZip(buffer, { timeout });
    } catch (err) {
      logRejection({
        requestId,
        ip,
        ua,
        code: err.errorCode,
        declaredExt: declaredFormat,
        size: buffer.length,
      });
      
      throw err;
    }
  }
}

// ===========================================================================
// Загрузка файла по URL
// ===========================================================================

/**
 * Загружает файл по URL
 * 
 * @param {string} urlString - URL файла
 * @param {object} [options] - опции
 * @param {number} [options.timeout] - таймаут в мс
 * @returns {Promise<Buffer>}
 */
async function fetchFileFromUrl(urlString, options = {}) {
  const { timeout = FETCH_TIMEOUT_MS } = options;
  
  // Валидируем URL
  await validateUrl(urlString, {
    checkDns: true,
    timeout,
  });
  
  // Создаем AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);
  
  try {
    const response = await fetch(urlString, {
      method: 'GET',
      signal: controller.signal,
      // Ограничиваем размер ответа
      size: MAX_FILE_BYTES,
    });
    
    clearTimeout(timeoutId);
    
    // Проверяем статус
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    
    // Проверяем Content-Type
    const contentType = response.headers.get('content-type') || '';
    const allowedTypes = [
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument',
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/html',
    ];
    
    if (allowedTypes.every(t => !contentType.includes(t))) {
      throw new Error(`Unsupported Content-Type: ${contentType}`);
    }
    
    // Проверяем Content-Length
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${contentLength} bytes`);
    }
    
    // Читаем тело
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Проверяем размер
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${buffer.length} bytes`);
    }
    
    // Проверяем, что файл не пустой
    if (buffer.length === 0) {
      throw new Error('File is empty');
    }
    
    return buffer;
  } catch (err) {
    clearTimeout(timeoutId);
    
    // Проверяем, был ли abort
    if (err.name === 'AbortError') {
      throw new Error(`Fetch timeout after ${timeout}ms`);
    }
    
    // Проверяем, что ошибка связана с сетью
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw new Error(`Failed to fetch URL: ${err.message}`);
    }
    
    throw err;
  }
}

export default router;
