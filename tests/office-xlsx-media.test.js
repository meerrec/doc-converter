/**
 * Картинки книги в векторном PDF.
 *
 * Печатный display list изображений не содержит, поэтому они попадают
 * в файл отдельным путём: объекты листа из `exportStructured`, байты
 * из `xl/media` и рамка по якорю. Проверяется именно сквозной путь —
 * от части пакета до картинки в PDF, — потому что каждая его половина
 * по отдельности выглядит рабочей.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildXlsxWithPicture } from './helpers/ooxmlFixtures.js';
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
 * Достаёт потоки PDF и распаковывает их.
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

describe('картинка книги', () => {
  it('попадает в PDF растром, а не теряется', async () => {
    const bytes = await buildXlsxWithPicture({ rows: 3 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга с картинкой.xlsx',
      options: OPTIONS,
    });

    const images = readStreams(result.bytes).filter(
      (stream) => stream.dict.includes('/Subtype /Image') && stream.dict.includes('/DeviceRGB')
    );

    expect(images).toHaveLength(1);

    // Фикстура залита синим: если в PDF попал пустой поток, страница
    // соберётся, но картинки на ней не будет
    const pixels = images[0].body;
    let blue = 0;

    for (let at = 0; at + 2 < pixels.length; at += 3) {
      if (pixels[at + 2] > 200) {
        blue += 1;
      }
    }

    expect(blue).toBeGreaterThan(0);
  }, 120000);

  it('оставляет текст книги текстом', async () => {
    const bytes = await buildXlsxWithPicture({ rows: 3 });
    const result = await convertDocument({
      bytes: new Uint8Array(bytes),
      fileName: 'книга с картинкой.xlsx',
      options: OPTIONS,
    });

    const painted = readStreams(result.bytes)
      .map((stream) => new TextDecoder('latin1').decode(stream.body))
      .filter((body) => /BT[\s\S]*?Tj/.test(body));

    expect(painted.length).toBeGreaterThan(0);
  }, 120000);
});
