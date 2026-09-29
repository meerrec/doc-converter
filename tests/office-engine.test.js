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
import { inflateSync } from 'node:zlib';
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

/**
 * Достаёт потоки PDF и распаковывает их, как это делает просмотрщик.
 *
 * Проверка нужна потому, что `/FlateDecode` — это формат **zlib**, а не
 * «сырой» DEFLATE: поток, сжатый вторым, просмотрщик читает как пустой,
 * и страница выходит белой при внешне целом файле. Так и было: тесты
 * сверяли заголовок и дерево страниц, а чем нарисован PDF — никто не смотрел.
 *
 * @param pdf - байты файла
 * @returns список потоков со словарём и распакованными байтами
 */
function readStreams(pdf) {
  const text = new TextDecoder('latin1').decode(pdf);
  const streams = [];
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf('stream\n', index);

    if (at < 0) {
      break;
    }

    const dict = text.slice(text.lastIndexOf('<<', at), at).replace(/\s+/g, ' ');
    const end = text.indexOf('endstream', at);
    const body = pdf.subarray(at + 'stream\n'.length, end);

    streams.push({
      dict,
      body: dict.includes('/FlateDecode') ? new Uint8Array(inflateSync(body)) : new Uint8Array(body),
    });

    index = end + 'endstream'.length;
  }

  return streams;
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

/**
 * Проверки нарисованного: файл может быть целым снаружи и пустым внутри.
 *
 * `readStreams` здесь не вспомогательная мелочь, а половина проверки: он
 * падает на потоке, сжатом не по формату `/FlateDecode`. Просмотрщик такой
 * поток молча читает пустым, и страница выходит белой — именно это и случилось
 * однажды, когда содержимое сжали «сырым» DEFLATE вместо zlib.
 */
describe('содержимое PDF', () => {
  it('документ Word рисует текст, а не белые страницы', async () => {
    const bytes = await buildDocx({ paragraphs: 3 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'документ.docx',
      options: OPTIONS,
    });

    const painted = readStreams(result.bytes)
      .map((stream) => new TextDecoder('latin1').decode(stream.body))
      .filter((body) => /BT\s[\s\S]*Tj/.test(body));

    expect(painted.length).toBeGreaterThan(0);
  }, 120000);

  it('страница книги приходит непустой картинкой', async () => {
    const bytes = await buildXlsx({ sheets: 1, rows: 5 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга.xlsx',
      options: OPTIONS,
    });

    // Только цветовой слой: маска прозрачности — тоже картинка, но у плотной
    // страницы она белая по построению, и проверка на ней ничего не значит
    const images = readStreams(result.bytes).filter(
      (stream) => stream.dict.includes('/Subtype /Image') && stream.dict.includes('/DeviceRGB')
    );

    expect(images.length).toBeGreaterThan(0);

    for (const image of images) {
      const pixels = image.body;
      let painted = 0;

      for (let at = 0; at + 2 < pixels.length; at += 3) {
        if (pixels[at] !== 255 || pixels[at + 1] !== 255 || pixels[at + 2] !== 255) {
          painted += 1;
        }
      }

      expect(painted).toBeGreaterThan(0);
    }
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
