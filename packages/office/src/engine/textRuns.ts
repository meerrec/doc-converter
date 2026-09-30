/**
 * Прогоны `kind: 'text'` → глифы.
 *
 * Так движок отдаёт то, что сам не разложил: номера пунктов списка у документов
 * Word. Он называет строку, её начало и CSS-шорткат шрифта
 * (`"400 13.333px Calibri, sans-serif"`), ожидая, что рисовать будет хост.
 * Экспортёр PDF текстом не рисует — в PDF уходит номер глифа, — поэтому строку
 * раскладываем мы, тем же шейпингом, что и текст книги (`shape/`).
 *
 * Почему это здесь, а не в экспортёре: раскладывать нужно шрифтом, а шрифт
 * берётся из реестра — с подстановкой, загрузкой байтов и регистрацией
 * в обоих хранилищах. У экспортёра ничего этого нет и быть не должно.
 *
 * Отказ не бросается: прогон, который разложить не удалось, остаётся
 * в вёрстке как есть и попадает в счётчик пропущенного у экспортёра
 * (`pdf/support.ts`). Так потеря видна, а документ собирается.
 *
 * Все комментарии на русском языке.
 */

import type {
  DisplayList,
  DisplayPage,
  DisplayPrimitive,
  GlyphRunPrimitive,
  TextRunPrimitive,
} from '../pdf/types.js';
import { shapeRun, type ShapedRun } from '../shape/shape.js';
import type { CanvasFonts } from './canvas-fonts.js';
import type { FontRegistry } from './fonts.js';

/** Разобранный CSS-шорткат шрифта: то, чем строка набирается. */
export interface FontShorthand {
  readonly bold: boolean;
  readonly italic: boolean;
  /** Кегль в пикселях CSS. */
  readonly sizePx: number;
  /** Семейства в порядке подстановки: первое — основное. */
  readonly families: readonly string[];
}

/** Кегль в шорткате: `13.333px`, `700 16px` — с точкой и без. */
const SIZE_TOKEN = /^(\d+(?:\.\d+)?)px$/;

/** Числовые веса, которые означают полужирное начертание. */
const BOLD_WEIGHT = /^[6-9]\d\d$/;

/**
 * Разбирает CSS-шорткат шрифта.
 *
 * Разбор намеренно узкий: движок собирает эту строку сам, и в ней бывают
 * только начертание, вес, кегль и список семейств. Незнакомая запись —
 * `null`, и прогон остаётся неразобранным.
 *
 * @param value - шорткат из примитива
 * @returns начертание, кегль и семейства или `null`
 */
export function parseFontShorthand(value: string): FontShorthand | null {
  const parts = value.trim().split(/\s+/);
  const sizeIndex = parts.findIndex((part) => SIZE_TOKEN.test(part));

  if (sizeIndex < 0) {
    return null;
  }

  const sizePx = Number.parseFloat(parts[sizeIndex] ?? '');

  if (!Number.isFinite(sizePx) || sizePx <= 0) {
    return null;
  }

  const head = parts.slice(0, sizeIndex).map((part) => part.toLowerCase());
  const families = parts
    .slice(sizeIndex + 1)
    .join(' ')
    .split(',')
    // Кавычки в списке семейств — синтаксис CSS, а не часть имени
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter((family) => family !== '');

  return {
    bold: head.includes('bold') || head.some((part) => BOLD_WEIGHT.test(part)),
    italic: head.includes('italic') || head.includes('oblique'),
    sizePx,
    families,
  };
}

/**
 * Переводит один прогон в глифы.
 *
 * Семейства перебираются по порядку: годится первое, в котором нашлись все
 * символы, а если такого нет — то, что потеряло меньше. Шрифт при этом
 * регистрируется в реестре, поэтому его байты доедут до PDF.
 *
 * @param run - прогон текста
 * @param shorthand - разобранный шорткат шрифта
 * @param fonts - реестр шрифтов документа
 * @returns прогон глифами или `null`, если разложить не удалось
 */
async function toGlyphRun(
  run: TextRunPrimitive,
  shorthand: FontShorthand | null,
  fonts: FontRegistry
): Promise<GlyphRunPrimitive | null> {
  if (shorthand === null) {
    return null;
  }

  let best: { readonly id: number; readonly shaped: ShapedRun } | null = null;

  for (const family of shorthand.families) {
    const id = await fonts.ensureFamily(family, shorthand.bold, shorthand.italic);

    if (id === null) {
      continue;
    }

    const sfnt = fonts.sfntOf(id);

    if (sfnt === null) {
      continue;
    }

    const shaped = shapeRun(sfnt, run.text, shorthand.sizePx);

    if (best === null || shaped.missing < best.shaped.missing) {
      best = { id, shaped };
    }

    if (shaped.missing === 0) {
      break;
    }
  }

  if (best === null || best.shaped.glyphs.length === 0) {
    return null;
  }

  // Глифы считаются от начала строки, а прогон знает только её начало:
  // `baselineY` — базовая линия, ровно как у глифов книги
  const glyphs = best.shaped.glyphs.map((glyph) => ({
    ...glyph,
    x: run.x + glyph.x,
    y: run.baselineY,
  }));

  return {
    ...run,
    kind: 'glyphRun',
    fontId: best.id,
    size: shorthand.sizePx,
    glyphs,
  };
}

/**
 * Раскладывает на глифы все текстовые прогоны вёрстки.
 *
 * @param displayList - вёрстка документа
 * @param fonts - реестр шрифтов документа
 * @param canvasFonts - реестр шрифтов canvas; нужен предпросмотру: прогон,
 *   который разложить не удалось, рисуется строкой, а для этого начертание
 *   должно быть известно окружению
 * @returns та же вёрстка, но без прогонов `kind: 'text'` — где разложить удалось
 */
export async function shapeTextRuns(
  displayList: DisplayList,
  fonts: FontRegistry,
  canvasFonts?: CanvasFonts
): Promise<DisplayList> {
  const pages: DisplayPage[] = [];

  for (const page of displayList.pages) {
    const primitives: DisplayPrimitive[] = [];

    for (const primitive of page.primitives) {
      if (primitive.kind !== 'text') {
        primitives.push(primitive);
        continue;
      }

      const run = primitive as TextRunPrimitive;
      const shorthand = parseFontShorthand(run.font);

      // Прогон, который разложить не удастся, останется в вёрстке строкой:
      // предпросмотр нарисует его `fillText`, и начертание должно быть
      // зарегистрировано заранее
      if (shorthand !== null && canvasFonts !== undefined) {
        for (const family of shorthand.families) {
          await canvasFonts.ensure(family, shorthand.bold, shorthand.italic);
        }
      }

      const shaped = await toGlyphRun(run, shorthand, fonts);

      // Не разобралось — оставляем как есть: экспортёр его не нарисует,
      // но и промолчать не даст (см. шапку файла)
      primitives.push(shaped ?? primitive);
    }

    // Поля страницы, которых нет в наших типах (рамки, сноски), сохраняются:
    // их читает рендерер предпросмотра
    pages.push({ ...page, primitives });
  }

  return { ...displayList, pages };
}
