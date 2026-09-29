/**
 * Книга Excel через BetterOffice: листы → страницы PDF.
 *
 * Движок отдаёт и печатный display list (`printDisplayList`), и PNG листа
 * (`renderRangePng`). Для книг выбран PNG: печатная модель OOXML (область
 * печати, разрывы, масштаб) движком не разбирается, и векторный путь
 * потребовал бы собственного шейпинга текста и сборки ячеек. PNG отдаёт
 * готовую картинку листа с форматированием, а пагинацию и масштаб считает
 * этот модуль — по размерам строк и столбцов, которые даёт `cellPosition`.
 *
 * Ограничение v1: страницы книг растеризованы, текст в PDF не выделяется;
 * настройки листа (бумага, поля, область печати) пока упрощены до A4
 * с полями по умолчанию. Список учтённого — в шапке пагинации ниже.
 *
 * Все комментарии на русском языке.
 */

import {
  initWasm,
  isPngExportAvailable,
  openWorkbook,
  type WorkbookHandle,
} from '@betteroffice/xlsx';
import { isNodeRuntime } from '../assets.js';
import { PdfBuilder } from '../pdf/builder.js';
import { decodeImage } from '../pdf/image.js';

/** Готовая книга: PDF целиком, число страниц и число видимых листов. */
export interface RenderedXlsx {
  readonly pdf: Uint8Array;
  readonly pageCount: number;
  readonly sheets: number;
}

/** Страница A4 в пунктах PDF. */
const PAGE_WIDTH_PT = 595;
const PAGE_HEIGHT_PT = 842;

/** Поля страницы по умолчанию, 0.75 дюйма. */
const MARGIN_PT = 54;

/** Пункт → логический пиксель движка (96 dpi). */
const PT_TO_PX = 96 / 72;

/** Логический пиксель → пункт PDF. */
const PX_TO_PT = 72 / 96;

/** Пределы листа OOXML: дальше `cellPosition` уже не отвечает. */
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

/** Модуль xlsx инициализируется один раз на страницу. */
let initPromise: Promise<void> | null = null;

