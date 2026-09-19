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
  SubprocessConverter,
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
 * `userProfilePath` здесь стоял до перехода на библиотеку 2.x: раньше профиль
 * приходилось уводить в записываемый /tmp виртуальной ФС WASM, потому что
 * /instdir доступен только для чтения. В 2.x библиотека размещает профиль
 * сама, и опция из неё удалена — передавать её больше не нужно.
 *
 * @returns опции для @matbee/libreoffice-converter
 */
function buildConverterOptions(): LibreOfficeWasmOptions {
  return {
    wasmPath: resolveWasmPath(),
    ...(process.env.LO_CONVERTER_VERBOSE === 'true' ? { verbose: true } : {})
  };
}

/**
 * Конвертер, переиспользуемый между задачами процесса.
 *
 * Раньше здесь вызывался `convertDocument`, который создаёт конвертер и
 * уничтожает его после каждой конвертации. Почти всё время уходило на
 * инициализацию: она читает WASM-ассеты и сканирует шрифты. Замерено на
 * одном документе: создание конвертера ~0.8 с, первая конвертация ~0.3 с,
 * каждая следующая — ~12 мс. То есть на каждой задаче терялись секунды.
 *
 * При параллельной работе это же было причиной отказов: несколько процессов
 * одновременно сканировали шрифты, конвертация не укладывалась в
 * JOB_TIMEOUT_MS, и fork-процессы убивались по таймауту.
 */
let converterPromise: Promise<SubprocessConverter> | null = null;

/**
 * Возвращает конвертер, создавая его при первом обращении.
 *
 * Хранится именно промис, а не готовый конвертер: прогрев и первая задача
 * могут запросить его одновременно, и без общего промиса создались бы два
 * конвертера, один из которых остался бы без присмотра.
 *
 * @returns готовый к работе конвертер
 */
async function getConverter(): Promise<SubprocessConverter> {
  if (!converterPromise) {
    converterPromise = (async () => {
      const { createSubprocessConverter } = await loadConverter();
      return await createSubprocessConverter(buildConverterOptions());
    })();
  }

  return converterPromise;
}

/**
 * Уничтожает конвертер, чтобы следующая задача начала с чистого состояния.
 *
 * Нужен после ошибки конвертации: WASM-субпроцесс мог быть убит по таймауту
 * (`restartOnMemoryError` пересоздаёт его не во всех случаях), и повторное
 * использование такого конвертера вернуло бы ту же ошибку.
 */
async function resetConverter(): Promise<void> {
  const pending = converterPromise;
  converterPromise = null;

  if (pending) {
    try {
      await (await pending).destroy();
    } catch {
      // Конвертер мог уже умереть — на исход задачи это не влияет
    }
  }
}

/**
 * Прогревает конвертер — создаёт его до первой задачи.
 *
 * Инициализация читает WASM-ассеты и сканирует шрифты, и она плохо
 * масштабируется: если несколько процессов пула делают это одновременно,
 * они не укладываются в `JOB_TIMEOUT_MS` и задачи падают с
 * `conversion_timeout`. Пул вызывает прогрев по одному процессу (см.
 * `warmupPool` в fork-pool.ts), а результат сообщает родителю.
 */
async function handleWarmup(): Promise<void> {
  try {
    await getConverter();
    process.send?.({ type: 'warmup-done' });
  } catch (err) {
    sendError(`Warmup failed: ${(err as Error).message}`);
  }
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

      case 'warmup':
        await handleWarmup();
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
    const activeConverter = await getConverter();

    const result = await activeConverter.convert(
      Buffer.from(inputBuffer),
      {
        outputFormat: outputFormat as OutputFormat,
        inputFormat: inputFormat as InputFormat,
        password: options.password,
      }
    );

    sendSuccess(result.data);
  } catch (err) {
    // Сбрасываем конвертер: после ошибки он может остаться нерабочим
    // (например, с убитым WASM-субпроцессом), и следующая задача получила бы
    // ту же ошибку. Цена — повторная инициализация на следующей задаче
    await resetConverter();
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
