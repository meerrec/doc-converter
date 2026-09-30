/**
 * Растр страницы: то, что показывает предпросмотр.
 *
 * Страницы рисует сам движок — тем же display list, из которого собирается
 * PDF. Отсюда две разные дороги, и обе кончаются `ImageBitmap`:
 *
 * - **документ Word** — `rasterizeDisplayPageToBackBuffer`: он рисует страницу
 *   целиком (фон, рамки, тело, сноски, колонтитулы) и сам же выставляет
 *   размер холста по масштабу;
 * - **книга** — `paintDisplayList`: движок рисует переданный диапазон
 *   в текущее преобразование холста, поэтому бумагу, поля и подгонку листа
 *   считаем мы — ровно той же матрицей, что уходит в PDF (`transform`
 *   страницы в `render.ts`), иначе предпросмотр «поехал» бы относительно
 *   скачанного файла.
 *
 * Чего здесь нет и почему:
 *
 * - **`rasterizeDisplayListPages` и `sizeCanvasForPage`** движка не годятся:
 *   первая создаёт холсты через `document.createElement`, вторая пишет
 *   в `canvas.style`, — в воркере нет ни того, ни другого;
 * - **`createCanvasImageResolver`** движка тоже не годятся: внутри он создаёт
 *   `new Image()`. Свой резолвер делает то же через `createImageBitmap`
 *   и по тем же правилам безопасности — только `data:` и `blob:`, никаких
 *   сетевых адресов (см. `security.md`: страница не ходит за пределы своего
 *   origin).
 *
 * Все комментарии на русском языке.
 */

import {
  rasterizeDisplayPageToBackBuffer,
  type GlyphCache,
  type ImageResolver,
} from '@betteroffice/docx/layout/render';
import { paintDisplayList } from '@betteroffice/xlsx';
import type { ClipRect, DisplayPrimitive, ImagePrimitive } from '../pdf/types.js';

/** Что нужно растеризатору документа Word. */
export interface DocxRasterOptions {
  /** Обводки глифов: без них текст рисуется `fillText` и зависит от шрифтов. */
  readonly glyphCache?: GlyphCache;
  /** Откуда берутся картинки. */
  readonly resolveImage?: ImageResolver;
}

/**
 * Проверяет, умеет ли окружение растеризовать страницы.
 *
 * В Node предпросмотра нет: `OffscreenCanvas` и `createImageBitmap` там
 * не существуют. Открыть сессию при этом можно — вёрстка и план страниц
 * от canvas не зависят, и на этом стоит проверка в тестах.
 *
 * @returns true, если страницы можно рисовать
 */
export function supportsRaster(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
}

/**
 * Рисует страницу документа Word.
 *
 * @param page - страница display list движка
 * @param scale - во сколько раз увеличить страницу (dpr × зум панели)
 * @param options - обводки глифов и источник картинок
 * @returns готовый растр
 */
export async function rasterizeDocxPage(
  page: Parameters<typeof rasterizeDisplayPageToBackBuffer>[1],
  scale: number,
  options: DocxRasterOptions
): Promise<ImageBitmap> {
  // Размер холста движок выставляет сам — по размерам страницы и масштабу
  const buffer = new OffscreenCanvas(1, 1);

  await rasterizeDisplayPageToBackBuffer(
    buffer,
    page,
    { glyphCache: options.glyphCache, resolveImage: options.resolveImage },
    scale,
    1
  );

  return buffer.transferToImageBitmap();
}

/** Геометрия страницы книги: то, чем её содержимое ложится на бумагу. */
export interface XlsxPageGeometry {
  /** Размер бумаги в пикселях CSS. */
  readonly paper: { readonly width: number; readonly height: number };
  /** Поля в пикселях CSS. */
  readonly margins: { readonly x: number; readonly y: number };
  /** Подгонка содержимого: из неё и бумаги выходит матрица страницы. */
  readonly scale: number;
}

/**
 * Рисует страницу книги.
 *
 * @param frame - печатный display list диапазона
 * @param geometry - бумага, поля и подгонка страницы
 * @param scale - во сколько раз увеличить страницу (dpr × зум панели)
 * @param images - картинки листа: в display list их нет
 * @param resolveImage - откуда брать картинки
 * @returns готовый растр
 */
export async function rasterizeXlsxPage(
  frame: Parameters<typeof paintDisplayList>[1],
  geometry: XlsxPageGeometry,
  scale: number,
  images: readonly DisplayPrimitive[],
  resolveImage: ImageResolver
): Promise<ImageBitmap> {
  const width = Math.max(1, Math.ceil(geometry.paper.width * scale));
  const height = Math.max(1, Math.ceil(geometry.paper.height * scale));
  const buffer = new OffscreenCanvas(width, height);
  const context = buffer.getContext('2d');

  if (context === null) {
    throw new Error('холст не отдал контекст 2d');
  }

  // Матрица страницы: подгонка листа и поля — те же, что в PDF
  const fit = scale * geometry.scale;
  const origin = { x: geometry.margins.x * scale, y: geometry.margins.y * scale };

  // Типы движка описаны для DOM-холста, хотя холст воркера принимает те же
  // вызовы: это его собственная оговорка в доках пакета
  paintDisplayList(context as unknown as CanvasRenderingContext2D, frame, fit, origin);

  context.setTransform(fit, 0, 0, fit, origin.x, origin.y);

  for (const primitive of images) {
    if (primitive.kind !== 'image') {
      continue;
    }

    // Приведение, а не сужение: в объединении примитивов есть ветка
    // `{ kind: string }`, и по `kind` она не отсекается — так же, как
    // в разборе примитивов у экспортёра
    const image = primitive as ImagePrimitive;
    const source = await resolveImage(image.relId);

    if (source === null) {
      continue;
    }

    const depth = applyClip(context, image.clip);

    context.drawImage(source, image.x, image.y, image.w, image.h);

    if (depth > 0) {
      context.restore();
    }
  }

  context.setTransform(1, 0, 0, 1, 0, 0);

  return buffer.transferToImageBitmap();
}

/**
 * Обрезает рисование по прямоугольнику.
 *
 * @param context - контекст холста
 * @param clip - прямоугольник обрезки
 * @returns 1, если состояние открыто и его нужно закрыть
 */
function applyClip(
  context: OffscreenCanvasRenderingContext2D,
  clip: ClipRect | undefined
): number {
  if (clip === undefined || clip.w <= 0 || clip.h <= 0) {
    return 0;
  }

  context.save();
  context.beginPath();
  context.rect(clip.x, clip.y, clip.w, clip.h);
  context.clip();

  return 1;
}

/**
 * Создаёт источник картинок для canvas.
 *
 * Картинки приходят адресом `data:` (документы Word) или `blob:` — оба
 * разбираются декодером браузера, и оба остаются на своём origin. Любая
 * другая схема отвергается: страница не должна ходить в сеть за содержимым
 * документа.
 *
 * @returns функция «адрес → картинка»
 */
export function createImageResolver(): ImageResolver {
  const cache = new Map<string, Promise<CanvasImageSource | null>>();

  return (relId: string) => {
    if (!relId.startsWith('data:') && !relId.startsWith('blob:')) {
      return null;
    }

    const cached = cache.get(relId);

    if (cached !== undefined) {
      return cached;
    }

    const started = fetch(relId)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
      .catch(() => null);

    cache.set(relId, started);

    return started;
  };
}
