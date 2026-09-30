/**
 * Воркер движка: конвертация вне главного потока.
 *
 * Разбор книги или документа — это мегабайты wasm, шейпинг текста и сборка
 * PDF; на главном потоке всё это морозит страницу на время задачи. Здесь
 * работа идёт своим чередом, а страница только отправляет байты и получает
 * готовый файл.
 *
 * Конвейер подключается динамически, а не статически: так запуск воркера
 * лёгкий, а загрузка кода движка попадает в отдельный запрос — тот самый,
 * который страница показывает фазой «загрузка движка».
 *
 * Ошибки не выбрасываются наружу: упавший обработчик не отвечает ничем,
 * и запрос завис бы навсегда. Поэтому любой отказ превращается в сообщение
 * с кодом, а воркер продолжает работать — следующая задача может быть
 * вполне исправной.
 *
 * Все комментарии на русском языке.
 */

import { EngineError, type EngineErrorCode } from './errors.js';
import type { WorkerRequest, WorkerScope } from './worker-protocol.js';

const scope = self as unknown as WorkerScope;

/** Загруженный конвейер: одна загрузка на воркер. */
let engine: Promise<typeof import('./convert.js')> | null = null;

/**
 * Подключает конвейер, ничего не конвертируя.
 *
 * Загрузка мемоизирована — по той же причине, что и на странице: повторный
 * запрос тех же мегабайт выглядел бы как зависание, а браузер уже отбросил
 * модуль, если первая попытка не удалась.
 *
 * @returns модуль конвейера
 */
function warmup(): Promise<typeof import('./convert.js')> {
  engine ??= import('./convert.js');

  return engine;
}

/**
 * Отвечает на запрос страницы.
 *
 * @param request - запрос
 */
async function handle(request: WorkerRequest): Promise<void> {
  try {
    const { convertDocument } = await warmup();

    if (request.kind === 'warmup') {
      scope.postMessage({ kind: 'ready', id: request.id });

      return;
    }

    const converted = await convertDocument({
      bytes: request.bytes,
      fileName: request.fileName,
      options: request.options,
    });

    scope.postMessage(
      {
        kind: 'done',
        id: request.id,
        bytes: converted.bytes,
        pageCount: converted.pageCount,
        sheets: converted.sheets,
      },
      [converted.bytes.buffer as ArrayBuffer]
    );
  } catch (error) {
    const code: EngineErrorCode = error instanceof EngineError ? error.code : 'engine_convert_failed';

    scope.postMessage({
      kind: 'failed',
      id: request.id,
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.addEventListener('message', (event) => {
  void handle(event.data);
});
