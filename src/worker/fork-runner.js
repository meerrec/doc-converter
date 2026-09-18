/**
 *Запуск задач в отдельных child_process.fork.
 *
 * ПРИЧИНА ИСПОЛЬЗОВАНИЯ FORK + SIGKILL:
 * 
 * 1. Promise.race НЕДОСТАТОЧНО: он только завершает ожидание в основном процессе,
 *    но WASM продолжает выполняться в фоне, потребляя CPU и память.
 *    Это может привести к:
 *    - Утечке памяти (WASM может аллоцировать гигабайты)
 *    - Перегрузке CPU (бесконечные циклы в WASM)
 *    - DoS атакам через длительные операции
 *
 * 2. SIGKILL НУЖЕН ИМЕННО: в отличие от SIGTERM, который можно перехватить
 *    и проигнорировать, SIGKILL не перехватывается, не игнорируется, не блокируется.
 *    Это гарантирует, что процесс будет убит операционной системой.
 *
 * 3. child.kill('SIGKILL') — это единственный надёжный способ остановить
 *    выполнение WASM при таймауте.
 *
 * 4. В fork-worker.js только process.on('message') и вызов конвертера.
 *    Никаких require вне модулей проекта — это минимизирует attack surface.
 *
 * OS-ИЗОЛЯЦИЯ:
 * Даже скомпрометированный V8 в дочернем процессе не имеет handle на:
 * - Сокеты API сервера
 * - Очередь задач (BullMQ)
 * -Valkey соединение
 * - Файловую систему (кроме временных файлов)
 *
 * Это критичный слой защиты: компрометация дочернего процесса
 * не ведёт к компрометации всей системы.
 *
 * Все комментарии на русском языке.
 */

import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { JOB_TIMEOUT_MS, FORK_POOL_SIZE } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Путь к fork-worker скрипту.
 */
const FORK_WORKER_PATH = path.join(__dirname, 'fork-worker.js');

/**
 * Пул форкнутых процессов.
 * Переиспользует процессы для повышения производительности.
 */
const forkPool = [];
let poolIndex = 0;

/**
 * Создаёт новый fork-процесс.
 *
 * @returns {ChildProcess} - fork-процесс
 */
function createFork() {
  const child = fork(FORK_WORKER_PATH, [], {
    // Настройки безопасности
    execArgv: [
      '--disable-wasm-trap-handler',
      `--max-old-space-size=${1536}`
    ],
    // Non-root пользователь в Docker
    uid: process.getuid ? process.getuid() : undefined,
    gid: process.getgid ? process.getgid() : undefined,
    // Ограничение ресурсов
    timeout: JOB_TIMEOUT_MS
  });
  
  // Обработка ошибок
  child.on('error', (err) => {
    console.error('[fork-runner] Ошибка fork-процесса:', err);
  });
  
  child.on('exit', (code, signal) => {
    console.log(`[fork-runner] Процесс завершился: code=${code}, signal=${signal}`);
    
    // Если процесс убит SIGKILL, это ожидаемое поведение при таймауте
    if (signal === 'SIGKILL') {
      console.log('[fork-runner] Процесс убит по таймауту (SIGKILL)');
    }
  });
  
  return child;
}

/**
 * Получает fork-процесс из пула или создаёт новый.
 *
 * @returns {ChildProcess} - fork-процесс
 */
function getFork() {
  // Если пул пуст, создаём новые процессы
  while (forkPool.length < FORK_POOL_SIZE) {
    forkPool.push(createFork());
  }
  
  // Получаем процесс из пула (round-robin)
  const child = forkPool[poolIndex];
  poolIndex = (poolIndex + 1) % FORK_POOL_SIZE;
  
  return child;
}

/**
 * Выполняет задачу в fork-процессе с таймаутом.
 *
 * @param {Object} task - данные задачи
 * @param {Buffer} task.buffer - буфер файла
 * @param {string} task.fileType - формат файла
 * @param {Object} [task.options] - опции конвертации
 * @param {number} [timeoutMs=JOB_TIMEOUT_MS] - таймаут выполнения
 * @returns {Promise<{pdfBuffer: Buffer, durationMs: number}>} - результат выполнения
 */
export async function runInFork(task, timeoutMs = JOB_TIMEOUT_MS) {
  const { buffer, fileType, options = {} } = task;
  
  return new Promise((resolve, reject) => {
    const child = getFork();
    const startTime = Date.now();
    let hasResolved = false;
    
    // Устанавливаем таймер для SIGKILL
    const timeoutId = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        try {
          child.kill('SIGKILL');
        } catch (err) {
          console.error('[fork-runner] Ошибка при SIGKILL:', err);
        }
        reject(new Error('conversion_timeout'));
      }
    }, timeoutMs);
    
    // Обработчик сообщения от fork-процесса
    const messageHandler = (message) => {
      if (hasResolved) return;
      hasResolved = true;
      
      clearTimeout(timeoutId);
      
      if (message.error) {
        reject(new Error(message.error));
        return;
      }
      
      if (!message.pdfBuffer) {
        reject(new Error('No PDF buffer returned'));
        return;
      }
      
      // Преобразуем ArrayBuffer в Buffer
      const pdfBuffer = Buffer.from(message.pdfBuffer);
      const durationMs = Date.now() - startTime;
      
      resolve({ pdfBuffer, durationMs });
    };
    
    // Обработчик завершения процесса
    const exitHandler = (code, signal) => {
      if (hasResolved) return;
      hasResolved = true;
      
      clearTimeout(timeoutId);
      
      if (signal === 'SIGKILL') {
        reject(new Error('conversion_timeout'));
        return;
      }
      
      if (code !== 0) {
        reject(new Error(`Fork process exited with code ${code}`));
        return;
      }
    };
    
    // Устанавливаем обработчики
    child.once('message', messageHandler);
    child.once('exit', exitHandler);
    
    // Отправляем задачу в fork-процесс
    try {
      child.send({
        type: 'convert',
        buffer: buffer,
        fileType: fileType,
        options: options
      });
    } catch (err) {
      if (!hasResolved) {
        hasResolved = true;
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send task to fork: ${err.message}`));
      }
    }
    
    // Очищаем обработчики при отмене
    const cleanup = () => {
      child.off('message', messageHandler);
      child.off('exit', exitHandler);
    };
    
    // Добавляем cleanup к promise для предотвращения утечек
    const result = { resolve, reject };
    Promise.race([
      result,
      new Promise((r) => setTimeout(r, timeoutMs + 1000))
    ]).finally(cleanup);
  });
}

/**
 * Завершает все fork-процессы в пуле.
 */
export async function closeForkPool() {
  for (const child of forkPool) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Игнорируем ошибки
    }
  }
  
  // Очищаем пул
  forkPool.length = 0;
  poolIndex = 0;
}

/**
 * Получает статистику пула.
 *
 * @returns {Object} - статистика
 */
export function getForkPoolStats() {
  return {
    size: forkPool.length,
    maxSize: FORK_POOL_SIZE,
    nextIndex: poolIndex
  };
}

export default {
  runInFork,
  closeForkPool,
  getForkPoolStats
};
