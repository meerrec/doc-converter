/**
 * Экспортёр PDF: что доезжает до файла, а что нет.
 *
 * Проверки идут на синтетической вёрстке, а не на документе целиком: так
 * видно причину, а не следствие. Документ Word с прозрачностью собрать
 * фикстурой нельзя — движок берёт её из VML-водяного знака в колонтитуле,
 * — а примитив с `opacity` собирается одной строкой, и проверяется именно
 * то место, где поле раньше терялось.
 *
 * Тут же сверяются с движком две вещи, которые иначе расходятся молча:
 * прямоугольник прогона (вокруг его центра поворачивается текст) и сам
 * поворот. Ошибка в них видна только на повёрнутых надписях — редко и поздно.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
// Движок импортируется только тестом: в самом экспортёре его нет — формулы
// перенесены в `pdf/geometry.ts`, и эта проверка следит, чтобы они не разошлись
import { glyphRunRect as engineGlyphRunRect } from '@betteroffice/docx/layout/render';
import { createBookFonts } from '../packages/office/src/engine/xlsx/fonts.js';
import { buildPdf } from '../packages/office/src/pdf/export.js';
import { glyphRunRect } from '../packages/office/src/pdf/geometry.js';
import { SUPPORTED_KINDS } from '../packages/office/src/pdf/support.js';
import { shapeRun } from '../packages/office/src/shape/shape.js';

/** Размер страницы синтетических проверок: A4 в пикселях CSS. */
const PAGE = { width: 794, height: 1123 };

/** Пиксель CSS → пункт PDF: то же отношение, что и в экспортёре. */
const PX_TO_PT = 72 / 96;

/**
 * Достаёт потоки содержимого PDF.
 *
 * @param pdf - байты файла
 * @returns распакованные потоки, помеченные как содержимое страницы
 */
function readContentStreams(pdf) {
  const text = new TextDecoder('latin1').decode(pdf);
  const bodies = [];
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf('stream\n', index);

    if (at < 0) {
      break;
    }

    const dict = text.slice(text.lastIndexOf('<<', at), at).replace(/\s+/g, ' ');
    const end = text.indexOf('endstream', at);
    const body = pdf.subarray(at + 'stream\n'.length, end);

    index = end + 'endstream'.length;

    if (!dict.includes('/FlateDecode')) {
      continue;
    }

    bodies.push(new TextDecoder('latin1').decode(inflateSync(body)));
  }

  return bodies;
}

/**
 * Загружает шрифт поставки и раскладывает им строку.
 *
 * Настоящий шрифт нужен потому, что экспортёр субсеттит его по использованным
 * глифам: поддельные номера глифов до потока страницы не дошли бы. Берётся
 * он тем же реестром, что и для книги, — так в проверке нет второго способа
 * достать шрифт.
 *
 * @param text - что набрать
 * @returns байты шрифта, имя семейства, номер и глифы
 */
async function shapeWithBundledFont(text) {
  const registry = createBookFonts();
  const font = await registry.family('Calibri', false, false);

  expect(font).not.toBeNull();

  const run = shapeRun(font.sfnt, text, 16);

  expect(run.glyphs.length).toBe(text.length);

  return { id: font.id, bytes: font.bytes, name: font.family, glyphs: run.glyphs };
}

/**
 * Собирает PDF из одной страницы с переданными примитивами.
 *
 * @param primitives - примитивы страницы
 * @param fonts - шрифты по номерам
 * @returns результат сборки
 */
function buildPage(primitives, fonts = new Map()) {
  return buildPdf({ pages: [{ pageIndex: 0, ...PAGE, primitives }] }, { fonts });
}