/** Границы прямоугольного диапазона, индексы с нуля. */
interface RangeBounds {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

/** Одна страница: диапазон листа и масштаб отрисовки. */
interface SheetPage {
  readonly bounds: RangeBounds;
  readonly scale: number;
}

/** PNG страницы, готовый к встраиванию. */
interface RasterPage {
  readonly png: Uint8Array;
  readonly widthPt: number;
  readonly heightPt: number;
}

/**
 * Инициализирует wasm-модуль книги.
 *
 * @returns готовность модуля
 */
function ensureEngine(): Promise<void> {
  initPromise ??= startEngine();

  return initPromise;
}

/**
 * Выполняет запуск модуля.
 *
 * В браузере адрес wasm движок находит сам (`new URL` относительно своего
 * чанка, файл подставляет сборщик). В Node этого пути нет, поэтому wasm
 * читается с диска по расположению пакета и передаётся байтами.
 *
 * @returns готовность модуля
 */
async function startEngine(): Promise<void> {
  if (isNodeRuntime()) {
    const { readFile } = await import('node:fs/promises');
    // `import.meta.resolve` соблюдает условия `import` из exports пакета,
    // а адрес wasm лежит рядом с точкой входа в `dist`
    const entry = import.meta.resolve('@betteroffice/xlsx');
    const wasmPath = new URL('generated/xlsx_wasm_bg.wasm', entry);
    const buffer = await readFile(wasmPath);

    await initWasm(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    return;
  }

  await initWasm();
}

/**
 * Превращает столбец в число: A → 0, AA → 26.
 *
 * @param letters - буквенное имя столбца
 * @returns индекс с нуля
 */
function columnIndex(letters: string): number {
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
function columnName(index: number): string {
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
 * @param range - адрес из usedRange
 * @returns границы диапазона
 */
function parseRange(range: string): RangeBounds {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);

  if (match === null) {
    throw new Error(`не удалось разобрать диапазон листа: ${range}`);
  }

  const firstCol = columnIndex(match[1] ?? '');
  const firstRow = Number(match[2]) - 1;
  const lastCol = columnIndex(match[3] ?? '');
  const lastRow = Number(match[4]) - 1;

  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow)) {
    throw new Error(`не удалось разобрать диапазон листа: ${range}`);
  }

  return { firstRow, lastRow, firstCol, lastCol };
}

/**
 * Адрес диапазона по его границам.
 *
 * @param bounds - границы диапазона
 * @returns адрес вида `A1:C5`
 */
function rangeAddress(bounds: RangeBounds): string {
  const start = `${columnName(bounds.firstCol)}${bounds.firstRow + 1}`;
  const end = `${columnName(bounds.lastCol)}${bounds.lastRow + 1}`;

  return `${start}:${end}`;
}

/**
 * Возвращает положение границы трека в логических пикселях.
 *
 * @param workbook - открытая книга
 * @param sheet - индекс листа
 * @param row - строка (или `MAX_ROWS` для правого края)
 * @param col - столбец (или `MAX_COLS` для нижнего края)
 * @returns координата границы
 */
function trackEdge(
  workbook: WorkbookHandle,
  sheet: number,
  axis: 'row' | 'col',
  row: number,
  col: number
): number {
  if (row >= MAX_ROWS || col >= MAX_COLS) {
    workbook.setActiveSheet(sheet);

    return row >= MAX_ROWS ? workbook.sheetInfo().contentHeight : workbook.sheetInfo().contentWidth;
  }

  const position = workbook.cellPosition(sheet, row, col);

  return axis === 'row' ? position.y : position.x;
}

/**
 * Считает кумулятивные границы треков диапазона.
 *
 * @param workbook - открытая книга
 * @param sheet - индекс листа
 * @param bounds - границы используемого диапазона
 * @param axis - строки или столбцы
 * @returns положения границ, включая края диапазона
 */
function trackEdges(
  workbook: WorkbookHandle,
  sheet: number,
  bounds: RangeBounds,
  axis: 'row' | 'col'
): number[] {
  const start = axis === 'row' ? bounds.firstRow : bounds.firstCol;
  const end = axis === 'row' ? bounds.lastRow : bounds.lastCol;
  const edges: number[] = [];

  for (let index = start; index <= end + 1; index += 1) {
    const row = axis === 'row' ? index : 0;
    const col = axis === 'col' ? index : 0;

    edges.push(trackEdge(workbook, sheet, axis, row, col));
  }

  // Крайние границы должны быть от позиции `start`, а не от нуля листа:
  // вычитание ниже вернёт ширину именно этого диапазона
  return edges;
}

/**
 * Режет треки на группы, помещающиеся в страницу.
 *
 * Одиночный трек шире страницы уходит в свою группу: обрезать его нельзя,
 * иначе потерялась бы часть данных, а не масштаб.
 *
 * @param edges - кумулятивные границы
 * @param capacity - ширина или высота содержимого страницы в px
 * @returns пары «первый, последний» индексов треков
 */
function fitTracks(edges: number[], capacity: number): readonly [number, number][] {
  const groups: [number, number][] = [];
  let start = 0;
  let used = 0;

  for (let index = 0; index < edges.length - 1; index += 1) {
    const current = edges[index];
    const next = edges[index + 1];

    if (current === undefined || next === undefined) {
      break;
    }

    const size = next - current;

    if (used > 0 && used + size > capacity) {
      groups.push([start, index - 1]);
      start = index;
      used = 0;
    }

    used += size;
  }

  groups.push([start, edges.length - 2]);

  return groups;
}

/**
 * Раскладывает лист на страницы с учётом масштаба.
 *
 * Учитывается только `fitToOnePage`: настройки бумаги, полей, области печати
 * и явных разрывов пока упрощены (A4, поля по умолчанию, весь используемый
 * диапазон). Это ограничение v1, а не обещание паритета.
 *
 * @param workbook - открытая книга
 * @param sheet - индекс листа
 * @param bounds - используемый диапазон
 * @param fitToOnePage - умещать лист на одну страницу
 * @returns страницы листа
 */
function paginate(
  workbook: WorkbookHandle,
  sheet: number,
  bounds: RangeBounds,
  fitToOnePage: boolean
): readonly SheetPage[] {
  const contentWidthPx = (PAGE_WIDTH_PT - MARGIN_PT * 2) * PT_TO_PX;
  const contentHeightPx = (PAGE_HEIGHT_PT - MARGIN_PT * 2) * PT_TO_PX;
  const rowEdges = trackEdges(workbook, sheet, bounds, 'row');
  const colEdges = trackEdges(workbook, sheet, bounds, 'col');
  const usedWidthPx = (colEdges.at(-1) ?? 0) - (colEdges[0] ?? 0);
  const usedHeightPx = (rowEdges.at(-1) ?? 0) - (rowEdges[0] ?? 0);

  if (fitToOnePage) {
    const scale = Math.min(1, contentWidthPx / usedWidthPx, contentHeightPx / usedHeightPx);

    return [{ bounds, scale }];
  }

  const rowGroups = fitTracks(rowEdges, contentHeightPx);
  const colGroups = fitTracks(colEdges, contentWidthPx);
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
        scale: 1,
      });
    }
  }

  return pages;
}

