/**
 * Сессия предпросмотра: что открывается и что рисуется.
 *
 * Пиксели в Node не проверить — там нет ни `OffscreenCanvas`, ни `Path2D`, —
 * зато проверяемо всё остальное: сколько страниц, какого они размера, что
 * не доедет до PDF и что растр честно отказывает вместо тихой пустоты.
 * Это и есть та половина предпросмотра, которая ломается незаметно.
 *
 * Главный инвариант — «в предпросмотре те же страницы, что скачаются» —
 * держится здесь на сверке с конвертацией: число страниц книги обязано
 * совпадать, потому что оба пути берут его из одного плана (`openXlsxPlan`).
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { loadGlyphOutlineProvider, GlyphCache } from '@betteroffice/docx/layout/render';
import { buildDocx, buildXlsx } from './helpers/ooxmlFixtures.js';
import { convertDocument } from '../packages/office/src/engine/convert.js';
import { renderDocx } from '../packages/office/src/engine/document.js';
import { openPreview } from '../packages/office/src/engine/preview.js';

/** Параметры конвертации по умолчанию — те же значения, что в контракте. */
const OPTIONS = {
  watermarkMode: 'single',
  fitToOnePage: true,
  pdfVersion: 'default',
  quality: 90,
  reduceImageResolution: true,
  maxImageResolution: 300,
  exportBookmarks: true,
  taggedPdf: false,
  restrictPermissions: false,
  allowPrinting: true,
  allowChanges: false,
};

/**
 * Открывает сессию предпросмотра для фикстуры.
 *
 * @param bytes - байты файла
 * @param fileName - имя файла
 * @returns сессия
 */
function preview(bytes, fileName) {
  return openPreview({ bytes: new Uint8Array(bytes), fileName, options: OPTIONS });
}

/**
 * Подставной путь: настоящего `Path2D` в Node нет.
 *
 * Контурам достаточно принимать вызовы — проверяется не форма, а то,
 * что контур вообще нашёлся.
 *
 * @returns объект, отвечающий на любой вызов
 */
function fakePath() {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    }
  );
}

describe('открытие сессии', () => {
  it('документ Word отдаёт страницы вёрстки', async () => {
    const bytes = await buildDocx({ paragraphs: 3 });
    const rendered = await renderDocx(new Uint8Array(bytes));
    const session = await preview(bytes, 'документ.docx');

    expect(session.pageCount).toBe(rendered.displayList.pages.length);
    expect(session.sheets).toBeNull();
    expect(session.pages).toEqual(
      rendered.displayList.pages.map((page) => ({ width: page.width, height: page.height }))
    );
    expect(session.skipped).toEqual({});

    session.close();
  });

  it('книга отдаёт столько же страниц, сколько конвертация', async () => {
    const bytes = await buildXlsx({ sheets: 2, rows: 5 });
    const converted = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга.xlsx',
      options: OPTIONS,
    });
    const session = await preview(bytes, 'книга.xlsx');

    expect(session.pageCount).toBe(converted.pageCount);
    expect(session.sheets).toBe(converted.sheets);
    // Размеры страниц — бумага книги: по ним панель ставит плейсхолдеры
    expect(session.pages.every((page) => page.width > 0 && page.height > 0)).toBe(true);

    session.close();
  });

  it('отвергает параметры, которых движок не умеет', async () => {
    const bytes = await buildDocx();

    await expect(
      openPreview({
        bytes: new Uint8Array(bytes),
        fileName: 'документ.docx',
        options: { ...OPTIONS, watermark: 'черновик' },
      })
    ).rejects.toMatchObject({ code: 'engine_unsupported' });
  });

  it('отвергает чужой формат', async () => {
    const bytes = await buildDocx();

    await expect(preview(bytes, 'документ.pdf')).rejects.toMatchObject({
      code: 'engine_unsupported',
    });
  });
});

describe('растр', () => {
  /**
   * В Node растеризовать нечем. Отказ должен быть громким и понятным:
   * молчаливая пустая страница выглядела бы как «документ без содержимого».
   */
  it('в Node отказывает, а не отдаёт пустоту', async () => {
    const bytes = await buildDocx({ paragraphs: 3 });
    const session = await preview(bytes, 'документ.docx');

    await expect(session.render(0, 1)).rejects.toMatchObject({ code: 'engine_unsupported' });

    session.close();
  });

  it('закрытая сессия страниц не рисует', async () => {
    const bytes = await buildDocx({ paragraphs: 3 });
    const session = await preview(bytes, 'документ.docx');

    session.close();
    session.close();

    await expect(session.render(0, 1)).resolves.toBeNull();
  });

  it('страницы за пределами документа нет', async () => {
    const bytes = await buildDocx({ paragraphs: 1 });
    const session = await preview(bytes, 'документ.docx');

    await expect(session.render(99, 1)).rejects.toMatchObject({ code: 'engine_convert_failed' });

    session.close();
  });
});

/**
 * Главный риск предпросмотра.
 *
 * Контуры глифов движок отдаёт по номерам из хранилища, которое наполнила
 * вёрстка. Если хранилище окажется другим или номера переиспользуются,
 * страницы выйдут с чужими знаками — и заметить это можно только глазами.
 */
describe('контуры глифов', () => {
  it('разрешаются по номерам, которые дала вёрстка', async () => {
    const bytes = await buildDocx({ paragraphs: 2 });
    const rendered = await renderDocx(new Uint8Array(bytes));
    const run = rendered.displayList.pages[0].primitives.find(
      (primitive) => primitive.kind === 'glyphRun'
    );

    expect(run).toBeDefined();

    const provider = await loadGlyphOutlineProvider();
    const cache = new GlyphCache({ provider, createPath: fakePath });
    const outline = cache.get(run.fontId, run.glyphs[0].id);

    expect(outline.path).not.toBeNull();
    expect(outline.upem).toBeGreaterThan(0);
  });

  /**
   * Сессия обязана переживать чужую конвертацию: хранилище отрисовки наши
   * вызовы только пополняют, номера в нём не переиспользуются. Если это
   * перестанет быть так, открытый предпросмотр начнёт рисовать чужие глифы,
   * поэтому инвариант закреплён проверкой, а не комментарием.
   */
  it('переживают вёрстку второго документа', async () => {
    const first = await renderDocx(new Uint8Array(await buildDocx({ paragraphs: 2 })));
    const run = first.displayList.pages[0].primitives.find(
      (primitive) => primitive.kind === 'glyphRun'
    );

    await renderDocx(new Uint8Array(await buildDocx({ lines: ['Совсем другой документ'] })));

    const provider = await loadGlyphOutlineProvider();
    const cache = new GlyphCache({ provider, createPath: fakePath });

    expect(cache.get(run.fontId, run.glyphs[0].id).path).not.toBeNull();
  });
});
