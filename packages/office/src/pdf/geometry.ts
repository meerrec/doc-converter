/**
 * Геометрия прогона текста: прямоугольник, вокруг которого его поворачивают.
 *
 * Поворот и горизонтальный масштаб движок применяет не к началу прогона,
 * а к середине его прямоугольника, и прямоугольник этот считает по своим
 * правилам — с запасом по высоте и с добором ширины, когда ширины глифов
 * неизвестны. Формулы перенесены сюда из его рендерера дословно: разойдись
 * они, предпросмотр и PDF повернули бы один и тот же текст вокруг разных
 * точек, и расхождение было бы видно только на повёрнутых надписях —
 * то есть редко и поздно. За совпадением следит тест: он сверяет наш
 * прямоугольник с `glyphRunRect` движка на одних и тех же глифах.
 *
 * Все комментарии на русском языке.
 */

import type { PositionedGlyph } from './types.js';

/**
 * Запас по высоте прогона, в долях кегля.
 *
 * 1.2 — высота строки, которой движок описывает прогон; 0.8 — доля, которая
 * приходится на выносные элементы над базовой линией. Числа его, а не наши:
 * прямоугольник нужен только как центр поворота, и совпадать он обязан
 * с движком, а не с типографской истиной.
 */
const RECT_HEIGHT = 1.2;
const RECT_ASCENT = 0.8;

/**
 * Ширина последнего глифа, когда ширин нет.
 *
 * 0.6 кегля — оценка ширины одного знака у движка: у прогона из одного глифа
 * без `advance` другой ширины взять неоткуда.
 */
const RECT_FALLBACK_ADVANCE = 0.6;

/** Прямоугольник прогона в координатах страницы. */
export interface GlyphRunRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Считает прямоугольник прогона глифов.
 *
 * @param glyphs - глифы прогона
 * @param size - кегль в пикселях CSS
 * @returns прямоугольник
 */
export function glyphRunRect(glyphs: readonly PositionedGlyph[], size: number): GlyphRunRect {
  const first = glyphs[0];

  if (first === undefined) {
    return { x: 0, y: 0, w: 0, h: size * RECT_HEIGHT };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  let measured = true;

  for (const glyph of glyphs) {
    minX = Math.min(minX, glyph.x);
    maxX = Math.max(maxX, glyph.x);

    if (glyph.advance === undefined) {
      measured = false;
    } else {
      maxEnd = Math.max(maxEnd, glyph.x + glyph.advance);
    }
  }

  // Без ширин границу прогона двигают на половину промежутка между соседними
  // глифами: у одного глифа промежутка нет, и берётся оценка ширины знака
  const width = measured
    ? Math.max(maxEnd - minX, 0)
    : maxX - minX + (glyphs.length > 1 ? (maxX - minX) / (glyphs.length - 1) : size * RECT_FALLBACK_ADVANCE);

  return { x: minX, y: first.y - size * RECT_ASCENT, w: width, h: size * RECT_HEIGHT };
}
