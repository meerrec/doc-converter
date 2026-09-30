import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { convertDocument } from '../packages/office/src/engine/convert.js';

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

describe('разбор настоящего документа', () => {
  it('конвертирует и показывает структуру', async () => {
    const bytes = new Uint8Array(readFileSync('fixtures/СУС УТП_v2.0_31.10.25.docx'));
    const started = Date.now();
    const result = await convertDocument({ bytes, fileName: 'док.docx', options: OPTIONS });

    console.log('страниц:', result.pageCount, '| байт PDF:', result.bytes.byteLength, '| мс:', Date.now() - started);
    writeFileSync('/tmp/docx-check.pdf', result.bytes);

    const text = new TextDecoder('latin1').decode(result.bytes);
    const mediaBoxes = [...text.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1]);
    const sizes = new Map();

    for (const box of mediaBoxes) {
      sizes.set(box, (sizes.get(box) ?? 0) + 1);
    }

    console.log('размеры страниц:', [...sizes.entries()].map(([box, count]) => `${box} ×${count}`).join(' | '));

    let index = 0;
    let withText = 0;
    let withImage = 0;
    let empty = 0;
    const pageTexts = [];

    while (index < text.length) {
      const at = text.indexOf('stream\n', index);

      if (at < 0) {
        break;
      }

      const dict = text.slice(text.lastIndexOf('<<', at), at).replace(/\s+/g, ' ');
      const end = text.indexOf('endstream', at);
      const body = result.bytes.subarray(at + 7, end);
      const unpacked = dict.includes('/FlateDecode') ? new Uint8Array(inflateSync(body)) : body;
      const content = new TextDecoder('latin1').decode(unpacked);

      if (/Tj/.test(content)) {
        withText += 1;
        const cids = [...content.matchAll(/<([0-9A-F]+)>\s*Tj/g)].length;

        if (pageTexts.length < 3) {
          pageTexts.push(`глифов: ${cids}; операторов: ${content.split('\n').length}`);
        }
      } else if (dict.includes('/Subtype /Image')) {
        withImage += 1;
      } else if (/\/Contents/.test(dict)) {
        empty += 1;
      }

      index = end + 9;
    }

    console.log('потоков с текстом:', withText, '| картинок:', withImage, '| страниц без потока содержимого:', empty);
    console.log('примеры:', pageTexts.join(' // '));
  }, 300000);
});
