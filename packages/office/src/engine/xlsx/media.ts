/**
 * Картинки книги: байты из пакета и место на странице.
 *
 * Печатный display list изображений не содержит вовсе — движок рисует
 * текстом, линиями и путями. Зато `exportStructured` перечисляет объекты
 * листа: у каждого есть вид (`picture`) и часть пакета (`xl/media/image1.png`),
 * а сами байты лежат в том же архиве, который мы уже распаковали ради
 * настроек печати.
 *
 * Координаты берутся из якоря: движок отдаёт угловые ячейки, поэтому рамка
 * картинки считается по геометрии листа. Смещения внутри ячейки (EMU)
 * движок не отдаёт — картинка встаёт по границам ячеек. Это ограничение
 * записано в `docs/local-engine.md`.
 *
 * Формат определяется по сигнатуре, а не по расширению: имя части приходит
 * из чужого файла, и верить ему нельзя — ровно по той же причине, по которой
 * так делает `pdf/image.ts`.
 *
 * Все комментарии на русском языке.
 */

import { MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS } from '../../constants.js';
import { decodeImage } from '../../pdf/image.js';
import type { ImagePrimitive } from '../../pdf/types.js';
import type { RangeBounds } from './pagination.js';
import { parseRange } from './pagination.js';

/** Объект листа из `exportStructured` — только то, что нужно картинкам. */
export interface SheetObject {
  readonly kind: string;
  readonly hidden: boolean;
  readonly part: string | null;
  /**
   * Якорь объекта: у картинки это ячейка или диапазон угловых ячеек.
   *
   * Поле описано необязательным, потому что у других видов объектов
   * (`sheet`, `definedName`) адреса нет вовсе — а вид приходит из файла
   * и заранее неизвестен.
   */
  readonly anchor: { readonly kind: string; readonly a1?: string } | null;
}

/** Что нужно, чтобы расставить картинки страницы. */
export interface MediaInput {
  readonly objects: readonly SheetObject[];
  /** Части пакета: из них берутся байты медиа. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Диапазон страницы: картинки за его пределами не рисуются. */
  readonly bounds: RangeBounds;
  /** Геометрия листа в логических пикселях. */
  readonly cellPosition: (row: number, col: number) => { readonly x: number; readonly y: number };
}

/** Прямоугольник картинки на странице. */
interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Обрезка по краю страницы: картинка может выходить за её пределы. */
  readonly clip?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/**
 * Собирает картинки листа, попадающие на страницу.
 *
 * @param input - объекты листа, части пакета, диапазон и геометрия
 * @returns примитивы картинок
 */
export function imagePrimitives(input: MediaInput): readonly ImagePrimitive[] {
  const primitives: ImagePrimitive[] = [];
  let total = 0;

  for (const object of input.objects) {
    if (object.kind !== 'picture' || object.hidden || object.part === null || object.anchor === null) {
      continue;
    }

    const bytes = input.files.get(normalizePart(object.part));

    if (bytes === undefined) {
      continue;
    }

    // Медиа книги может весить больше самой книги: предел защищает память
    // вкладки, а не качество — картинки сверх него просто не рисуются
    if (total + bytes.byteLength > MAX_MEDIA_BYTES) {
      break;
    }

    const decoded = decodeImage(bytes);

    if (decoded.kind !== 'raster' && decoded.kind !== 'jpeg') {
      continue;
    }

    const size = decoded.image;
    const pixels = size.width * size.height;

    if (pixels > MAX_MEDIA_PIXELS) {
      continue;
    }

    const frame = frameOf(object.anchor, input, size);

    if (frame === null) {
      continue;
    }

    total += bytes.byteLength;
    primitives.push({
      kind: 'image',
      relId: dataUrl(object.part, bytes),
      ...frame,
    });
  }

  return primitives;
}

/**
 * Считает прямоугольник картинки на странице.
 *
 * @param anchor - якорь объекта из `exportStructured`
 * @param input - диапазон страницы и геометрия листа
 * @param size - натуральный размер картинки в пикселях
 * @returns прямоугольник или `null`, если картинка вне страницы
 */
function frameOf(
  anchor: SheetObject['anchor'],
  input: MediaInput,
  size: { readonly width: number; readonly height: number }
): Frame | null {
  if (anchor === null || anchor.a1 === undefined) {
    return null;
  }

  const range = parseRange(anchor.a1);

  if (range === null) {
    return null;
  }

  const start = input.cellPosition(range.firstRow, range.firstCol);
  const end =
    anchor.kind === 'range'
      ? input.cellPosition(range.lastRow + 1, range.lastCol + 1)
      : { x: start.x + size.width, y: start.y + size.height };
  const origin = input.cellPosition(input.bounds.firstRow, input.bounds.firstCol);
  const frame: Frame = {
    x: start.x - origin.x,
    y: start.y - origin.y,
    w: end.x - start.x,
    h: end.y - start.y,
  };

  if (frame.w <= 0 || frame.h <= 0) {
    return null;
  }

  const pageRight = input.cellPosition(input.bounds.lastRow + 1, input.bounds.lastCol + 1);
  const pageWidth = pageRight.x - origin.x;
  const pageHeight = pageRight.y - origin.y;

  // Картинка целиком за пределами страницы — рисовать нечего
  if (frame.x + frame.w <= 0 || frame.y + frame.h <= 0 || frame.x >= pageWidth || frame.y >= pageHeight) {
    return null;
  }

  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(pageWidth, frame.x + frame.w);
  const bottom = Math.min(pageHeight, frame.y + frame.h);

  // Картинка, разрезанная разрывом страниц, рисуется на каждой своей частью:
  // без обрезки она повторилась бы целиком на обеих страницах
  return right - left < frame.w || bottom - top < frame.h
    ? { ...frame, clip: { x: left, y: top, w: right - left, h: bottom - top } }
    : frame;
}

/**
 * Приводит имя части к виду, под которым она лежит в пакете.
 *
 * @param part - имя из объекта листа
 * @returns имя части без ведущей косой черты
 */
function normalizePart(part: string): string {
  return part.startsWith('/') ? part.slice(1) : part;
}

/**
 * Собирает `data:`-ссылку на картинку.
 *
 * Экспортёр PDF читает байты именно из неё — отдельного хранилища
 * у браузерного пути нет.
 *
 * @param part - имя части: из него берётся расширение для типа
 * @param bytes - байты картинки
 * @returns ссылка вида `data:image/png;base64,…`
 */
function dataUrl(part: string, bytes: Uint8Array): string {
  const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
  let binary = '';

  // По частям: `String.fromCharCode(...bytes)` на большой картинке
  // переполняет стек вызовов
  const chunk = 0x8000;

  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }

  return `data:${mime};base64,${btoa(binary)}`;
}
