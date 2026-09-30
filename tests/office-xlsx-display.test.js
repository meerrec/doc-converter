/**
 * Перевод печатного display list книги в примитивы PDF.
 *
 * Проверка идёт без wasm: команды собираются руками, а шрифт берётся
 * из поставки. Так видно то, что иначе тонет в сквозном прогоне, — например,
 * что двойная граница превращается в две линии, а выравнивание текста
 * сдвигает прогон, а не саму координату глифов.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { createBookFonts } from '../packages/office/src/engine/xlsx/fonts.js';
import { toPrimitives } from '../packages/office/src/engine/xlsx/display.js';
import { metricsFromTables } from '../packages/office/src/engine/xlsx/metrics.js';

/** Умолчания книги: шрифт «Normal» и кегль. */
const DEFAULTS = { fontFamily: 'Calibri', fontSizePt: 11, bold: false, italic: false };

/**
 * Переводит команды в примитивы.
 *
 * @param commands - команды display list
 * @returns примитивы страницы
 */
async function convert(commands) {
  return toPrimitives(
    { width: 200, height: 100, commands },
    { fonts: createBookFonts(), defaults: DEFAULTS }
  );
}

describe('метрики печати', () => {
  it('считаются из того же шрифта, которым рисуется текст', async () => {
    const fonts = createBookFonts();
    const font = await fonts.family('Calibri', false, false);
    const metrics = metricsFromTables(font, DEFAULTS, null);

    // Carlito: unitsPerEm 2048, ширина «0» 1038, hhea 1950/-550.
    // Кегль 11 pt при 96 dpi — это 14.667 px
    expect(metrics.maxDigitWidth).toBeCloseTo((1038 / 2048) * (11 * (96 / 72)), 3);
    expect(metrics.fontAscent).toBeCloseTo((1950 / 2048) * (11 * (96 / 72)), 3);
    expect(metrics.fontDescent).toBeCloseTo((550 / 2048) * (11 * (96 / 72)), 3);
    expect(metrics.dpi).toBe(96);
    expect(metrics.fontSizePt).toBe(11);
    expect(metrics.defaultRowHeightPt).toBe(15);
  });

  it('берёт высоту строки из книги, когда она задана', async () => {
    const fonts = createBookFonts();
    const font = await fonts.family('Calibri', false, false);

    expect(metricsFromTables(font, DEFAULTS, 18.5).defaultRowHeightPt).toBe(18.5);
  });
});

describe('фигуры', () => {
  it('переносит заливку прямоугольника', async () => {
    const primitives = await convert([
      { op: 'fillRect', x: 1, y: 2, w: 30, h: 15, color: '#ff0000', clip: { x: 0, y: 0, w: 40, h: 20 } },
    ]);

    expect(primitives).toHaveLength(1);
    expect(primitives[0]).toMatchObject({
      kind: 'rect',
      x: 1,
      y: 2,
      w: 30,
      h: 15,
      fill: '#ff0000',
    });
    expect(primitives[0].clip).toEqual({ x: 0, y: 0, w: 40, h: 20 });
  });

  it('разворачивает двойную границу в две линии', async () => {
    const primitives = await convert([
      { op: 'line', x1: 0, y1: 10, x2: 100, y2: 10, width: 1, color: '#000000', style: 'double' },
    ]);

    expect(primitives).toHaveLength(2);

    const [top, bottom] = primitives;

    // Линии расходятся по вертикали: граница горизонтальная
    expect(top.y1).toBeLessThan(bottom.y1);
    expect(top.x1).toBe(bottom.x1);
    expect(top.strokeWidth).toBeLessThan(1);
  });

  it('переводит пунктир в узор штриха', async () => {
    const primitives = await convert([
      { op: 'line', x1: 0, y1: 0, x2: 10, y2: 0, width: 1, color: '#000000', style: 'dashed' },
    ]);

    expect(primitives[0].dash).toEqual([4, 2]);
  });

  it('переносит путь с заливкой и обводкой', async () => {
    const primitives = await convert([
      {
        op: 'path',
        commands: [
          { type: 'move', x: 0, y: 0 },
          { type: 'line', x: 10, y: 0 },
          { type: 'close' },
        ],
        fill: '#00ff00',
        stroke: { color: '#000000', width: 2 },
      },
    ]);

    expect(primitives[0]).toMatchObject({ kind: 'path', fill: '#00ff00', stroke: { color: '#000000', width: 2 } });
    expect(primitives[0].commands).toHaveLength(3);
  });
});

describe('текст', () => {
  it('раскладывает строку на глифы и сохраняет обрезку', async () => {
    const primitives = await convert([
      {
        op: 'text',
        x: 5,
        y: 20,
        text: 'Итого',
        fontSize: 11,
        color: '#000000',
        fontFamily: 'Calibri',
        clip: { x: 0, y: 0, w: 60, h: 20 },
      },
    ]);

    const run = primitives.find((primitive) => primitive.kind === 'glyphRun');

    expect(run).toBeDefined();
    expect(run.glyphs).toHaveLength(5);
    expect(run.text).toBe('Итого');
    expect(run.clip).toEqual({ x: 0, y: 0, w: 60, h: 20 });
    // Базовая линия команды переносится в каждый глиф
    expect(run.glyphs.every((glyph) => glyph.y === 20)).toBe(true);
  });

  it('сдвигает прогон при выравнивании вправо', async () => {
    const left = await convert([
      { op: 'text', x: 100, y: 10, text: '42', fontSize: 11, color: '#000000', fontFamily: 'Calibri' },
    ]);
    const right = await convert([
      {
        op: 'text',
        x: 100,
        y: 10,
        text: '42',
        fontSize: 11,
        color: '#000000',
        fontFamily: 'Calibri',
        align: 'right',
      },
    ]);

    const leftRun = left.find((primitive) => primitive.kind === 'glyphRun');
    const rightRun = right.find((primitive) => primitive.kind === 'glyphRun');

    expect(leftRun.glyphs[0].x).toBe(100);
    expect(rightRun.glyphs[0].x).toBeLessThan(100);
    // Правый край прогона совпадает с координатой команды
    expect(rightRun.glyphs.at(-1).x + rightRun.glyphs.at(-1).advance).toBeCloseTo(100, 1);
  });

  it('дорисовывает подчёркивание и выделение', async () => {
    const primitives = await convert([
      {
        op: 'text',
        x: 0,
        y: 30,
        text: 'важно',
        fontSize: 11,
        color: '#000000',
        fontFamily: 'Calibri',
        underline: true,
        highlight: '#ffff00',
      },
    ]);

    const kinds = primitives.map((primitive) => primitive.kind);

    expect(kinds).toEqual(['rect', 'glyphRun', 'decoration']);
    expect(primitives[0].fill).toBe('#ffff00');
    expect(primitives[2]).toMatchObject({ deco: 'underline' });
  });

  it('берёт скриптовый шрифт, когда в основном нет глифов', async () => {
    const primitives = await convert([
      { op: 'text', x: 0, y: 10, text: '漢字', fontSize: 11, color: '#000000', fontFamily: 'Calibri' },
    ]);

    const run = primitives.find((primitive) => primitive.kind === 'glyphRun');

    expect(run).toBeDefined();
    expect(run.glyphs).toHaveLength(2);

    // Шрифт подстановки отличается от основного: у Carlito иероглифов нет
    expect(run.fontId).not.toBe(1);
  });
});
