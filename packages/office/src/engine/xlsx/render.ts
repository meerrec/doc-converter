/**
 * Книга Excel → векторный PDF.
 *
 * Конвейер книги: пакет XLSX разбирается дважды — настройки печати читаем
 * мы (`bookXml.ts`), содержимое разбирает движок, — затем каждый лист режется
 * на страницы (`pagination.ts`), каждая страница рисуется печатным display
 * list и переводится в примитивы (`display.ts`), а PDF собирает общий
 * экспортёр (`pdf/`).
 *
 * Разбор и план страниц отделены от сборки файла (`openXlsxPlan`): тем же
 * планом пользуется предпросмотр. Иначе он повторял бы пагинацию своими
 * словами, и «в предпросмотре те же страницы, что скачаются» держалось бы
 * на честном слове, а не на общем коде.
 *
 * Почему вектор, а не картинка: текст в PDF остаётся текстом — его можно
 * выделить, скопировать и найти поиском. Заодно оформление перестаёт зависеть
 * от растровой сетки движка: страница собирается из тех же линий, заливок
 * и глифов, что и документы Word.
 *
 * Чего у книги нет и не будет в этой версии: настроек печати, которых нет
 * в `pageSetup` (колонтитулы листа), и повёрнутого текста — движок отдаёт
 * его как есть, а экспортёр поворотов не умеет. Это записано ограничениями
 * в `docs/local-engine.md`.
 *
 * Все комментарии на русском языке.
 */

import { initWasm, openWorkbook, type WorkbookHandle, type XlsxExportObject } from '@betteroffice/xlsx';
import { unzipSync } from 'fflate';
import { isNodeRuntime } from '../../assets.js';
import { buildPdf } from '../../pdf/export.js';
import type { SkippedPrimitives } from '../../pdf/support.js';
import type { DisplayPage, DisplayPrimitive, DisplayList } from '../../pdf/types.js';
import { readBookDefaults, readPrintArea, readSheetParts, readSheetSetup, type BookDefaults } from './bookXml.js';
import { toPrimitives } from './display.js';
import { createBookFonts, type BookFonts } from './fonts.js';
import { imagePrimitives } from './media.js';
import { buildPrintMetrics, type PrintMetrics } from './metrics.js';
import { paginate, parseRange, rangeAddress, type RangeBounds, type TrackGeometry } from './pagination.js';

/** Готовая книга: PDF целиком, число страниц и число видимых листов. */
export interface RenderedXlsx {
  readonly pdf: Uint8Array;
  readonly pageCount: number;
  readonly sheets: number;
  /** Что не доехало до PDF: у книги — пусто, все её примитивы поддержаны. */
  readonly skipped: SkippedPrimitives;
}

/**
 * План одной страницы книги: всё, что нужно, чтобы её нарисовать.
 *
 * Отдельного «списка примитивов» здесь нет намеренно: страница рисуется
 * дважды и по-разному — в PDF примитивами, в предпросмотре командами
 * движка, — но диапазон, масштаб и бумага у обоих обязаны быть одни и те же.
 */
export interface XlsxPagePlan {
  /** Индекс листа в книге: им движок адресует геометрию. */
  readonly sheet: number;
  /** Границы диапазона страницы. */
  readonly bounds: RangeBounds;
  /** Масштаб содержимого: из него и бумаги выходит матрица страницы. */
  readonly scale: number;
  /** Размер бумаги в пикселях CSS. */
  readonly paper: { readonly width: number; readonly height: number };
  /** Поля в пикселях CSS. */
  readonly margins: { readonly x: number; readonly y: number };
  /** Печатать ли сетку листа. */
  readonly gridLines: boolean;
  /** Метрики печати: по ним движок раскладывает диапазон. */
  readonly metrics: PrintMetrics;
  /** Объекты листа: картинки в display list не попадают, их рисуем отдельно. */
  readonly objects: readonly XlsxExportObject[];
}

/** Открытая книга и план её страниц. */
export interface OpenedXlsx {
  /** Открытая книга: живёт до `dispose()`. */
  readonly workbook: WorkbookHandle;
  readonly pages: readonly XlsxPagePlan[];
  /** Число видимых листов. */
  readonly sheets: number;
  /** Части пакета: картинки берутся отсюда. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly defaults: BookDefaults;
  /** Реестр шрифтов книги: пополняется по мере раскладки. */
  readonly fonts: BookFonts;
}

