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
import { renderDocx } from '../packages/office/src/engine/document.js';
import { readGlyphToCid } from '../packages/office/src/pdf/cff.js';

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

/**
 * Номера пунктов списка.
 *
 * Движок отдаёт их прогоном `kind: 'text'` — строкой и CSS-шорткатом шрифта, —
 * а экспортёр PDF текстом не рисует: в файл уходит номер глифа. Пока такие
 * прогоны пропускались, нумерованный список выходил без номеров, и заметить
 * это можно было только глазами в скачанном файле.
 */
describe('список', () => {
  it('номер пункта доезжает до PDF глифами', async () => {
    const bytes = await buildDocx({ paragraphs: 0, numbered: 2 });
    const rendered = await renderDocx(new Uint8Array(bytes));
    const markers = rendered.displayList.pages[0].primitives.filter(
      (primitive) => primitive.listMarker === true
    );

    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.kind)).toEqual(['glyphRun', 'glyphRun']);
    expect(markers.every((marker) => marker.glyphs.length > 0)).toBe(true);

    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'список.docx',
      options: OPTIONS,
    });

    // Пропущенного нет: будь прогоны не разобраны, они остались бы в вёрстке
    // как `text`, и счётчик это назвал бы
    expect(result.skipped).toEqual({});

    // Точка из «1.» — единственная в этом документе: её появление в таблице
    // копирования и есть след номера, нарисованного глифами
    const cmaps = readStreams(result.bytes)
      .map((stream) => new TextDecoder('latin1').decode(stream.body))
      .filter((body) => body.includes('beginbfchar'));

    expect(cmaps.some((body) => body.includes('<002E>'))).toBe(true);
  }, 120000);
});

/**
 * Перенос строк внутри абзаца.
 *
 * Проверка стоит на вёрстке, а не на PDF: именно здесь видно, разбит абзац
 * на строки или лёг одной длинной. Без разбивки текст уходил за поля
 * и налезал на соседние колонки — так и было, пока шрифты регистрировались
 * только в движке измерения и вёрстка оставалась без них.
 */
describe('вёрстка документа', () => {
  it('длинный абзац переносится по строкам', async () => {
    const long =
      'Длинный абзац, который заведомо не помещается в полосу набора страницы и обязан быть разбит на несколько строк при вёрстке документа, иначе он вылезет за поля.';
    const bytes = await buildDocx({ lines: [long] });
    const rendered = await renderDocx(new Uint8Array(bytes));
    const primitives = rendered.displayList.pages[0].primitives;
    const runs = primitives.filter((primitive) => primitive.kind === 'glyphRun' || primitive.kind === 'text');
    const baselines = new Set(
      runs.map((run) => Math.round(run.glyphs?.[0]?.y ?? run.baselineY ?? 0))
    );

    expect(runs.length).toBeGreaterThan(1);
    expect(baselines.size).toBeGreaterThan(1);
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

  /**
   * Иероглифы приходят CFF-шрифтом (`OTTO`), а не TrueType, и встраиваются
   * другим словарём — `FontFile3`/`CIDFontType0`. Проверка нужна потому, что
   * ошибка здесь не роняет сборку: файл выходит целым, а страница — с чужими
   * знаками или пустой. Так и было, пока в поток писался номер глифа вместо
   * CID, а шрифт субсеттился с сохранением этих номеров.
   */
  it('документ с иероглифами адресует глифы по CID встроенного шрифта', async () => {
    const bytes = await buildDocx({ lines: ['日本語のテスト文書です'] });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'иероглифы.docx',
      options: OPTIONS,
    });

    expect(new TextDecoder('latin1').decode(result.bytes)).toContain('/FontFile3');

    const streams = readStreams(result.bytes);
    const decode = (body) => new TextDecoder('latin1').decode(body);
    const embedded = streams
      .map((stream) => stream.body)
      .find((body) => decode(body.subarray(0, 4)) === 'OTTO');

    expect(embedded).toBeDefined();

    // `ToUnicode` строится по тем же CID: в нём обязан быть знак из текста
    const cmaps = streams.map((stream) => decode(stream.body)).filter((body) => body.includes('beginbfchar'));

    expect(cmaps.some((body) => body.includes('<65E5>'))).toBe(true);

    // Все CID из потока страницы должны быть в charset встроенного шрифта:
    // запись номера глифа вместо CID эту проверку не прошла бы, потому что
    // карта субсета не тождественна
    const cidOf = readGlyphToCid(embedded);
    const known = new Set(cidOf);
    const content = streams
      .map((stream) => decode(stream.body))
      .filter((body) => /BT[\s\S]*?ET/.test(body))
      .join('\n');
    const used = [...content.matchAll(/<([0-9A-F]+)>\s*Tj/g)].map((match) => parseInt(match[1], 16));

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((cid) => !known.has(cid))).toEqual([]);
  }, 120000);

  /**
   * Книга рисуется вектором, а не картинкой: текст в PDF обязан быть текстом.
   *
   * Проверка идёт по потоку страницы и по `ToUnicode`: одного `Tj`
   * недостаточно — нарисованные глифы без таблицы соответствия видны,
   * но не ищутся и не копируются, а это и было причиной отказа от растра.
   */
  it('страница книги рисует текст глифами, а не картинкой', async () => {
    const bytes = await buildXlsx({ sheets: 1, rows: 5 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга.xlsx',
      options: OPTIONS,
    });

    const streams = readStreams(result.bytes);
    const painted = streams
      .map((stream) => new TextDecoder('latin1').decode(stream.body))
      .filter((body) => /BT[\s\S]*?Tj/.test(body));

    expect(painted.length).toBeGreaterThan(0);

    // Текст из фикстуры — «строка N»: буква «с» (U+0441) должна найтись
    // в таблице копирования, иначе выделить и найти её будет нельзя
    const cmaps = streams
      .map((stream) => new TextDecoder('latin1').decode(stream.body))
      .filter((body) => body.includes('beginbfchar'));

    expect(cmaps.some((body) => body.includes('<0441>'))).toBe(true);

    // Растровых страниц больше нет: картинка в книжном PDF остаётся только
    // у изображений самой книги, а их в фикстуре нет
    const images = streams.filter((stream) => stream.dict.includes('/Subtype /Image'));

    expect(images).toEqual([]);
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
