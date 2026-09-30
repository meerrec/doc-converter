/**
 * Разбивка листа книги на страницы.
 *
 * Геометрия здесь подставная — строки по 20 пикселей, столбцы по 50, — потому
 * что проверяется арифметика страницы, а не движок: сколько треков влезает
 * в полосу набора, где проходит жёсткий разрыв из книги и как считается
 * масштаб подгонки. Настоящая геометрия приходит из `cellPosition`, и её
 * проверяет сквозной тест.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import {
  paginate,
  parseRange,
  rangeAddress,
} from '../packages/office/src/engine/xlsx/pagination.js';

/** Геометрия с ровными треками: столбец 50 px, строка 20 px. */
const GEOMETRY = {
  cellPosition: (row, col) => ({ x: col * 50, y: row * 20 }),
};

/** Настройки листа A4 с полями 0.75″ — умолчания Excel. */
const SETUP = {
  margins: { left: 54, right: 54, top: 54, bottom: 54 },
  paper: { widthPt: 595, heightPt: 842 },
  scale: 1,
  fitToPage: false,
  fitToWidth: 1,
  fitToHeight: 1,
  gridLines: false,
  rowBreaks: [],
  colBreaks: [],
  printArea: null,
  defaultRowHeightPt: null,
};

describe('адреса диапазонов', () => {
  it('разбирает адрес и собирает его обратно', () => {
    expect(parseRange('B2:D5')).toEqual({ firstRow: 1, lastRow: 4, firstCol: 1, lastCol: 3 });
    expect(parseRange('A1')).toEqual({ firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 });
    expect(rangeAddress({ firstRow: 1, lastRow: 4, firstCol: 1, lastCol: 3 })).toBe('B2:D5');
    expect(rangeAddress(parseRange('$AA$10:$AB$11'))).toBe('AA10:AB11');
  });

  it('отвергает мусор', () => {
    expect(parseRange('не адрес')).toBeNull();
    expect(parseRange('1A')).toBeNull();
  });
});

describe('разбивка без подгонки', () => {
  it('режет лист по вместимости страницы', () => {
    // В полосу набора A4 влезает 48 строк по 20 px и 12 столбцов по 50 px
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 59, firstCol: 0, lastCol: 1 },
      setup: SETUP,
      fitToOnePage: false,
    });

    expect(pages).toHaveLength(2);
    expect(pages[0].bounds).toEqual({ firstRow: 0, lastRow: 47, firstCol: 0, lastCol: 1 });
    expect(pages[1].bounds).toEqual({ firstRow: 48, lastRow: 59, firstCol: 0, lastCol: 1 });
    expect(pages[0].scale).toBe(1);
  });

  it('делит и по столбцам, когда лист широкий', () => {
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 4, firstCol: 0, lastCol: 24 },
      setup: SETUP,
      fitToOnePage: false,
    });

    expect(pages.length).toBeGreaterThan(1);
    // Страницы идут сперва по строкам, затем по столбцам: широкий лист
    // разрезается на полосы, и каждая полоса — своя страница
    expect(pages[0].bounds.lastCol).toBe(11);
    expect(pages[1].bounds.firstCol).toBe(12);
  });

  it('уважает жёсткий разрыв из книги', () => {
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 19, firstCol: 0, lastCol: 0 },
      setup: { ...SETUP, rowBreaks: [10] },
      fitToOnePage: false,
    });

    expect(pages).toHaveLength(2);
    expect(pages[0].bounds).toEqual({ firstRow: 0, lastRow: 9, firstCol: 0, lastCol: 0 });
    expect(pages[1].bounds).toEqual({ firstRow: 10, lastRow: 19, firstCol: 0, lastCol: 0 });
  });
});

describe('подгонка под страницу', () => {
  it('умещает лист на одной странице, сжимая содержимое', () => {
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 59, firstCol: 0, lastCol: 1 },
      setup: SETUP,
      fitToOnePage: true,
    });

    expect(pages).toHaveLength(1);
    // Высота листа 1200 px против 978.67 px полосы — сжатие меньше единицы
    expect(pages[0].scale).toBeLessThan(1);
    expect(pages[0].scale).toBeCloseTo(978.67 / 1200, 2);
  });

  it('не увеличивает лист, который и так меньше страницы', () => {
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 2, firstCol: 0, lastCol: 1 },
      setup: SETUP,
      fitToOnePage: true,
    });

    expect(pages[0].scale).toBe(1);
  });

  it('берёт масштаб из книги, когда подгонка выключена', () => {
    const pages = paginate({
      geometry: GEOMETRY,
      bounds: { firstRow: 0, lastRow: 5, firstCol: 0, lastCol: 1 },
      setup: { ...SETUP, scale: 0.5 },
      fitToOnePage: false,
    });

    expect(pages[0].scale).toBe(0.5);
    // Сжатие вдвое — на страницу влезает вдвое больше треков
    expect(pages).toHaveLength(1);
  });
});