/** Пункт → пиксель логических координат: размеры бумаги приходят в пунктах. */
const PT_TO_PX = 96 / 72;

/** Диапазон пустого листа: одна ячейка — как и у серверного пути. */
const EMPTY_BOUNDS: RangeBounds = { firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 };

/** Модуль xlsx инициализируется один раз на страницу. */
let initPromise: Promise<void> | null = null;

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
 * В браузере адрес wasm движок находит сам, в Node — читается с диска:
 * того же различия требует и DOCX-путь, и причины те же.
 *
 * @returns готовность модуля
 */
async function startEngine(): Promise<void> {
  if (isNodeRuntime()) {
    const { readFile } = await import('node:fs/promises');
    const entry = import.meta.resolve('@betteroffice/xlsx');
    const wasmPath = new URL('generated/xlsx_wasm_bg.wasm', entry);
    const buffer = await readFile(wasmPath);

    await initWasm(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    return;
  }

  await initWasm();
}

/**
 * Читает нужные части пакета.
 *
 * Фильтр здесь — не оптимизация, а защита: без него распаковался бы весь
 * архив, включая медиа, которое странице может и не понадобиться.
 *
 * @param bytes - байты XLSX
 * @returns части пакета по именам
 */
function readPackage(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const files = unzipSync(bytes, {
    filter: (file) =>
      file.name === 'xl/workbook.xml' ||
      file.name === 'xl/_rels/workbook.xml.rels' ||
      file.name === 'xl/styles.xml' ||
      file.name.startsWith('xl/worksheets/') ||
      file.name.startsWith('xl/media/'),
  });

  return new Map(Object.entries(files));
}

/**
 * Читает часть пакета строкой.
 *
 * @param files - части пакета
 * @param path - имя части
 * @returns разметка или `null`
 */
function readText(files: ReadonlyMap<string, Uint8Array>, path: string): string | null {
  const bytes = files.get(path);

  return bytes === undefined ? null : new TextDecoder().decode(bytes);
}

/**
 * Собирает страницу PDF из примитивов листа.
 *
 * @param pageIndex - номер страницы в документе
 * @param sheetPage - страница листа: масштаб из пагинации
 * @param paper - размер бумаги в пикселях
 * @param margins - поля в пикселях
 * @param primitives - примитивы страницы
 * @returns страница display list
 */
function toDisplayPage(
  pageIndex: number,
  scale: number,
  paper: { readonly width: number; readonly height: number },
  margins: { readonly x: number; readonly y: number },
  primitives: readonly DisplayPrimitive[]
): DisplayPage {
  return {
    pageIndex,
    width: paper.width,
    height: paper.height,
    primitives,
    // Поля и подгонка выражаются матрицей: содержимое сжимается целиком,
    // а текст остаётся текстом — в этом и смысл векторного пути
    transform: { scale, x: margins.x, y: margins.y },
  };
}

/**
 * Отдаёт геометрию листа для пагинации.
 *
 * @param workbook - открытая книга
 * @param sheet - индекс листа
 * @returns геометрия треков
 */
function geometryOf(workbook: WorkbookHandle, sheet: number): TrackGeometry {
  return {
    cellPosition: (row: number, col: number) => workbook.cellPosition(sheet, row, col),
  };
}

/**
 * Открывает книгу и раскладывает её по страницам.
 *
 * Книга остаётся открытой: закрывает её тот, кто позвал, — сборка PDF сразу
 * после работы, предпросмотр после закрытия панели.
 *
 * @param bytes - байты XLSX
 * @param options - параметры вёрстки (`fitToOnePage`)
 * @returns открытая книга и план страниц
 */
export async function openXlsxPlan(
  bytes: Uint8Array,
  options: { readonly fitToOnePage: boolean }
): Promise<OpenedXlsx> {
  await ensureEngine();

  const files = readPackage(bytes);
  const workbook = openWorkbook(bytes);

  try {
    const exported = workbook.exportStructured({});

    if (!('content' in exported)) {
      throw new Error('движок не смог разобрать книгу');
    }

    const defaults = readBookDefaults(files);
    const workbookXml = readText(files, 'xl/workbook.xml') ?? '';
    const relsXml = readText(files, 'xl/_rels/workbook.xml.rels') ?? '';
    const parts = readSheetParts(workbookXml, relsXml);
    const fonts = createBookFonts();
    const base = await fonts.family(defaults.fontFamily, defaults.bold, defaults.italic);

    if (base === null) {
      throw new Error('не нашёлся шрифт книги');
    }

    const pages: XlsxPagePlan[] = [];
    let sheets = 0;

    for (const sheet of exported.content.sheets) {
      if (sheet.visibility !== 'visible') {
        continue;
      }

      sheets += 1;

      // Индекс листа в книге, а не среди видимых: им движок адресует геометрию
      const index = exported.content.sheets.indexOf(sheet);
      const part = parts[index];
      const xml = part === undefined ? null : readText(files, part.path);
      const printArea = part === undefined ? null : readPrintArea(workbookXml, part.name);
      const setup = readSheetSetup(xml ?? '', printArea);
      const geometry = geometryOf(workbook, index);
      const metrics = await buildPrintMetrics(base, defaults, setup.defaultRowHeightPt);
      const bounds =
        (printArea === null ? null : parseRange(printArea)) ??
        (sheet.usedRange === null ? EMPTY_BOUNDS : parseRange(sheet.usedRange)) ??
        EMPTY_BOUNDS;
      const sheetPages = paginate({ geometry, bounds, setup, fitToOnePage: options.fitToOnePage });
      const paper = { width: setup.paper.widthPt * PT_TO_PX, height: setup.paper.heightPt * PT_TO_PX };
      const margins = { x: setup.margins.left * PT_TO_PX, y: setup.margins.top * PT_TO_PX };

      for (const sheetPage of sheetPages) {
        pages.push({
          sheet: index,
          bounds: sheetPage.bounds,
          scale: sheetPage.scale,
          paper,
          margins,
          gridLines: setup.gridLines,
          metrics,
          objects: sheet.objects,
        });
      }
    }

    return { workbook, pages, sheets, files, defaults, fonts };
  } catch (error) {
    // Книга не должна остаться открытой из-за отказа разбора: движок держит
    // её в своей памяти, и второй такой отказ стоил бы вдвое
    workbook.dispose();

    throw error;
  }
}

/**
 * Рисует диапазон страницы печатным display list движка.
 *
 * @param opened - открытая книга
 * @param pageIndex - номер страницы в плане
 * @returns печатный display list диапазона
 */
export function pageFrame(opened: OpenedXlsx, pageIndex: number) {
  const page = pageAt(opened, pageIndex);

  return opened.workbook.printDisplayList(
    page.sheet,
    rangeAddress(page.bounds),
    page.metrics,
    page.gridLines
  );
}

/**
 * Отдаёт картинки страницы.
 *
 * В display list их нет: движок печатает ячейки, а объекты листа лежат
 * в пакете, и место им считаем мы (`media.ts`).
 *
 * @param opened - открытая книга
 * @param pageIndex - номер страницы в плане
 * @returns примитивы картинок в порядке отрисовки
 */
export function pageImages(opened: OpenedXlsx, pageIndex: number): readonly DisplayPrimitive[] {
  const page = pageAt(opened, pageIndex);

  return imagePrimitives({
    objects: page.objects,
    files: opened.files,
    bounds: page.bounds,
    cellPosition: (row: number, col: number) => opened.workbook.cellPosition(page.sheet, row, col),
  });
}

/**
 * Достаёт план страницы.
 *
 * @param opened - открытая книга
 * @param pageIndex - номер страницы в плане
 * @returns план страницы
 */
function pageAt(opened: OpenedXlsx, pageIndex: number): XlsxPagePlan {
  const page = opened.pages[pageIndex];

  if (page === undefined) {
    throw new Error(`в плане книги нет страницы ${pageIndex}`);
  }

  return page;
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
  const opened = await openXlsxPlan(bytes, options);

  try {
    const pages: DisplayPage[] = [];

    for (let index = 0; index < opened.pages.length; index += 1) {
      const plan = pageAt(opened, index);
      const primitives = [
        ...(await toPrimitives(pageFrame(opened, index), {
          fonts: opened.fonts,
          defaults: opened.defaults,
        })),
        // Картинки идут поверх ячеек: в display list их нет, а в книге
        // они лежат над сеткой — так же, как их показал бы Excel
        ...pageImages(opened, index),
      ];

      pages.push(toDisplayPage(index, plan.scale, plan.paper, plan.margins, primitives));
    }

    const displayList: DisplayList = { pages };
    const pdf = await buildPdf(displayList, { fonts: opened.fonts.resources() });

    return { pdf: pdf.bytes, pageCount: pages.length, sheets: opened.sheets, skipped: pdf.skipped };
  } finally {
    opened.workbook.dispose();
  }
}
