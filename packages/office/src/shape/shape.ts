/**
 * Раскладка строки по разобранному шрифту.
 *
 * Задача узкая: у нас есть строка, файл шрифта и кегль, а нужны глифы
 * с координатами — в том виде, в каком их понимает экспортёр PDF
 * (`GlyphRunPrimitive`). Ни лигатуры, ни кернинг, ни переупорядочивание
 * не считаются: полного OT-шейпинга в сборке harfbuzz нет (см. `sfnt.ts`),
 * и для книг это почти всегда верно.
 *
 * Координаты — **от начала строки**, а не от края ячейки: выравнивание
 * (`align`) применяет вызывающий, сдвигая готовый прогон целиком. Это
 * позволяет вычислить ширину один раз и не зависеть от того, в каком
 * порядке пришли глифы.
 *
 * Кластеры — смещения в **байтах UTF-8**, а не в знаках: ровно этого требует
 * `ToUnicode` в экспортёре (он режет исходный текст по байтам, см.
 * `collectFontUsage`).
 *
 * Все комментарии на русском языке.
 */

import type { SfntFont } from './sfnt.js';
import type { PositionedGlyph } from '../pdf/types.js';

/** Итог раскладки: глифы, ширина строки и счётчик недостающих. */
export interface ShapedRun {
  /** Глифы в порядке следования; `x` — от начала строки. */
  readonly glyphs: readonly PositionedGlyph[];
  /** Ширина строки в пикселях: по ней считается выравнивание. */
  readonly width: number;
  /** Сколько символов не нашлось в шрифте: по нему выбирается fallback. */
  readonly missing: number;
}

/**
 * Раскладывает строку на глифы.
 *
 * Символ без глифа не попадает в вывод, но его ширина всё равно двигает
 * перо: иначе соседние знаки слиплись бы, а по счётчику `missing` вызывающий
 * понимает, что строку нужно набрать другим шрифтом.
 *
 * @param font - разобранный шрифт
 * @param text - строка ячейки
 * @param sizePx - кегль в пикселях (96 dpi)
 * @returns глифы, ширина и число недостающих символов
 */
export function shapeRun(font: SfntFont, text: string, sizePx: number): ShapedRun {
  const scale = sizePx / font.unitsPerEm;
  const glyphs: PositionedGlyph[] = [];
  let pen = 0;
  let cluster = 0;
  let missing = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const id = font.glyphId(codePoint);
    const advance = font.advance(id) * scale;

    if (id === 0) {
      missing += 1;
    } else {
      glyphs.push({ id, x: pen, y: 0, cluster, advance });
    }

    pen += advance;
    cluster += utf8Length(codePoint);
  }

  return { glyphs, width: pen, missing };
}

/**
 * Длина символа в байтах UTF-8.
 *
 * @param codePoint - код символа
 * @returns число байтов, которое он займёт в UTF-8
 */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }

  if (codePoint < 0x800) {
    return 2;
  }

  return codePoint < 0x10000 ? 3 : 4;
}
