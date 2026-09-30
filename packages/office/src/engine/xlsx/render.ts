/**
 * Книга Excel → векторный PDF.
 *
 * Конвейер книги: пакет XLSX разбирается дважды — настройки печати читаем
 * мы (`bookXml.ts`), содержимое разбирает движок, — затем каждый лист режется
 * на страницы (`pagination.ts`), каждая страница рисуется печатным display
 * list и переводится в примитивы (`display.ts`), а PDF собирает общий
 * экспортёр (`pdf/`).
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

import { initWasm, openWorkbook, type WorkbookHandle } from '@betteroffice/xlsx';
import { unzipSync } from 'fflate';
import { isNodeRuntime } from '../../assets.js';
import { buildPdf } from '../../pdf/export.js';
import type { DisplayPage, DisplayPrimitive, DisplayList } from '../../pdf/types.js';
import { readBookDefaults, readPrintArea, readSheetParts, readSheetSetup } from './bookXml.js';
import { toPrimitives } from './display.js';
import { createBookFonts } from './fonts.js';
import { imagePrimitives } from './media.js';
import { buildPrintMetrics } from './metrics.js';
import { paginate, parseRange, rangeAddress, type RangeBounds, type TrackGeometry } from './pagination.js';

/** Готовая книга: PDF целиком, число страниц и число видимых листов. */
export interface RenderedXlsx {
  readonly pdf: Uint8Array;
  readonly pageCount: number;
  readonly sheets: number;
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

    const pages: DisplayPage[] = [];
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
      const paperWidth = setup.paper.widthPt * PT_TO_PX;
      const paperHeight = setup.paper.heightPt * PT_TO_PX;

      for (const sheetPage of sheetPages) {
        const frame = workbook.printDisplayList(
          index,
          rangeAddress(sheetPage.bounds),
          metrics,
          setup.gridLines
        );
        // Картинки идут поверх ячеек: в display list их нет, а в книге
        // они лежат над сеткой — так же, как их показал бы Excel
        const primitives = [
          ...(await toPrimitives(frame, { fonts, defaults })),
          ...imagePrimitives({
            objects: sheet.objects,
            files,
            bounds: sheetPage.bounds,
            cellPosition: (row: number, col: number) => workbook.cellPosition(index, row, col),
          }),
        ];

        pages.push(
          toDisplayPage(
            pages.length,
            sheetPage.scale,
            { width: paperWidth, height: paperHeight },
            { x: setup.margins.left * PT_TO_PX, y: setup.margins.top * PT_TO_PX },
            primitives
          )
        );
      }
    }

    const displayList: DisplayList = { pages };
    const pdf = await buildPdf(displayList, { fonts: fonts.resources() });

    return { pdf, pageCount: pages.length, sheets };
  } finally {
    workbook.dispose();
  }
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