describe('прозрачность', () => {
  /**
   * Поле прозрачности движок называет `opacity`, а экспортёр читал `alpha`.
   * Поле необязательное, поэтому расхождение не ловилось типами: водяные
   * знаки и полупрозрачные заливки выходили плотными.
   */
  it('полупрозрачная заливка доезжает до файла', async () => {
    const result = await buildPage([
      { kind: 'rect', x: 10, y: 10, w: 100, h: 50, fill: '#ff0000', opacity: 0.5 },
    ]);

    const file = new TextDecoder('latin1').decode(result.bytes);

    expect(file).toContain('/ExtGState');
    expect(file).toContain('/ca 0.5');
    expect(readContentStreams(result.bytes).join('\n')).toContain('/GS1 gs');
  });

  it('непрозрачный примитив состояния не заводит', async () => {
    const result = await buildPage([
      { kind: 'rect', x: 10, y: 10, w: 100, h: 50, fill: '#ff0000', opacity: 1 },
    ]);

    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('/ExtGState');
  });
});

describe('пропущенное', () => {
  it('перечисляет виды, которых экспортёр не рисует', async () => {
    const result = await buildPage([
      { kind: 'shape', x: 0, y: 0, w: 10, h: 10 },
      { kind: 'shape', x: 0, y: 0, w: 10, h: 10 },
      { kind: 'rect', x: 10, y: 10, w: 100, h: 50, fill: '#ff0000' },
    ]);

    expect(result.skipped).toEqual({ shape: 2 });
  });

  it('поддержанная вёрстка не считает ничего', async () => {
    const result = await buildPage([
      { kind: 'rect', x: 10, y: 10, w: 100, h: 50, fill: '#ff0000' },
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10, strokeWidth: 1, color: '#000000' },
    ]);

    expect(result.skipped).toEqual({});
  });

  /**
   * Список поддержанного — утверждение о реализации, а не пожелание: он
   * совпадает с ветками разбора в `export.ts`. Новый вид примитива у движка
   * не должен появляться незамеченным — эта проверка заставляет дополнить
   * список (и разбор), а не потерять содержимое страницы молча.
   */
  it('список поддержанных видов зафиксирован', () => {
    expect([...SUPPORTED_KINDS]).toEqual(['rect', 'line', 'image', 'decoration', 'glyphRun', 'path']);
  });
});

describe('геометрия прогона', () => {
  it('прямоугольник совпадает с движком', async () => {
    const { glyphs } = await shapeWithBundledFont('Пример текста');

    expect(glyphRunRect(glyphs, 16)).toEqual(engineGlyphRunRect({ glyphs, size: 16 }));
  });

  it('прямоугольник без ширин совпадает с движком', () => {
    const glyphs = [
      { id: 1, x: 10, y: 20, cluster: 0 },
      { id: 2, x: 25, y: 20, cluster: 1 },
    ];

    expect(glyphRunRect(glyphs, 12)).toEqual(engineGlyphRunRect({ glyphs, size: 12 }));
  });

  it('пустой прогон совпадает с движком', () => {
    expect(glyphRunRect([], 10)).toEqual(engineGlyphRunRect({ glyphs: [], size: 10 }));
  });
});

/**
 * Поворот и горизонтальный масштаб.
 *
 * Эталон — canvas: движок поворачивает прогон вызовами `translate`/`rotate`
 * вокруг центра его прямоугольника. Здесь эта же последовательность
 * собирается в матрицу и сверяется с тем, что попало в поток страницы:
 * проверять координаты на глаз бессмысленно, а ошибка в знаке угла или
 * в точке поворота на обычном документе не видна вовсе.
 */
