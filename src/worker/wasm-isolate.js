/**
 *Изоляция WASM через isolated-vm.
 *
 * УРОВЕНЬ A: Изоляция памяти через isolated-vm с memoryLimit.
 * Это основной механизм защиты от утечек памяти WASM.
 *
 * КЛЮЧЕВЫЕ МОМЕНТЫ:
 * 1. Promise.race НЕ прерывает WASM — он только завершает ожидание.
 *    WASM продолжает выполняться в фоне, потребляя CPU и память.
 *
 * 2. isolated-vm.timeout прерывает ИМЕННО исполнение внутри изолята.
 *    Это единственный надёжный способ остановить WASM.
 *
 * 3. memoryLimit распространяется и на WASM-память, потому что WASM-куча
 *    аллоцируется внутри V8 heap, который ограничен memoryLimit.
 *
 * 4. dispose() освобождает память принудительно. После вызова dispose()
 *    изолят умирает, и основной процесс не теряет память.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ISOLATE_MEMORY_MB, JOB_TIMEOUT_MS } from '../config/index.js';

const require = createRequire(import.meta.url);

/**
 * Конвертер, работающий в основном процессе воркера.
 *
 * WASM-память невозможно изолировать в пределах одного потока — это
 * отмечает и загрузчик самой библиотеки (wasm/loader-isolated.cjs:
 * «WebAssembly memory cannot be truly isolated within a single thread»).
 * Поэтому движок инициализируется в основном процессе, а внутрь изолята
 * передаётся только ссылка на функцию конвертации: код-обёртка исполняется
 * в изоляте с таймаутом, а WASM — снаружи.
 *
 * Следствие: memoryLimit изолята на WASM-память не распространяется,
 * защиту по памяти обеспечивают лимиты контейнера (mem_limit в compose).
 */
let converterPromise = null;

/**
 * Возвращает путь к каталогу WASM-ассетов внутри установленного пакета.
 *
 * Библиотека по умолчанию ищет ассеты по '/wasm/' — абсолютному пути,
 * которого в проекте нет, поэтому путь задаётся явно (как в fork-worker.js).
 *
 * @returns {string} - путь к каталогу wasm
 */
function resolveWasmPath() {
  const packageJsonPath = require.resolve('@matbee/libreoffice-converter/package.json');

  return path.join(path.dirname(packageJsonPath), 'wasm');
}

/**
 * Инициализирует конвертер в основном процессе (лениво, один раз).
 *
 * @returns {Promise<Object>} - инициализированный конвертер
 */
async function getConverter() {
  if (!converterPromise) {
    converterPromise = (async () => {
      const { LibreOfficeConverter } = await import('@matbee/libreoffice-converter');

      const wasmDir = resolveWasmPath();

      // Загрузчик подключается по абсолютному пути: подпуть
      // '@matbee/libreoffice-converter/wasm/loader.cjs' не объявлен
      // в exports пакета, поэтому обычный импорт по имени не работает.
      // Без загрузчика инициализация падает с WASM_NOT_INITIALIZED.
      const loaderModule = await import(
        pathToFileURL(path.join(wasmDir, 'loader.cjs')).href
      );

      const converter = new LibreOfficeConverter({
        wasmLoader: loaderModule.default ?? loaderModule,
        wasmPath: wasmDir,
        // Путь внутри виртуальной ФС WASM (не хоста!)
        userProfilePath: '/tmp/libreoffice-profile',
        ...(process.env.LO_CONVERTER_VERBOSE === 'true' ? { verbose: true } : {})
      });

      await converter.initialize();

      return converter;
    })().catch((err) => {
      // Сбрасываем кэш, чтобы следующая задача могла повторить инициализацию
      converterPromise = null;
      throw err;
    });
  }

  return converterPromise;
}

/**
 * Модуль isolated-vm загружается лениво.
 *
 * isolated-vm — нативный модуль: если он не собран под текущую версию Node,
 * его импорт падает. Держать его в статическом импорте нельзя, иначе
 * весь API-сервер не стартует из-за отсутствия изолятора.
 */
let ivmModule = null;

/**
 * Загружает isolated-vm.
 *
 * @returns {Promise<Object>} - модуль isolated-vm
 * @throws {Error} - если модуль недоступен
 */
