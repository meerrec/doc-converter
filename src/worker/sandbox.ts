/**
 * Модуль sandbox для выполнения задач с изоляцией
 *
 * Отвечает за:
 * - Управление семафором для ограничения одновременных задач
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
import type { ForkPoolHealth } from './fork-pool.js';
import { logConversionError, logSuccess } from '../nest/common/audit-log.js';

// ===========================================================================
// Типы
// ===========================================================================

/**
 * Задача для sandbox.
 */
export interface SandboxTask {
  /** Идентификатор задачи. */
  taskId?: string;
  /** Входные данные. */
  inputBuffer: Buffer;
  /** Формат входного файла. */
  inputFormat: string;
  /** Формат выходного файла. */
  outputFormat: string;
  /** Опции конвертации. */
  options?: Record<string, unknown>;
}

/**
 * Контекст выполнения задачи.
 *
 * `requestId` допускает null: контекст задачи создаётся
 * `createTaskContext(null, taskId)`, когда запроса нет (асинхронный путь).
 */
export interface SandboxContext {
  /** Идентификатор запроса. */
  requestId?: string | null;
  /** Идентификатор задачи. */
  taskId?: string;
  /** Синхронный режим. */
  isSync?: boolean;
}

/**
 * Результат конвертации.
 *
 * Ошибка описана по факту использования: конвертер проставляет в неё
 * `errorCode`, который уходит клиенту как код ошибки API.
 */
export interface ConversionResult {
  /** Признак успеха. */
  success: boolean;
  /** Результат конвертации при успехе. */
  result?: Buffer;
  /** Ошибка при неудаче. */
  error?: { errorCode?: string; message?: string };
}

/**
 * Ожидающий разрешения семафора.
 */
interface SemaphoreTicket {
  /** Выдаёт функцию освобождения разрешения. */
  resolve: (release: () => void) => void;
  /** Отклоняет ожидание (таймаут). */
  reject: (error: Error) => void;
  /** Таймер ожидания. */
  timer?: NodeJS.Timeout;
}

// ===========================================================================
// Семафор
// ===========================================================================

/**
 * Класс семафора
 */
class Semaphore {
  /** Текущее значение семафора. */
  value: number;
  /** Очередь ожидающих разрешения. */
  waiting: SemaphoreTicket[];

  /**
   * Создает семафор
   *
   * @param value - начальное значение
   */
  constructor(value: number) {
    this.value = value;
    this.waiting = [];
  }

  /**
   * Получает разрешение
   *
   * @param timeout - таймаут в мс
   */
  async acquire(timeout?: number): Promise<() => void> {
    if (this.value > 0) {
      this.value--;
      return () => this.release();
    }

    // Ожидаем освобождения
    return new Promise((resolve, reject) => {
      const ticket: SemaphoreTicket = { resolve, reject };
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
  release(): void {
    this.value++;

    // Выдаем разрешение ожидающему
    if (this.waiting.length > 0) {
      const ticket = this.waiting.shift();
      // Проверка нужна только для типов: длина очереди выше нуля,
      // поэтому shift() всегда возвращает элемент
      if (ticket) {
        if (ticket.timer) {
          clearTimeout(ticket.timer);
        }
        this.value--;
        ticket.resolve(() => this.release());
      }
    }
  }

  /**
   * Получает текущее значение
   */
  getValue(): number {
    return this.value;
  }

  /**
   * Проверяет, доступен ли семафор
   */
  isAvailable(): boolean {
    return this.value > 0;
  }
}

// ===========================================================================
// Семафор для задач
// ===========================================================================

/** Семафор задач. */
let taskSemaphore: Semaphore | null = null;

/**
 * Получает семафор задач
 */
export function getTaskSemaphore(): Semaphore {
  if (!taskSemaphore) {
    taskSemaphore = new Semaphore(MAX_CONCURRENT);
  }
  return taskSemaphore;
}

/**
 * Сбрасывает семафор
 */
export function resetTaskSemaphore(): void {
  taskSemaphore = null;
}

// ===========================================================================
// Выполнение задач
// ===========================================================================

/**
 * Выполняет задачу в sandbox
 *
 * @param task - данные задачи
 * @param task.inputBuffer - входные данные
 * @param task.inputFormat - формат входного файла
 * @param task.outputFormat - формат выходного файла
 * @param task.options - опции конвертации
 * @param context - контекст выполнения
 * @param context.requestId - идентификатор запроса
 * @param context.taskId - идентификатор задачи
 * @param context.isSync - синхронный режим
 */
export async function executeInSandbox(
  task: SandboxTask,
  context: SandboxContext = {}
): Promise<ConversionResult> {
  const {
    requestId,
    taskId,
    isSync = false,
  } = context;

  const semaphore = getTaskSemaphore();
  const forkPool = getForkPool();

  // Пытаемся получить разрешение
  let release: (() => void) | undefined;
  try {
    release = await semaphore.acquire(isSync ? SYNC_QUEUE_WAIT_MS : undefined);
  } catch (err) {
    throw new Error(`Queue is full: ${(err as Error).message}`);
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
      const error = err as { errorCode?: string; message?: string };
      logConversionError({
        requestId,
        taskId,
        code: error.errorCode || 'conversion_failed',
        message: error.message,
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
 * @param inputBuffer - входные данные
 * @param inputFormat - формат входного файла
 * @param outputFormat - формат выходного файла
 * @param options - опции
 * @param context - контекст
 */
export async function convertWithLimits(
  inputBuffer: Buffer,
  inputFormat: string,
  outputFormat: string,
  options: Record<string, unknown> = {},
  context: SandboxContext = {}
): Promise<ConversionResult> {
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
 * @param inputBuffer - входные данные
 * @param inputFormat - формат входного файла
 * @param outputFormat - формат выходного файла
 * @param options - опции
 * @param context - контекст
 */
export async function convertWithWasmSandbox(
  inputBuffer: Buffer,
  inputFormat: string,
  outputFormat: string,
  options: Record<string, unknown> = {},
  context: SandboxContext = {}
): Promise<Buffer> {
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

  // При успехе результат всегда есть: runTask резолвится только вместе с ним
  return result.result as Buffer;
}

// ===========================================================================
// Статистика
// ===========================================================================

/**
 * Получает статистику sandbox
 */
export function getSandboxStats(): {
  semaphore: { value: number; waiting: number };
  forkPool: ForkPoolHealth;
} {
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
  getSandboxStats,
};