describe('преобразование прогона', () => {
  /** Матрица `a b c d e f` — та же запись, что у canvas и у оператора `cm`. */
  const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];

  const translate = (x, y) => [1, 0, 0, 1, x, y];

  const rotate = (deg) => {
    const angle = (deg * Math.PI) / 180;

    return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
  };

  const scale = (x, y) => [x, 0, 0, y, 0, 0];

  /** Применяет матрицу к точке. */
  const apply = (m, point) => ({
    x: m[0] * point.x + m[2] * point.y + m[4],
    y: m[1] * point.x + m[3] * point.y + m[5],
  });

  /**
   * Собирает матрицу так, как это делает canvas: каждый следующий вызов
   * домножается справа, а точка проходит преобразования в обратном порядке.
   */
  const canvasTransform = (rect, rotationDeg, horizontalScale) => {
    let matrix = [1, 0, 0, 1, 0, 0];

    if (rotationDeg !== 0) {
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };

      matrix = multiply(matrix, translate(center.x, center.y));
      matrix = multiply(matrix, rotate(rotationDeg));
      matrix = multiply(matrix, translate(-center.x, -center.y));
    }

    if (horizontalScale !== 100) {
      const anchor = { x: rect.x, y: rect.y + rect.h / 2 };

      matrix = multiply(matrix, translate(anchor.x, anchor.y));
      matrix = multiply(matrix, scale(horizontalScale / 100, 1));
      matrix = multiply(matrix, translate(-anchor.x, -anchor.y));
    }

    return matrix;
  };

  /**
   * Достаёт матрицы, которые экспортёр поставил перед текстом страницы.
   *
   * @param pdf - байты файла
   * @returns матрицы в порядке появления
   */
  const contentMatrices = (pdf) =>
    readContentStreams(pdf)
      .join('\n')
      .split('\n')
      .map((line) => /^([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => match.slice(1).map(Number));

  /**
   * Сверяет преобразование экспортёра с canvas на наборе пробных точек.
   *
   * @param rotationDeg - поворот прогона
   * @param horizontalScale - горизонтальный масштаб
   */
  async function expectTransformMatches(rotationDeg, horizontalScale) {
    const { id, bytes, name, glyphs } = await shapeWithBundledFont('Поворот');
    const result = await buildPage(
      [
        {
          kind: 'glyphRun',
          fontId: id,
          size: 16,
          color: '#000000',
          text: 'Поворот',
          glyphs,
          rotationDeg,
          horizontalScale,
        },
      ],
      new Map([[id, { name, bytes }]])
    );

    // Матриц может быть несколько (поворот и масштаб — отдельные операторы),
    // и работают они вместе: `cm` домножает текущую матрицу справа
    const emitted = contentMatrices(result.bytes);

    expect(emitted.length).toBeGreaterThan(0);

    const matrix = emitted.reduce((current, next) => multiply(current, next), [1, 0, 0, 1, 0, 0]);

    const reference = canvasTransform(glyphRunRect(glyphs, 16), rotationDeg, horizontalScale);
    const probes = [{ x: 0, y: 0 }, { x: 120, y: 40 }, { x: -30, y: 700 }, { x: 794, y: 1123 }];

    for (const probe of probes) {
      // Canvas считает в пикселях CSS и осью Y вниз, PDF — в пунктах и осью Y
      // вверх: точка переводится туда и обратно, иначе сверялись бы разные
      // величины (72/96 — то же отношение, что и в экспортёре)
      const inPdf = { x: probe.x * PX_TO_PT, y: (PAGE.height - probe.y) * PX_TO_PT };
      const viaPdf = apply(matrix, inPdf);
      const viaCanvas = apply(reference, probe);

      expect(viaPdf.x / PX_TO_PT).toBeCloseTo(viaCanvas.x, 1);
      expect(PAGE.height - viaPdf.y / PX_TO_PT).toBeCloseTo(viaCanvas.y, 1);
    }
  }

  it('поворот совпадает с canvas', async () => {
    await expectTransformMatches(90, 100);
  });

  it('обратный поворот совпадает с canvas', async () => {
    await expectTransformMatches(-37, 100);
  });

  it('горизонтальный масштаб совпадает с canvas', async () => {
    await expectTransformMatches(0, 80);
  });

  it('поворот с масштабом совпадает с canvas', async () => {
    await expectTransformMatches(45, 120);
  });

  it('прогон без преобразований матрицы не получает', async () => {
    const { id, bytes, name, glyphs } = await shapeWithBundledFont('Ровно');
    const result = await buildPage(
      [
        {
          kind: 'glyphRun',
          fontId: id,
          size: 16,
          color: '#000000',
          text: 'Ровно',
          glyphs,
        },
      ],
      new Map([[id, { name, bytes }]])
    );

    expect(contentMatrices(result.bytes)).toEqual([]);
  });
});
