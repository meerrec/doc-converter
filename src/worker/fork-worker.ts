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
import type {
  InputFormat,
  LibreOfficeWasmOptions,
  OutputFormat,
} from '@matbee/libreoffice-converter';

const require = createRequire(import.meta.url);

/**
 * Опции конвертации, которые читает воркер.
 *
 * Опции приходят из родительского процесса как есть (в формате Р7-Офис),
 * поэтому у объекта есть и другие ключи — они движком не используются.
 */
interface ConvertOptions {
  /** Пароль защищённого документа. */
  password?: string;
  /** Прочие опции, которые движок игнорирует. */
  [key: string]: unknown;
}

/**
 * Сообщение от родительского процесса.
 *
 * Поля необязательны: состав сообщения проверяется обработчиком, а не типом —
 * родитель и дочерний процесс общаются через IPC.
 */
interface ParentMessage {
  /** Тип сообщения. */
  type?: string;
  /** Входные данные конвертации. */
  inputBuffer?: Uint8Array | number[];
  /** Формат входного файла. */
  inputFormat?: string;
  /** Формат выходного файла. */
  outputFormat?: string;
  /** Опции конвертации. */
  options?: ConvertOptions;
}

/**
 * Модуль WASM-конвертера загружается лениво.
 *
 * Он тяжёлый (WASM-ассеты) и требует установленных peer-зависимостей,
 * поэтому ошибку загрузки нужно отдать понятным сообщением, а не падением
 * процесса при импорте.
 *
 * @returns модуль @matbee/libreoffice-converter
 */
let converterModule: typeof import('@matbee/libreoffice-converter') | null = null;

async function loadConverter(): Promise<typeof import('@matbee/libreoffice-converter')> {
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
 * @returns путь к каталогу wasm
 */
function resolveWasmPath(): string {
  const packageJsonPath = require.resolve('@matbee/libreoffice-converter/package.json');
  return path.join(path.dirname(packageJsonPath), 'wasm');
}

/**
 * Опции инициализации WASM-движка.
 *
 * @returns опции для @matbee/libreoffice-converter
 */
function buildConverterOptions(): LibreOfficeWasmOptions {
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
 * @param message - сообщение
 */
async function handleMessage(message: ParentMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'convert':
        await handleConvert(message);
        break;

      default:
        sendError(`Unknown message type: ${message.type}`);
    }
  } catch (err) {
    sendError(`Unhandled error: ${(err as Error).message}`);
  }
}

/**
 * Обрабатывает сообщение о конвертации.
 *
 * @param message - сообщение
 * @param message.inputBuffer - входные данные
 * @param message.inputFormat - формат входного файла
 * @param message.outputFormat - формат выходного файла
 * @param message.options - опции конвертации
 */
async function handleConvert(message: ParentMessage): Promise<void> {
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
        outputFormat: outputFormat as OutputFormat,
        inputFormat: inputFormat as InputFormat,
        password: options.password,
      },
      buildConverterOptions()
    );

    sendSuccess(result.data);
  } catch (err) {
    sendError(`Conversion failed: ${(err as Error).message}`);
  }
}

/**
 * Отправляет успешный результат.
 *
 * @param data - результат конвертации
 */
function sendSuccess(data: Uint8Array | Buffer): void {
  if (process.send) {
    process.send({
      result: Array.from(data)
    });
  }
}

/**
 * Отправляет ошибку.
 *
 * @param error - сообщение об ошибке
 */
function sendError(error: string): void {
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