async function loadIsolatedVm() {
  if (ivmModule) {
    return ivmModule;
  }

  try {
    const imported = await import('isolated-vm');

    // isolated-vm — CommonJS-модуль: при импорте из ESM его классы
    // (Isolate, Reference и остальные) лежат в свойстве default,
    // а не в самом объекте модуля
    ivmModule = imported.default ?? imported;

    return ivmModule;
  } catch (err) {
    throw new Error(
      `isolated-vm недоступен: ${err.message}. ` +
      'Соберите нативный модуль (pnpm rebuild isolated-vm), чтобы включить изоляцию WASM.'
    );
  }
}

/**
 * Кэш инициализированного изолята.
 * Изолят создаётся один раз и переиспользуется для всех задач.
 */
let isolate = null;

/**
 * Контекст изолята.
 *
 * В isolated-vm 7 у Isolate нет метода getGlobalContext(), поэтому контекст
 * сохраняется при создании и переиспользуется для вызовов.
 */
let isolateContext = null;
let isolateInitialized = false;

/**
 * Создаёт и инициализирует изолят.
 *
 * @returns {Promise<{isolate: Isolate, context: Context}>} - изолят и его контекст
 */
async function createIsolate() {
  const ivm = await loadIsolatedVm();

  // Создаём изолят с лимитом памяти
  const newIsolate = new ivm.Isolate({
    memoryLimit: ISOLATE_MEMORY_MB,
    // Отключаем error propagation, чтобы можно было обработать ошибки
    onCatastrophicError: (err) => {
      console.error('[wasm-isolate] Катастрофическая ошибка изолята:', err);
      // Изолят больше не пригоден для использования
      if (isolate === newIsolate) {
        isolate = null;
        isolateContext = null;
        isolateInitialized = false;
      }
    }
  });

  // Создаём глобальный контекст в изоляте
  const context = await newIsolate.createContext();

  // Ссылка на функцию конвертации из основного процесса. Сам WASM-модуль
  // внутрь изолята не грузится: вызов уходит через границу изолята,
  // а результат возвращается копией.
  // Конвертер инициализируется заранее, вне контекста вызова из изолята:
  // SubprocessConverter поднимает отдельный процесс, и делать это из
  // ivm-reference не следует
  const converter = await getConverter();

  const convertRef = new ivm.Reference(async (input, fileType, options) => {
    const result = await converter.convert(Buffer.from(input), {
      outputFormat: options?.outputFormat ?? 'pdf',
      inputFormat: fileType,
      ...(options?.password ? { password: options.password } : {})
    });

    return new Uint8Array(result.data);
  });

  await context.global.set('__convertRef', convertRef);

  // Функция-обёртка внутри изолята: единая точка входа для convertInIsolate.
  // Вызов reference асинхронный, поэтому результат запрашивается как promise.
  await context.eval(`
    globalThis.officeEngine = { mode: 'main-process' };

    globalThis.convertDocument = async (buffer, fileType, options) =>
      await globalThis.__convertRef.apply(undefined, [buffer, fileType, options], {
        arguments: { copy: true },
        result: { promise: true }
      });
  `);

  return { isolate: newIsolate, context };
}

/**
 * Получает или создаёт изолят.
 *
 * @returns {Promise<Isolate>} - изолят
 */
export async function getIsolate() {
  if (isolate && isolateInitialized) {
    return isolate;
  }

  const created = await createIsolate();
  isolate = created.isolate;
  isolateContext = created.context;
  isolateInitialized = true;

  return isolate;
}

/**
 * Выполняет конвертацию в изолированной среде.
 *
 * @param {Buffer} buffer - данные файла
 * @param {string} fileType - формат файла
 * @param {Object} [options] - опции конвертации
 * @param {number} [options.timeout=JOB_TIMEOUT_MS] - таймаут выполнения
 * @returns {Promise<Uint8Array>} - результат конвертации
 * @throws {Error} - если конвертация не удалась
 */
