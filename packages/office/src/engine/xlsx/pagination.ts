/**
 * Разбивка листа на страницы.
 *
 * Пагинацию движок не делает: `printDisplayList` рисует переданный диапазон,
 * а какой это диапазон — решает вызывающий (README пакета говорит это прямо).
 * Поэтому здесь живёт вся арифметика страницы: бумага и поля берутся из книги,
 * разрывы — тоже, а вместимость считается по тем же размерам строк и столбцов,
 * которыми движок рисует сетку (`cellPosition`).
 *
 * Три режима, и они повторяют серверный путь:
 *
 * - `fitToOnePage` — одна страница на лист: так работает `ScaleToPagesX/Y = 1`
 *   в UNO-скрипте, и это умолчание API;
 * - `fitToPage` из книги (`pageSetUpPr@fitToPage`) — масштаб подбирается
 *   под `fitToWidth`/`fitToHeight` страниц;
 * - иначе — масштаб из `pageSetup@scale`, а лист режется по страницам.
 *
 * Все комментарии на русском языке.
 */

import type { SheetSetup } from './bookXml.js';

/** Пункт → пиксель логических координат движка. */
const PT_TO_PX = 96 / 72;

/** Границы прямоугольного диапазона, индексы с нуля. */
export interface RangeBounds {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

/** Одна страница книги: диапазон листа и масштаб содержимого. */
export interface SheetPage {
  readonly bounds: RangeBounds;
  readonly scale: number;
}

/** Геометрия листа, которой пользуется пагинация. */
export interface TrackGeometry {
  /**
   * Положение левого верхнего угла ячейки.
   *
   * @param row - строка с нуля
   * @param col - столбец с нуля
   * @returns координаты в логических пикселях от начала листа
   */
  cellPosition(row: number, col: number): { readonly x: number; readonly y: number };
}

/** Что нужно, чтобы разложить лист. */
export interface PaginationInput {
  readonly geometry: TrackGeometry;
  readonly bounds: RangeBounds;
  readonly setup: SheetSetup;
  /** Уместить лист на одну страницу — параметр API, как `ScaleToPages` сервера. */
  readonly fitToOnePage: boolean;
}

/**
 * Превращает столбец в число: A → 0, AA → 26.
 *
 * @param letters - буквенное имя столбца
 * @returns индекс с нуля
 */
export function columnIndex(letters: string): number {
  let index = 0;

  for (const char of letters) {
    index = index * 26 + char.charCodeAt(0) - 64;
  }

  return index - 1;
}

/**
 * Обратное превращение: 0 → A, 26 → AA.
 *
 * @param index - индекс с нуля
 * @returns буквенное имя столбца
 */
export function columnName(index: number): string {
  let value = index + 1;
  let name = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;

    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }

  return name;
}

/**
 * Разбирает адрес диапазона вида `A1:C5`.
 *
 * @param range - адрес из usedRange или области печати
 * @returns границы диапазона или `null`, если адрес не разобран
 */
export function parseRange(range: string): RangeBounds | null {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range.replace(/\$/g, '').toUpperCase());

  if (match === null) {
    return null;
  }

  const firstCol = columnIndex(match[1] ?? 'A');
  const firstRow = Number(match[2]) - 1;
  const lastCol = columnIndex(match[3] ?? match[1] ?? 'A');
  const lastRow = Number(match[4] ?? match[2]) - 1;

  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow) || firstRow < 0 || firstCol < 0) {
    return null;
  }

  return { firstRow, lastRow, firstCol, lastCol };
}

/**
 * Адрес диапазона по его границам.
 *
 * @param bounds - границы диапазона
 * @returns адрес вида `A1:C5`
 */
export function rangeAddress(bounds: RangeBounds): string {
  const start = `${columnName(bounds.firstCol)}${bounds.firstRow + 1}`;
  const end = `${columnName(bounds.lastCol)}${bounds.lastRow + 1}`;

  return `${start}:${end}`;
}

/**
 * Раскладывает лист на страницы.
 *
 * @param input - геометрия, диапазон и настройки листа
 * @returns страницы с масштабом содержимого
 */
export function paginate(input: PaginationInput): readonly SheetPage[] {
  const { bounds, setup } = input;
  const contentWidthPx = (setup.paper.widthPt - setup.margins.left - setup.margins.right) * PT_TO_PX;
  const contentHeightPx = (setup.paper.heightPt - setup.margins.top - setup.margins.bottom) * PT_TO_PX;
  const rowEdges = trackEdges(input.geometry, bounds, 'row');
  const colEdges = trackEdges(input.geometry, bounds, 'col');
  const usedWidthPx = (colEdges.at(-1) ?? 0) - (colEdges[0] ?? 0);
  const usedHeightPx = (rowEdges.at(-1) ?? 0) - (rowEdges[0] ?? 0);

  const scale = fitScale(input, usedWidthPx, usedHeightPx, contentWidthPx, contentHeightPx);

  // Масштаб подобран так, что лист занимает ровно одну страницу, — резать нечего
  if (input.fitToOnePage) {
    return [{ bounds, scale }];
  }

  const rowGroups = groupTracks(rowEdges, contentHeightPx / scale, breaksWithin(bounds.firstRow, setup.rowBreaks));
  const colGroups = groupTracks(colEdges, contentWidthPx / scale, breaksWithin(bounds.firstCol, setup.colBreaks));
  const pages: SheetPage[] = [];

  for (const [firstRow, lastRow] of rowGroups) {
    for (const [firstCol, lastCol] of colGroups) {
      pages.push({
        bounds: {
          firstRow: bounds.firstRow + firstRow,
          lastRow: bounds.firstRow + lastRow,
          firstCol: bounds.firstCol + firstCol,
          lastCol: bounds.firstCol + lastCol,
        },
        scale,
      });
    }
  }

  return pages;
}

