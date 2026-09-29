/**
 * Сквозной путь своего движка: файл → PDF, без браузера.
 *
 * Движок BetterOffice собран так, что работает и в Node: wasm-модули он
 * находит сам, а вёрстка не требует ни DOM, ни canvas. Поэтому здесь
 * проверяется то, что иначе видно только в браузере: фикстура проекта
 * разбирается, раскладывается по страницам, а экспортёр отдаёт файл с
 * заголовком PDF и объявленным числом страниц.
 *
 * PDF проверяется по содержимому, а не по факту «файл создался»: пустой
 * результат тоже файл. Поэтому сверяется и заголовок, и дерево страниц.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { buildDocx, buildXlsx } from './helpers/ooxmlFixtures.js';
import { convertDocument } from '../packages/office/src/engine/convert.js';

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
 * Читает объявленное число страниц из дерева страниц PDF.
 *
 * @param pdf - байты файла
 * @returns число страниц или null, если оно не найдено
 */
function pageCountOf(pdf) {
  const text = new TextDecoder('latin1').decode(pdf);
  const match = /\/Count (\d+)/.exec(text);

  return match === null ? null : Number(match[1]);
}

describe('документ Word', () => {
  it('раскладывается и отдаёт PDF', async () => {
    const bytes = await buildDocx({ paragraphs: 3 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'документ.docx',
      options: OPTIONS,
    });

    const head = new TextDecoder().decode(result.bytes.subarray(0, 5));

    expect(head).toBe('%PDF-');
    expect(result.pageCount).toBeGreaterThan(0);
    expect(pageCountOf(result.bytes)).toBe(result.pageCount);
    expect(result.sheets).toBeNull();
  }, 120000);
});

describe('книга Excel', () => {
  it('раскладывается и отдаёт PDF', async () => {
    const bytes = await buildXlsx({ sheets: 2, rows: 5 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга.xlsx',
      options: OPTIONS,
    });

    const head = new TextDecoder().decode(result.bytes.subarray(0, 5));

    expect(head).toBe('%PDF-');
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.sheets).toBe(2);
  }, 120000);
});

describe('неподдержанные запросы', () => {
  it('отвергает формат, которого нет в списке', async () => {
    const bytes = await buildDocx();

    await expect(
      convertDocument({
        bytes: new Uint8Array(bytes),
        fileName: 'документ.doc',
        options: OPTIONS,
      })
    ).rejects.toThrow(/формат не поддержан/);
  });

  it('отвергает пароль вместо того, чтобы выдать незащищённый файл', async () => {
    const bytes = await buildDocx();

    await expect(
      convertDocument({
        bytes: new Uint8Array(bytes),
        fileName: 'документ.docx',
        options: { ...OPTIONS, userPassword: 'секрет' },
      })
    ).rejects.toThrow(/пароль/);
  });
});
