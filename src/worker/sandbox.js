/**
 * Модуль sandbox для выполнения задач с изоляцией
 * 
 * Отвечает за:
 * - У ಆದение семафором для ограничения одновременных задач
 * - Управление таймаутами выполнения
 * - Интеграцию с fork-pool для выполнения задач
 * - Обработку результатов и ошибок
 * 
 * Почему нужен sandbox:
 * - Контроль количества одновременно выполняемых задач
 * - Изоляция задач друг от друга
 * - Защита от перегрузки системы
 * - Возможность отмены задач
 * 
 * Архитектура:
 * - Семафор ограничивает количество одновременно работающих задач (MAX_CONCURRENT)
 * - Каждая задача выполняется в отдельном форкнутом процессе
 * - Таймаут контролируется на уровне sandbox
 * - При таймауте процесс убивается через SIGKILL
 * 
 * Примечание:
 * - Семафор работает на уровне процесса (внутри worker процесса)
 * - MAX_CONCURRENT = FORK_POOL_SIZE для простоты
 * - При ожидании слота дольше SYNC_QUEUE_WAIT_MS - возвращаем 503
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_CONCURRENT,
  JOB_TIMEOUT_MS,
  SYNC_QUEUE_WAIT_MS,
} from '../config/index.js';
import { getForkPool } from './fork-pool.js';
import { logConversionError, logSuccess } from '../api/middleware/auditLog.js';

// ===========================================================================
// Семафор
// ===========================================================================

/**
 * Класс семафора
 */
class Semaphore {
  /**
   * Создает семафор
   * 
   * @param {number} value - начальное значение
   */
  constructor(value) {
    this.value = value;
    this.waiting = [];
  }
  
  /**
   * Получает разрешение
   * 
   * @param {number} [timeout] - таймаут в мс
   * @returns {Promise<() => void>}
   */
  async acquire(timeout) {
    if (this.value > 0) {
      this.value--;
      return () => this.release();
    }
    
    // Ожидаем освобождения
    return new Promise((resolve, reject) => {
      const ticket = { resolve, reject };
      this.waiting.push(ticket);
      
      // Таймаут
      if (timeout) {
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(ticket);
          if (index !== -1) {
            this.waiting.splice(index, 1);
          }
          reject(new Error(`Semaphore timeout after ${timeout}ms`));
        }, timeout);
        
        ticket.timer = timer;
      }
    });
  }
  
  /**
   * Освобождает разрешение
   */
  release() {
    this.value++;
    
    // Выдаем разрешение ожидающему
    if (this.waiting.length > 0) {
      const ticket = this.waiting.shift();
      if (ticket.timer) {
        clearTimeout(ticket.timer);
      }
      this.value--;
      ticket.resolve(() => this.release());
    }
  }
  
  /**
   * Получает текущее значение
   * 
   * @returns {number}
   */
  getValue() {
    return this.value;
  }
  
  /**
   * Проверяет, доступен ли семафор
   * 
   * @returns {boolean}
   */
  isAvailable() {
    return this.value > 0;
  }
}

// ===========================================================================
// Семафор для задач
// ===========================================================================

/** @type {Semaphore} */
let taskSemaphore = null;

/**
 * Получает семафор задач
 * 
 * @returns {Semaphore}
 */
export function getTaskSemaphore() {
  if (!taskSemaphore) {
    taskSemaphore = new Semaphore(MAX_CONCURRENT);
  }
  return taskSemaphore;
}

/**
 * Сбрасывает семафор
 * 
 * @returns {void}
 */
export function resetTaskSemaphore() {
  taskSemaphore = null;
}

// ===========================================================================
// Выполнение задач
// ===========================================================================

/**
 * Выполняет задачу в sandbox
 * 
 * @param {object} task - данные задачи
 * @param {Buffer} task.inputBuffer - входные данные
 * @param {string} task.inputFormat - формат входного файла
 * @param {string} task.outputFormat - формат выходного файла
 * @param {object} [task.options] - опции конвертации
 * @param {object} [context] - контекст выполнения
 * @param {string} [context.requestId] - идентификатор запроса
 * @param {string} [context.taskId] - идентификатор задачи
 * @param {boolean} [context.isSync=false] - синхронный режим
 * @returns {Promise<{success: boolean, result?: Buffer, error?: object}>}
 */
