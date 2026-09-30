/**
 * Метрики печати книги: то, от чего зависит геометрия листа.
 *
 * `printDisplayList` принимает `PrintMetrics` — и не догадывается о них сам:
 * ширины колонок OOXML хранит в «символах», и перевод в пиксели делает хост.
 * Отсюда `maxDigitWidth`: ошибка в нём разъедет всю сетку, поэтому величина
 * считается из того же файла шрифта, которым потом рисуется текст.
 *
 * Два источника и порядок между ними:
 *
 * 1. **Таблицы шрифта** (`hmtx`, `hhea`) — эталон. Именно эти ширины уходят
 *    в PDF, поэтому расхождение между «мерой» и «рисунком» невозможно;
 * 2. **OffscreenCanvas** — проверка и уточнение: браузер считает ширину
 *    глифа по тем же байтам, если зарегистрировать их через `FontFace`.
 *    Значение берётся из canvas, когда он доступен, но ветка с таблицами
 *    остаётся рабочей и в Node, и при выключенных шрифтах.
 *
 * Все комментарии на русском языке.
 */

import type { PrintMetrics as EnginePrintMetrics } from '@betteroffice/xlsx';
import { EXCEL_DEFAULT_ROW_HEIGHT_PT, PRINT_DPI } from '../../constants.js';

/**
 * Метрики печати — тип движка под нашим именем.
 *
 * Он нужен в плане страницы (`render.ts`), а план читает и предпросмотр:
 * псевдоним избавляет от импорта движка там, где он ни к чему, и заодно
 * называет величину по-русски.
 */
export type PrintMetrics = EnginePrintMetrics;
import type { BookDefaults } from './bookXml.js';
import type { BookFont } from './fonts.js';

/** Пункт в пикселе при 96 dpi: кегль приходит в пунктах, метрики — в пикселях. */
const PT_TO_PX = PRINT_DPI / 72;

/** Код символа «0»: по его ширине Excel считает ширину колонки. */
const ZERO = 0x30;

/**
 * Считает метрики по таблицам шрифта.
 *
 * @param font - шрифт книги
 * @param defaults - шрифт «Normal»: семейство и кегль
 * @param rowHeightPt - высота строки из книги, если задана
 * @returns метрики для печатного display list
 */
export function metricsFromTables(
  font: BookFont,
  defaults: BookDefaults,
  rowHeightPt: number | null
): PrintMetrics {
  const scale = (defaults.fontSizePt * PT_TO_PX) / font.sfnt.unitsPerEm;

  return {
    dpi: PRINT_DPI,
    maxDigitWidth: font.sfnt.advance(font.sfnt.glyphId(ZERO)) * scale,
    defaultRowHeightPt: rowHeightPt ?? EXCEL_DEFAULT_ROW_HEIGHT_PT,
    fontSizePt: defaults.fontSizePt,
    fontFamily: defaults.fontFamily,
    fontAscent: font.sfnt.ascent * scale,
    // Спуск в таблицах отрицательный, а движок ждёт положительную величину
    fontDescent: Math.abs(font.sfnt.descent) * scale,
  };
}

/**
 * Считает метрики, уточняя ширину «0» замером на OffscreenCanvas.
 *
 * @param font - шрифт книги
 * @param defaults - шрифт «Normal»
 * @param rowHeightPt - высота строки из книги, если задана
 * @returns метрики для печатного display list
 */
export async function buildPrintMetrics(
  font: BookFont,
  defaults: BookDefaults,
  rowHeightPt: number | null
): Promise<PrintMetrics> {
  const metrics = metricsFromTables(font, defaults, rowHeightPt);
  const measured = await measureDigitWidth(font, defaults);

  return measured === null ? metrics : { ...metrics, maxDigitWidth: measured };
}

/**
 * Измеряет ширину «0» на OffscreenCanvas.
 *
 * Байты шрифта регистрируются через `FontFace` под именем семейства книги:
 * без этого браузер измерил бы подставленный системный шрифт, и метрика
 * разошлась бы с тем, чем мы рисуем. Любая недоступность — не ошибка:
 * вызывающий остаётся с таблицами, а они и есть эталон.
 *
 * @param font - шрифт книги
 * @param defaults - шрифт «Normal»
 * @returns ширина в пикселях или `null`, если измерить нечем
 */
async function measureDigitWidth(font: BookFont, defaults: BookDefaults): Promise<number | null> {
  const scope = globalThis as {
    OffscreenCanvas?: new (width: number, height: number) => {
      getContext(kind: '2d'): CanvasRenderingContext2D | null;
    };
    FontFace?: new (family: string, source: BufferSource) => {
      load(): Promise<unknown>;
    };
    fonts?: { add(face: never): void };
  };

  if (scope.OffscreenCanvas === undefined || scope.FontFace === undefined || scope.fonts === undefined) {
    return null;
  }

  try {
    const family = `book-${font.id}`;
    const face = new scope.FontFace(family, font.bytes.buffer as ArrayBuffer);

    await face.load();
    scope.fonts.add(face as never);

    const canvas = new scope.OffscreenCanvas(8, 8);
    const context = canvas.getContext('2d');

    if (context === null) {
      return null;
    }

    context.font = `${defaults.fontSizePt * PT_TO_PX}px "${family}"`;

    return context.measureText('0').width;
  } catch {
    // Измерение — уточнение, а не обязательный шаг: в воркере без FontFace
    // или на шрифте, который браузер отказался принять, остаются таблицы
    return null;
  }
}