/**
 * Подбирает масштаб содержимого страницы.
 *
 * @param input - параметры разбивки
 * @param usedWidthPx - ширина занятой части листа
 * @param usedHeightPx - высота занятой части листа
 * @param contentWidthPx - ширина полосы набора одной страницы
 * @param contentHeightPx - высота полосы набора одной страницы
 * @returns масштаб: `1` — без сжатия
 */
function fitScale(
  input: PaginationInput,
  usedWidthPx: number,
  usedHeightPx: number,
  contentWidthPx: number,
  contentHeightPx: number
): number {
  if (input.fitToOnePage) {
    return Math.min(1, ratio(contentWidthPx, usedWidthPx), ratio(contentHeightPx, usedHeightPx));
  }

  const { setup } = input;

  if (!setup.fitToPage) {
    return setup.scale;
  }

  const width = setup.fitToWidth > 0 ? ratio(contentWidthPx * setup.fitToWidth, usedWidthPx) : 1;
  const height = setup.fitToHeight > 0 ? ratio(contentHeightPx * setup.fitToHeight, usedHeightPx) : 1;

  return Math.min(1, width, height);
}

/**
 * Отношение «сколько помещается» без деления на ноль.
 *
 * @param capacity - вместимость
 * @param used - занятое место
 * @returns отношение или `1`, если места не занято
 */
function ratio(capacity: number, used: number): number {
  return used > 0 ? capacity / used : 1;
}

/**
 * Считает кумулятивные границы треков диапазона.
 *
 * @param geometry - геометрия листа
 * @param bounds - границы диапазона
 * @param axis - строки или столбцы
 * @returns положения границ, включая края диапазона
 */
function trackEdges(geometry: TrackGeometry, bounds: RangeBounds, axis: 'row' | 'col'): number[] {
  const start = axis === 'row' ? bounds.firstRow : bounds.firstCol;
  const end = axis === 'row' ? bounds.lastRow : bounds.lastCol;
  const edges: number[] = [];

  for (let index = start; index <= end + 1; index += 1) {
    const position =
      axis === 'row' ? geometry.cellPosition(index, 0).y : geometry.cellPosition(0, index).x;

    edges.push(position);
  }

  return edges;
}

/**
 * Индексы разрывов внутри диапазона.
 *
 * @param first - первый индекс диапазона
 * @param breaks - разрывы в координатах листа
 * @returns индексы разрывов относительно начала диапазона
 */
function breaksWithin(first: number, breaks: readonly number[]): readonly number[] {
  return breaks.filter((value) => value > first).map((value) => value - first);
}

/**
 * Режет треки на группы, помещающиеся в страницу.
 *
 * Разрывы из книги — жёсткие границы: группа не может идти через них.
 * Внутри группы отрезок режется по вместимости, а одиночный трек шире
 * страницы уходит в свою группу: обрезать его нельзя, иначе потерялась бы
 * часть данных, а не масштаб.
 *
 * @param edges - кумулятивные границы треков
 * @param capacity - вместимость страницы в пикселях
 * @param breaks - индексы жёстких границ
 * @returns пары «первый, последний» индексов треков
 */
function groupTracks(
  edges: number[],
  capacity: number,
  breaks: readonly number[]
): readonly (readonly [number, number])[] {
  const last = edges.length - 2;
  const groups: (readonly [number, number])[] = [];
  const boundaries = [...new Set([0, ...breaks.filter((value) => value <= last), last + 1])].sort(
    (left, right) => left - right
  );

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index] ?? 0;
    const to = boundaries[index + 1] ?? last + 1;

    groups.push(...fitTracks(edges.slice(from, to + 1), capacity, from));
  }

  return groups;
}

/**
 * Режет отрезок треков по вместимости страницы.
 *
 * @param edges - кумулятивные границы отрезка
 * @param capacity - вместимость страницы в пикселях
 * @param offset - индекс первого трека отрезка в диапазоне
 * @returns пары «первый, последний» индексов треков
 */
function fitTracks(edges: number[], capacity: number, offset: number): readonly (readonly [number, number])[] {
  const groups: (readonly [number, number])[] = [];
  let start = offset;
  let used = 0;

  for (let index = 0; index < edges.length - 1; index += 1) {
    const current = edges[index];
    const next = edges[index + 1];

    if (current === undefined || next === undefined) {
      break;
    }

    const size = next - current;

    if (used > 0 && used + size > capacity) {
      groups.push([start, offset + index - 1]);
      start = offset + index;
      used = 0;
    }

    used += size;
  }

  groups.push([start, offset + edges.length - 2]);

  return groups;
}