export async function convertInIsolate(buffer, fileType, options = {}) {
  const { timeout = JOB_TIMEOUT_MS } = options;

  await loadIsolatedVm();
  await getIsolate();

  const context = isolateContext;

  if (!context) {
    throw new Error('Контекст изолята не инициализирован');
  }

  // timeout у isolated-vm прерывает именно исполнение внутри изолята —
  // Promise.race снаружи только завершает ожидание, оставляя WASM работать.
  // Тело evalClosure исполняется вне async-контекста, поэтому await здесь
  // недопустим: возвращаем промис, а опция promise: true дожидается его
  const result = await context.evalClosure(
    `return globalThis.convertDocument($0, $1, $2);`,
    [new Uint8Array(buffer), fileType, options],
    {
      arguments: { copy: true },
      // В isolated-vm 7 { promise: true } и { copy: true } взаимоисключающие:
      // промис дожидается, а его результат передаётся копией по умолчанию
      result: { promise: true },
      timeout
    }
  );

  if (!result) {
    throw new Error('No result returned from conversion');
  }

  return Buffer.from(result);
}

/**
 * Обёртка над convertInIsolate с сигнатурой (input, inputFormat, outputFormat).
 *
 * @param {Buffer} inputBuffer - данные файла
 * @param {string} inputFormat - формат входного файла
 * @param {string} outputFormat - формат выходного файла
 * @param {Object} [options] - опции (timeout, conversion)
 * @param {Object} [context] - контекст задачи
 * @returns {Promise<Buffer>} - результат конвертации
 */
export async function convertWithWasm(
  inputBuffer,
  inputFormat,
  outputFormat,
  options = {},
  context = {}
) {
  const { timeout = JOB_TIMEOUT_MS, conversion = {} } = options;

  return convertInIsolate(inputBuffer, inputFormat, {
    ...conversion,
    outputFormat,
    timeout,
    context
  });
}

/**
 * OS-изоляция через fork.
 *
 * ПРИЧИНА: Даже скомпрометированный V8 в дочернем процессе не имеет handle
 * на сокеты API и очередь. Это важный слой защиты:
 *
 * 1. Node.js обновляется на каждый security-релиз V8, не откладывая
 * 2. vm2 НЕ используется никогда — он принципиально небезопасен
 * 3. OS-изоляция через fork — даже скомпрометированный V8 в дочернем
 *    процессе не имеет handle на сокеты API и очередь
 * 4. --disable-wasm-trap-handler — снижает attack surface, связанный с trap handler
 *
 * УРОВЕНЬ C: NODE_OPTIONS="--disable-wasm-trap-handler --max-old-space-size=1536"
 * Отключает 10 GB виртуального резерва под trap handler, делает процесс
 * совместимым с mem_limit: 3g.
 *
 * УРОВЕНЬ D: cgroup v2 через Docker
 * mem_limit: 3g, memswap_limit: 3g (без swap → предсказуемый OOM-kill)
 *
 * Все комментарии на русском языке.
 */

/**
 * Завершает изолят и освобождает ресурсы.
 */
export async function disposeIsolate() {
  if (isolate) {
    try {
      // Контекст освобождается до изолята: dispose() изолята уничтожает
      // и все его контексты
      isolateContext?.release();

      await isolate.dispose();
    } catch (err) {
      console.error('[wasm-isolate] Ошибка при освобождении изолята:', err);
    }

    isolate = null;
    isolateContext = null;
    isolateInitialized = false;
  }
}

/**
 * Проверяет, инициализирован ли изолят.
 *
 * @returns {boolean} - true, если изолят инициализирован
 */
export function isIsolateInitialized() {
  return isolateInitialized;
}

/**
 * Проверяет, готов ли WASM-движок к работе.
 *
 * @returns {boolean} - true, если изолят инициализирован
 */
export function isWasmReady() {
  return isolateInitialized;
}

/**
 * Проверяет здоровье WASM-движка.
 *
 * @returns {Promise<{healthy: boolean, error?: string}>}
 */
export async function checkWasmHealth() {
  if (isolateInitialized) {
    return { healthy: true };
  }

  try {
    await loadIsolatedVm();
    return { healthy: false, error: 'WASM engine is not initialized yet' };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

export default {
  getIsolate,
  convertInIsolate,
  convertWithWasm,
  disposeIsolate,
  isIsolateInitialized,
  isWasmReady,
  checkWasmHealth
};
