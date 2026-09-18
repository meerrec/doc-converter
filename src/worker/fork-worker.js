/**
 *Дочерний процесс для выполнения конвертации в изолированной среде.
 *
 * ВНИМАНИЕ:
 * - В этом файле только process.on('message') и вызов конвертера
 * - Никаких require вне модулей проекта
 * - Это минимизирует attack surface
 *
 * ПРИЧИНА:
 * Даже если этот процесс будет скомпрометирован (например, через уязвимость в WASM),
 * он не имеет доступа к:
 * - Сокетам API сервера
 * - Очереди задач (BullMQ)
 * - Valkey соединению
 * - Файловой системе (кроме временных файлов)
 *
 * OS-изоляция через fork гарантирует, что компрометация дочернего процесса
 * не ведёт к компрометации всей системы.
 *
 * ВАЖНО: процесс запускается через child_process.fork(), поэтому обмен
 * сообщениями идёт через process.send/process.on('message'), а не через
 * worker_threads.parentPort.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Модуль WASM-конвертера загружается лениво.
 *
 * Он тяжёлый (WASM-ассеты) и требует установленных peer-зависимостей,
 * поэтому ошибку загрузки нужно отдать понятным сообщением, а не падением
 * процесса при импорте.
 *
 * @returns {Promise<Object>} - модуль @matbee/libreoffice-converter
 */
let converterModule = null;

async function loadConverter() {
  if (!converterModule) {
    converterModule = await import('@matbee/libreoffice-converter');
  }

  return converterModule;
}

/**
 * Возвращает путь к каталогу WASM-ассетов внутри установленного пакета.
 *
 * Библиотека по умолчанию ищет ассеты по '/wasm/' — абсолютному пути,
 * которого в проекте нет, поэтому путь нужно задавать явно.
 *
 * @returns {string} - путь к каталогу wasm
 */
function resolveWasmPath() {
  const packageJsonPath = require.resolve('@matbee/libreoffice-converter/package.json');
  return path.join(path.dirname(packageJsonPath), 'wasm');
}

/**
 * Опции инициализации WASM-движка.
 *
 * @returns {Object} - опции для @matbee/libreoffice-converter
 */
function buildConverterOptions() {
  return {
    wasmPath: resolveWasmPath(),
    // Путь внутри виртуальной ФС WASM (не хоста!): /instdir доступен
    // только для чтения, а /tmp в Emscripten FS записываемый
    userProfilePath: '/tmp/libreoffice-profile',
    ...(process.env.LO_CONVERTER_VERBOSE === 'true' ? { verbose: true } : {})
  };
}

/**
 * Обработчик сообщений от родительского процесса.
 *
 * @param {Object} message - сообщение
 */
async function handleMessage(message) {
  try {
    switch (message.type) {
      case 'convert':
        await handleConvert(message);
        break;

      default:
        sendError(`Unknown message type: ${message.type}`);
    }
  } catch (err) {
    sendError(`Unhandled error: ${err.message}`);
  }
}

/**
 * Обрабатывает сообщение о конвертации.
 *
 * @param {Object} message - сообщение
 * @param {Array<number>|Uint8Array} message.inputBuffer - входные данные
 * @param {string} message.inputFormat - формат входного файла
 * @param {string} message.outputFormat - формат выходного файла
 * @param {Object} [message.options] - опции конвертации
 */
async function handleConvert(message) {
  const { inputBuffer, inputFormat, outputFormat, options = {} } = message;

  if (!inputBuffer || !outputFormat) {
    sendError('Missing inputBuffer or outputFormat');
    return;
  }

  try {
    const converter = await loadConverter();

    const result = await converter.convertDocument(
      Buffer.from(inputBuffer),
      {
        outputFormat,
        inputFormat,
        password: options.password,
      },
      buildConverterOptions()
    );

    sendSuccess(result.data);
  } catch (err) {
    sendError(`Conversion failed: ${err.message}`);
  }
}

/**
 * Отправляет успешный результат.
 *
 * @param {Uint8Array|Buffer} data - результат конвертации
 */
function sendSuccess(data) {
  if (process.send) {
    process.send({
      result: Array.from(data)
    });
  }
}

/**
 * Отправляет ошибку.
 *
 * @param {string} error - сообщение об ошибке
 */
function sendError(error) {
  if (process.send) {
    process.send({ error });
  }
}

// Обработка сообщений от родителя
process.on('message', handleMessage);

process.on('error', (err) => {
  console.error('[fork-worker] Error:', err);
});

// Сообщаем о готовности
if (process.send) {
  process.send({ type: 'ready' });
}

// Обработка graceful shutdown
process.on('SIGTERM', () => {
  process.exit(0);
});

export default handleMessage;