/**
 * Рисует страницу листа в PNG.
 *
 * @param workbook - открытая книга
 * @param sheet - индекс листа
 * @param page - страница листа
 * @returns PNG страницы
 */
function rasterize(workbook: WorkbookHandle, sheet: number, page: SheetPage): Uint8Array {
  // `renderRangePng` рисует активный лист: у него нет параметра индекса
  workbook.setActiveSheet(sheet);

  const png = workbook.renderRangePng({
    range: rangeAddress(page.bounds),
    scale: page.scale,
  });

  if (png.byteLength === 0) {
    throw new Error('движок вернул пустую страницу книги');
  }

  return png;
}

/**
 * Собирает PDF из растровых страниц.
 *
 * PNG в PDF не встраивается как есть: PDF знает потоки zlib, а не контейнер
 * PNG. Поэтому картинка раскладывается на RGB и прозрачность, а размер
 * страницы выводится из размеров PNG.
 *
 * @param pages - растровые страницы
 * @returns байты PDF
 */
function buildRasterPdf(pages: readonly RasterPage[]): Uint8Array {
  const pdf = new PdfBuilder();
  const pagesRef = pdf.add('');
  const pageRefs: number[] = [];

  for (const page of pages) {
    const decoded = decodeImage(page.png);

    if (decoded.kind !== 'raster') {
      throw new Error('страница книги пришла не в PNG');
    }

    const { width, height, rgb, alpha } = decoded.image;
    const dict = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`;

    let imageRef: number;

    if (alpha === null) {
      imageRef = pdf.addStream(`${dict} >>`, rgb);
    } else {
      const maskRef = pdf.addStream(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`,
        alpha
      );

      imageRef = pdf.addStream(`${dict} /SMask ${maskRef} 0 R >>`, rgb);
    }

    const imageWidthPt = page.widthPt;
    const imageHeightPt = page.heightPt;
    const x = MARGIN_PT;
    const y = PAGE_HEIGHT_PT - MARGIN_PT - imageHeightPt;
    const content = pdf.addStream(
      '<< /Filter /FlateDecode >>',
      new TextEncoder().encode(
        `q\n${imageWidthPt} 0 0 ${imageHeightPt} ${x} ${y} cm\n/Im1 Do\nQ\n`
      )
    );

    pageRefs.push(
      pdf.add(
        `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}] /Resources << /XObject << /Im1 ${imageRef} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }

  pdf.replace(
    pagesRef,
    `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`
  );

  return pdf.build(pdf.add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`));
}

/**
 * Конвертирует книгу в PDF.
 *
 * @param bytes - байты XLSX
 * @param options - параметры вёрстки (`fitToOnePage`)
 * @returns PDF, число страниц и число видимых листов
 */
export async function renderXlsx(
  bytes: Uint8Array,
  options: { readonly fitToOnePage: boolean }
): Promise<RenderedXlsx> {
  await ensureEngine();

  if (!isPngExportAvailable()) {
    throw new Error('сборка движка не умеет рисовать книги в PNG');
  }

  const workbook = openWorkbook(bytes);

  try {
    const exported = workbook.exportStructured({});

    if (!('content' in exported)) {
      throw new Error('движок не смог разобрать книгу');
    }

    const sheets = exported.content.sheets.filter((sheet) => sheet.visibility === 'visible');
    const pages: RasterPage[] = [];

    for (const sheet of sheets) {
      // Пустой лист — всё равно страница, как и у LibreOffice: диапазон
      // одной ячейки отдаёт пустую картинку, а не отсутствие листа
      const bounds =
        sheet.usedRange === null
          ? { firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 }
          : parseRange(sheet.usedRange);
      const index = exported.content.sheets.indexOf(sheet);
      const sheetPages = paginate(workbook, index, bounds, options.fitToOnePage);

      for (const page of sheetPages) {
        const png = rasterize(workbook, index, page);
        const raster = decodeImage(png);

        if (raster.kind !== 'raster') {
          throw new Error('страница книги пришла не в PNG');
        }

        pages.push({
          png,
          widthPt: raster.image.width * PX_TO_PT,
          heightPt: raster.image.height * PX_TO_PT,
        });
      }
    }

    return {
      pdf: buildRasterPdf(pages),
      pageCount: pages.length,
      sheets: sheets.length,
    };
  } finally {
    workbook.dispose();
  }
}
