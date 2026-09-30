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
import type { PreviewSession } from './preview.js';
import type { WorkerRequest, WorkerScope } from './worker-protocol.js';

const scope = self as unknown as WorkerScope;

/** Загруженный конвейер: одна загрузка на воркер. */
let engine: Promise<typeof import('./convert.js')> | null = null;

/** Модуль предпросмотра: грузится отдельно и тоже один раз. */
let previewModule: Promise<typeof import('./preview.js')> | null = null;

/** Открытый для предпросмотра документ: движок один, и сессия одна. */
let opened: { readonly session: number; readonly preview: PreviewSession } | null = null;

/** Номер последней открытой сессии: им подписаны ответы. */
let lastSession = 0;

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
 * Подключает предпросмотр.
 *
 * Отдельным модулем, а не через конвейер: страницы рисует canvas, и тянуть
 * их код в конвертацию незачем — как и наоборот.
 *
 * @returns модуль предпросмотра
 */
function previewEngine(): Promise<typeof import('./preview.js')> {
  previewModule ??= import('./preview.js');

  return previewModule;
}

/**
 * Закрывает открытый документ.
 *
 * @returns номер закрытой сессии или `null`, если закрывать нечего
 */
function closeOpened(): number | null {
  const current = opened;

  opened = null;

  if (current === null) {
    return null;
  }

  current.preview.close();

  return current.session;
}

/**
 * Отвечает на запрос страницы.
 *
 * @param request - запрос страницы
 */
async function handlePage(request: Extract<WorkerRequest, { kind: 'preview-page' }>): Promise<void> {
  // Сессия могла быть закрыта или заменена, пока запрос шёл: рисовать
  // страницу чужого документа нельзя, а тихий ответ «не та сессия»
  // на странице неотличим от зависания
  if (opened === null || opened.session !== request.session) {
    throw new EngineError('engine_preview_stale', 'сессия предпросмотра уже закрыта');
  }

  const bitmap = await opened.preview.render(request.pageIndex, request.scale);

  if (bitmap === null) {
    // Сессию закрыли, пока рисовался растр: он никому не нужен, и память
    // под него освобождается здесь же
    throw new EngineError('engine_preview_stale', 'сессия предпросмотра уже закрыта');
  }

  scope.postMessage({ kind: 'page', id: request.id, pageIndex: request.pageIndex, bitmap }, [bitmap]);
}

/**
 * Отвечает на запрос страницы.
 *
 * @param request - запрос
 */
async function handle(request: WorkerRequest): Promise<void> {
  try {
    // Предпросмотр идёт своим модулем: конвейер конвертации ему не нужен
    if (request.kind === 'preview-open') {
      const { openPreview } = await previewEngine();

      // Движок один: открытие нового документа закрывает прежний
      closeOpened();

      lastSession += 1;

      const preview = await openPreview({
        bytes: request.bytes,
        fileName: request.fileName,
        options: request.options,
      });

      opened = { session: lastSession, preview };

      scope.postMessage({
        kind: 'opened',
        id: request.id,
        session: lastSession,
        pages: preview.pages,
        sheets: preview.sheets,
        skipped: preview.skipped,
      });

      return;
    }

    if (request.kind === 'preview-page') {
      await handlePage(request);

      return;
    }

    if (request.kind === 'preview-close') {
      if (opened !== null && opened.session === request.session) {
        closeOpened();
      }

      scope.postMessage({ kind: 'closed', id: request.id, session: request.session });

      return;
    }

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
        skipped: converted.skipped,
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
