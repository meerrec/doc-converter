/**
 * Загрузка браузерной сборки LibreOffice и получение сессии.
 *
 * Сборка — это Emscripten-модуль, и подключается она не как обычный скрипт:
 * перед загрузкой `soffice.js` должен существовать глобальный `Module`
 * с описанием окружения, а UNO поднимается в отдельном воркере, с которым
 * главный поток связывается портом. Всё это скрыто здесь, за одним вызовом.
 *
 * Что требуется от страницы (и почему это не делает обвязка):
 *
 * - **canvas в документе** — Qt-сборка рисует окно офиса в него, и без canvas
 *   сборка не стартует вовсе. Обвязка проверяет, что он уже в документе:
 *   элемент, созданный позже, до сборки не дойдёт;
 * - **заголовки изоляции** (`Cross-Origin-Opener-Policy: same-origin` и
 *   `Cross-Origin-Embedder-Policy: require-corp`) — без них браузер не даёт
 *   `SharedArrayBuffer`, и сборка не инициализируется. Это заголовки
 *   документа, поэтому страница обязана быть отдельной, а не частью SPA.
 *
 * Все комментарии на русском языке.
 */

import { BOOT_TIMEOUT_MS } from './constants';
import { LocalError, LocalSession } from './session';
import { withTimeout } from './timeout';
import type { LowaModule } from './types';

/** Что нужно знать обвязке для загрузки. */
export interface BootOptions {
  /** Canvas, в котором сборка рисует окно офиса (уже в документе). */
  readonly canvas: HTMLCanvasElement;
  /** Каталог сборки: оттуда грузятся `soffice.js`, `.wasm` и `.data`. */
  readonly assetsUrl: string;
  /** URL перенесённой обвязки UNO (`public/uno/runtime.js`). */
  readonly runtimeUrl: string;
  /** URL собранного моста (`bridge.js`). */
  readonly bridgeUrl: string;
  /**
   * Уже скачанные файлы сборки: имя файла — адрес копии в памяти браузера
   * (см. `preload.ts`).
   *
   * Необязательны: без них сборка скачает файлы сама, как обычно. С ними
   * она берёт их из памяти, и второго скачивания не происходит.
   */
  readonly assets?: ReadonlyMap<string, string>;
}

/**
 * Начатая загрузка.
 *
 * Загрузка выполняется один раз на документ: сборка инициализирует модуль
 * и создаёт воркер, и повторный запуск в том же документе дал бы вторую
 * копию. Отказ сбрасывает состояние только перезагрузкой страницы — поэтому
 * промис и запоминается, а не пересоздаётся при следующем вызове.
 */
let pending: Promise<LocalSession> | null = null;

/**
 * Загружает сборку и возвращает готовую сессию.
 *
 * @param options - canvas и адреса файлов сборки
 * @returns сессия для конвертации и предпросмотра
 */
export function boot(options: BootOptions): Promise<LocalSession> {
  pending ??= start(options);

  return pending;
}

/**
 * Выполняет загрузку сборки.
 *
 * @param options - canvas и адреса файлов сборки
 * @returns сессия
 */
async function start(options: BootOptions): Promise<LocalSession> {
  if (!options.canvas.isConnected) {
    throw new LocalError('lowa_boot_failed', 'canvas отсутствует в документе');
  }

  // Пути приводятся к абсолютным до передачи сборке: скрипты исполняются
  // в воркере, у которого своя база отсчёта, и относительный путь там
  // указывал бы не туда
  const base = document.baseURI;
  const assetsUrl = new URL(options.assetsUrl, base).toString();

  const module: LowaModule = {
    canvas: options.canvas,
    // Порядок важен: обвязка создаёт `Module.zetajs`, из которого мост берёт
    // порт. Обратный порядок оставил бы мост без порта
    uno_scripts: [
      new URL(options.runtimeUrl, base).toString(),
      new URL(options.bridgeUrl, base).toString(),
    ],
    locateFile: (path: string, prefix: string) => {
      // Имя файла, а не путь: сборка может запросить его и как `soffice.wasm`,
      // и как `./soffice.wasm`
      const name = path.slice(path.lastIndexOf('/') + 1);

      return options.assets?.get(name) ?? (prefix || assetsUrl) + path;
    },
    // Первый скрипт воркера задаётся не URL, а Blob: сборке нужен
    // `importScripts` внутри воркера, а он не работает с модульными скриптами
    mainScriptUrlOrBlob: new Blob(
      [`importScripts('${new URL('soffice.js', assetsUrl).toString()}');`],
      { type: 'text/javascript' }
    ),
  };

  globalThis.Module = module;

  await loadScript(new URL('soffice.js', assetsUrl).toString());

  const main = module.uno_main;

  if (main === undefined) {
    throw new LocalError('lowa_boot_failed', 'сборка не создала порт обмена');
  }

  const port = await withTimeout(
    main,
    BOOT_TIMEOUT_MS,
    'сборка не сообщила о готовности за отведённое время'
  );

  // Файловая система появляется на главном потоке вместе с портом: до этого
  // момента в неё нечего писать
  const fs = globalThis.FS;

  if (fs === undefined) {
    throw new LocalError('lowa_boot_failed', 'сборка не создала файловую систему');
  }

  return new LocalSession(port, fs);
}

/**
 * Подключает внешний скрипт и ждёт его выполнения.
 *
 * @param url - адрес скрипта
 * @returns обещание, выполняющееся после загрузки
 */
function loadScript(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');

    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => {
      reject(new LocalError('lowa_boot_failed', `не удалось загрузить ${url}`));
    };

    document.body.append(script);
  });
}
