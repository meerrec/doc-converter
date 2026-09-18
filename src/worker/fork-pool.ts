/**
 *Пул форкнутых процессов для выполнения задач конвертации.
 *
 * Переиспользует процессы для повышения производительности:
 * - Создание нового fork-процесса стоит ~50-100мс
 * - При пуле размером FORK_POOL_SIZE (4) мы экономим это время
 * - Процессы переиспользуются для разных задач
 *
 * При таймауте процесс убивается SIGKILL и создаётся новый.
 *
 * Все комментарии на русском языке.
 */

import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import { FORK_POOL_SIZE, JOB_TIMEOUT_MS } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Путь к fork-worker скрипту.
 */
const FORK_WORKER_PATH = path.join(__dirname, 'fork-worker.js');

/**
 * Элемент пула форкнутых процессов.
 */
interface PoolItem {
  /** Дочерний процесс. */
  child: ChildProcess;
  /** Признак занятости процесса. */
  busy: boolean;
  /** Время последнего использования. */
  lastUsed: number;
}

/**
 * Пул форкнутых процессов.
 * Каждый элемент: { child: ChildProcess, busy: boolean, lastUsed: number }
 */
const pool: PoolItem[] = [];

/**
 * Задача на конвертацию.
 */
export interface PoolTask {
  /** Входные данные. */
  inputBuffer: Buffer;
  /** Формат входного файла. */
  inputFormat: string;
  /** Формат вывода. */
  outputFormat: string;
  /** Опции конвертации. */
  options?: Record<string, unknown>;
}

/**
 * Опции выполнения задачи.
 */
export interface RunTaskOptions {
  /** Таймаут выполнения. */
  timeout?: number;
}

/**
 * Здоровье пула.
 */
export interface ForkPoolHealth {
  /** Всего процессов в пуле. */
  total: number;
  /** Свободные процессы. */
  available: number;
  /** Занятые процессы. */
  busy: number;
  /** Настроенный размер пула. */
  poolSize: number;
  /** Признак работоспособности. */
  healthy: boolean;
}

/**
 * Результат выполнения задачи.
 */
export interface TaskResult {
  /** Признак успеха. */
  success: boolean;
  /** Буфер результата. */
  result?: Buffer;
  /** Ошибка выполнения. */
  error?: Error;
}

/**
 * Сообщение от fork-worker.
 *
 * Поля необязательны: конкретный вид сообщения определяется по содержимому —
 * воркер шлёт { type: 'ready' }, { error } либо { result }.
 */
interface ForkWorkerMessage {
  /** Тип сообщения. */
  type?: string;
  /** Текст ошибки. */
  error?: string;
  /** Результат конвертации (массив байтов). */
  result?: number[];
}

/**
 * Проверяет, что сообщение от процесса — объект.
 *
 * @param value - значение из канала обмена
 */
function isForkWorkerMessage(value: unknown): value is ForkWorkerMessage {
  return typeof value === 'object' && value !== null;
}

/**
 * Создаёт новый fork-процесс.
 *
 * @returns fork-процесс
 */
function createFork(): ChildProcess {
  const child = fork(FORK_WORKER_PATH, [], {
    // Настройки безопасности и производительности
    execArgv: [
      '--disable-wasm-trap-handler',
      `--max-old-space-size=${1536}`
    ],
    // advanced serialization умеет передавать Buffer без превращения
    // в JSON-массив чисел (иначе 100 МБ файл раздувается на порядок)
    serialization: 'advanced'
    // Ограничение по памяти будет через Docker cgroups
    // В Node.js нет встроенного ограничения памяти для child_process
  });

  // Обработка ошибок процесса
  child.on('error', (err) => {
    console.error('[fork-pool] Ошибка процесса:', err);
  });

  child.on('exit', (code, signal) => {
    console.log(`[fork-pool] Процесс завершился: code=${code}, signal=${signal}`);
  });

  return child;
}

/**
 * Инициализирует пул (лениво — при первом использовании).
 *
 * Форкать процессы на этапе импорта модуля нельзя: API-процессу пул
 * не нужен, а тесты получают 4 висящих дочерних процесса.
 */
function ensurePool(): void {
  while (pool.length < FORK_POOL_SIZE) {
    pool.push({
      child: createFork(),
      busy: false,
      lastUsed: 0
    });
  }
}