export async function executeInSandbox(task, context = {}) {
  const {
    requestId,
    taskId,
    isSync = false,
  } = context;
  
  const semaphore = getTaskSemaphore();
  const forkPool = getForkPool();
  
  // Пытаемся получить разрешение
  let release;
  try {
    release = await semaphore.acquire(isSync ? SYNC_QUEUE_WAIT_MS : undefined);
  } catch (err) {
    throw new Error(`Queue is full: ${err.message}`);
  }
  
  const startTime = Date.now();
  
  try {
    // Выполняем задачу через пул
    const result = await forkPool.runTask(task, {
      timeout: JOB_TIMEOUT_MS,
    });
    
    // Логируем успех
    if (requestId) {
      logSuccess({
        requestId,
        taskId,
        fileType: task.outputFormat,
        size: result.result?.length,
        durationMs: Date.now() - startTime,
      });
    }
    
    return result;
  } catch (err) {
    // Логируем ошибку
    if (requestId) {
      logConversionError({
        requestId,
        taskId,
        code: err.errorCode || 'conversion_failed',
        message: err.message,
        durationMs: Date.now() - startTime,
      });
    }
    
    throw err;
  } finally {
    // Освобождаем семафор
    if (release) {
      release();
    }
  }
}

/**
 * Выполняет конвертацию с лимитами
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} [options] - опции
 * @param {object} [context] - контекст
 * @returns {Promise<{success: boolean, result?: Buffer, error?: object}>}
 */
export async function convertWithLimits(
  inputBuffer,
  inputFormat,
  outputFormat,
  options = {},
  context = {}
) {
  const taskId = context.taskId || randomUUID();
  
  const task = {
    taskId,
    inputBuffer,
    inputFormat,
    outputFormat,
    options,
  };
  
  return executeInSandbox(task, context);
}

// ===========================================================================
// Интеграция с WASM
// ===========================================================================

/**
 * Выполняет конвертацию через WASM с sandbox
 * 
 * @param {Buffer} inputBuffer - входные данные
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {object} [options] - опции
 * @param {object} [context] - контекст
 * @returns {Promise<Buffer>}
 */
export async function convertWithWasmSandbox(
  inputBuffer,
  inputFormat,
  outputFormat,
  options = {},
  context = {}
) {
  const result = await convertWithLimits(
    inputBuffer,
    inputFormat,
    outputFormat,
    options,
    context
  );
  
  if (!result.success) {
    throw new Error(result.error?.message || 'Conversion failed');
  }
  
  return result.result;
}

// ===========================================================================
// Управление таймаутами
// ===========================================================================

/**
 * Создает таймер для задачи
 * 
 * @param {Function} callback - callback при таймауте
 * @param {number} [timeout=JOB_TIMEOUT_MS] - таймаут в мс
 * @returns {NodeJS.Timeout}
 */
export function createTaskTimer(callback, timeout = JOB_TIMEOUT_MS) {
  return setTimeout(callback, timeout);
}

/**
 * Создает отменяемую задачу
 * 
 * @param {Function} fn - функция выполнения
 * @param {number} [timeout=JOB_TIMEOUT_MS] - таймаут в мс
 * @returns {Promise<{result: any, cancelled: boolean}>}
 */
export async function createCancellableTask(fn, timeout = JOB_TIMEOUT_MS) {
  let cancelled = false;
  let timer = null;
  
  const promise = fn();
  
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error(`Task timeout after ${timeout}ms`));
    }, timeout);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return { result, cancelled: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// ===========================================================================
// Статистика
// ===========================================================================

/**
 * Получает статистику sandbox
 * 
 * @returns {object}
 */
export function getSandboxStats() {
  const semaphore = getTaskSemaphore();
  const forkPool = getForkPool();
  
  return {
    semaphore: {
      value: semaphore.getValue(),
      waiting: semaphore.waiting.length,
    },
    forkPool: forkPool.getHealth(),
  };
}

export default {
  Semaphore,
  getTaskSemaphore,
  resetTaskSemaphore,
  executeInSandbox,
  convertWithLimits,
  convertWithWasmSandbox,
  createTaskTimer,
  createCancellableTask,
  getSandboxStats,
};
