/**
 * Раскладка строки по файлу шрифта: разбор sfnt, глифы, выбор fallback'а.
 *
 * Проверка идёт на настоящем шрифте из поставки (Carlito — метрический
 * заменитель Calibri, тот же файл уходит и в PDF). Числа в ожиданиях —
 * свойства самого файла: `unitsPerEm` и ширина «0» взяты из его таблиц,
 * и если они разойдутся, разъедется вся вёрстка книг.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSfnt } from '../packages/office/src/shape/sfnt.js';
import { shapeRun } from '../packages/office/src/shape/shape.js';
import { scriptFallbackOf } from '../packages/office/src/shape/script.js';

/** Путь к шрифту поставки: он же используется движком книг. */
const CARLITO = new URL(
  '../packages/office/node_modules/@betteroffice/fonts/assets/Carlito-Regular.ttf',
  import.meta.url
);

/**
 * Читает шрифт поставки.
 *
 * @returns байты шрифта
 */
function carlito() {
  return new Uint8Array(readFileSync(CARLITO));
}

describe('разбор sfnt', () => {
  it('читает метрики и глифы Carlito', () => {
    const font = parseSfnt(carlito());

    expect(font).not.toBeNull();
    expect(font.unitsPerEm).toBe(2048);
    expect(font.ascent).toBe(1950);
    expect(font.descent).toBe(-550);

    const zero = font.glyphId(0x30);

    expect(zero).toBeGreaterThan(0);
    // Ширина «0» — та, из которой считается `maxDigitWidth` метрик печати
    expect(font.advance(zero)).toBe(1038);
    expect(font.advance(0)).toBeGreaterThanOrEqual(0);
  });

  it('отвечает нулём на символ вне шрифта', () => {
    const font = parseSfnt(carlito());

    // Иероглифа в латинском начертании нет — по этому нулю и выбирается fallback
    expect(font.glyphId(0x65e5)).toBe(0);
    expect(font.glyphId(0x1f600)).toBe(0);
  });

  it('не разбирает мусор', () => {
    expect(parseSfnt(new Uint8Array(8))).toBeNull();
    expect(parseSfnt(new Uint8Array(64))).toBeNull();
  });
});

describe('раскладка строки', () => {
  it('ставит глифы и считает кластеры в байтах', () => {
    const font = parseSfnt(carlito());
    const run = shapeRun(font, 'строка 5', 11 * (96 / 72));

    expect(run.missing).toBe(0);
    expect(run.glyphs).toHaveLength(8);
    // Кириллица занимает по два байта UTF-8 — кластеры идут через два,
    // и `ToUnicode` в PDF строится именно по ним
    expect(run.glyphs.map((glyph) => glyph.cluster)).toEqual([0, 2, 4, 6, 8, 10, 12, 13]);
    expect(run.glyphs[0].x).toBe(0);
    expect(run.glyphs[1].x).toBeGreaterThan(0);
    expect(run.width).toBeGreaterThan(0);
  });

  it('считает недостающие символы, не сдвигая соседей', () => {
    const font = parseSfnt(carlito());
    const run = shapeRun(font, 'a日b', 11 * (96 / 72));

    expect(run.missing).toBe(1);
    expect(run.glyphs).toHaveLength(2);

    // Перо прошло и через отсутствующий глиф: иначе «b» наехало бы на «a»
    const [first, second] = run.glyphs;

    expect(second.x).toBeGreaterThan(first.x);
  });

  it('ширина строки растёт с кеглем', () => {
    const font = parseSfnt(carlito());
    const small = shapeRun(font, 'Итого', 11 * (96 / 72));
    const large = shapeRun(font, 'Итого', 22 * (96 / 72));

    expect(large.width).toBeCloseTo(small.width * 2, 5);
  });
});

describe('выбор скриптового fallback', () => {
  it('опознаёт письменности', () => {
    expect(scriptFallbackOf('привет')).toBeNull();
    expect(scriptFallbackOf('Total 42')).toBeNull();
    expect(scriptFallbackOf('にほんご')).toBe('cjk-jp');
    expect(scriptFallbackOf('한국어')).toBe('cjk-kr');
    expect(scriptFallbackOf('汉字')).toBe('cjk-sc');
    expect(scriptFallbackOf('مرحبا')).toBe('arabic');
    expect(scriptFallbackOf('שלום')).toBe('hebrew');
  });

  it('предпочитает письменность письменности, а не порядку в строке', () => {
    // Арабское письмо встречается позже иероглифов, но требует своего шрифта:
    // основной гарнитуре его взять неоткуда
    expect(scriptFallbackOf('漢字 مرحبا')).toBe('arabic');
  });
});