/**
 * Получает свободный процесс из пула.
 *
 * @returns объект процесса из пула
 */
function getAvailableFork(): PoolItem {
  ensurePool();

  // Ищем свободный процесс
  for (const item of pool) {
    if (!item.busy) {
      item.busy = true;
      item.lastUsed = Date.now();
      return item;
    }
  }

  // Если нет свободных, создаём новый (мотре чем ждать)
  // Это временное решение, в production нужно строго ограничивать пул
  const newItem = {
    child: createFork(),
    busy: true,
    lastUsed: Date.now()
  };
  pool.push(newItem);
  return newItem;
}

/**
 * Выполняет задачу через пул.
 *
 * @param task - данные задачи
 * @param task.inputBuffer - входные данные
 * @param task.inputFormat - формат входного файла
 * @param task.outputFormat - формат вывода
 * @param task.options - опции конвертации
 * @param options - опции выполнения
 * @param options.timeout - таймаут выполнения
 * @returns результат
 */
export async function runTask(
  task: PoolTask,
  options: RunTaskOptions = {}
): Promise<TaskResult> {
  const { timeout = JOB_TIMEOUT_MS } = options;
  const { inputBuffer, inputFormat, outputFormat, options: taskOptions = {} } = task;

  // Получаем процесс из пула
  const forkItem = getAvailableFork();
  const child = forkItem.child;

  return new Promise((resolve, reject) => {
    let hasResolved = false;
    let timeoutId: NodeJS.Timeout | undefined;

    // Функция завершения с ошибкой
    const completeError = (err: Error) => {
      if (hasResolved) return;
      hasResolved = true;
      cleanup();
      reject(err);
    };

    // Функция завершения с успехом
    const completeSuccess = (result: Buffer) => {
      if (hasResolved) return;
      hasResolved = true;
      cleanup();
      resolve({ success: true, result });
    };

    // Функция очистки
    const cleanup = () => {
      clearTimeout(timeoutId);
      child.off('message', messageHandler);
      child.off('exit', exitHandler);
      forkItem.busy = false;
    };

    // Обработчик сообщений: слушаем постоянно, а не once —
    // воркер при старте отправляет { type: 'ready' }
    const messageHandler = (message: unknown) => {
      if (!isForkWorkerMessage(message)) {
        return;
      }

      if (message.type === 'ready') {
        // Процесс готов к работе, ждём результат
        return;
      }

      if (message.error) {
        completeError(new Error(message.error));
        return;
      }

      if (message.result) {
        // Преобразуем массив байтов в Buffer
        const resultBuffer = Buffer.from(message.result);
        completeSuccess(resultBuffer);
      }
    };

    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      if (hasResolved) return;

      if (signal === 'SIGKILL') {
        completeError(new Error('conversion_timeout'));
        return;
      }

      if (code !== 0) {
        completeError(new Error(`Process exited with code ${code}`));
      }
    };

    // Устанавливаем таймер для SIGKILL
    timeoutId = setTimeout(() => {
      if (hasResolved) return;

      hasResolved = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch (err) {
        console.error('[fork-pool] Ошибка SIGKILL:', err);
      }
      reject(new Error('conversion_timeout'));
    }, timeout);

    // Устанавливаем обработчики
    child.on('message', messageHandler);
    child.on('exit', exitHandler);

    // Отправляем задачу
    try {
      child.send({
        type: 'convert',
        inputBuffer,
        inputFormat,
        outputFormat,
        options: taskOptions
      });
    } catch (err) {
      completeError(new Error(`Failed to send task: ${(err as Error).message}`));
    }
  });
}

/**
 * Получает здоровье пула.
 *
 * @returns информация о пуле
 */
export function getHealth(): ForkPoolHealth {
  const available = pool.filter(item => !item.busy).length;
  const busy = pool.filter(item => item.busy).length;
  const total = pool.length;

  return {
    total,
    available,
    busy,
    poolSize: FORK_POOL_SIZE,
    healthy: available > 0
  };
}

/**
 * Возвращает объект пула для использования в sandbox.
 */
export function getForkPool(): {
  runTask: typeof runTask;
  getHealth: typeof getHealth;
} {
  return {
    runTask,
    getHealth
  };
}

export default {
  runTask,
  getHealth,
  getForkPool
};
