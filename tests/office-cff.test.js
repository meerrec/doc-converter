/**
 * Разбор CFF: какой CID соответствует номеру глифа движка.
 *
 * Проверка стоит на настоящем субсете CJK-шрифта, а не на синтетических
 * байтах: ценность здесь именно в том, что harfbuzz при субсеттинге сохраняет
 * номера глифов, но перенумеровывает CID, и charset формата 2 (диапазоны
 * по два байта) читается не так, как формат 1 (по одному). Ошибка в этом
 * месте не роняет сборку — она тихо рисует не те знаки, поэтому проверяется
 * отдельно от сквозного теста.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readGlyphToCid } from '../packages/office/src/pdf/cff.js';
import { loadSubsetter } from '../packages/office/src/pdf/subset.js';

/** Резолюция пакетов шрифтов — от манифеста `office`, где они объявлены. */
const require = createRequire(new URL('../packages/office/package.json', import.meta.url));

/**
 * Путь к файлу шрифта из пакета.
 *
 * @param pkg - имя пакета шрифтов
 * @param file - имя файла в его `assets`
 * @returns абсолютный путь
 */
function fontAsset(pkg, file) {
  const manifest = require.resolve(`${pkg}/package.json`);

  return path.join(path.dirname(manifest), 'assets', file);
}

/** Японский шрифт: CFF в контейнере `OTTO`. */
const CJK_FONT = fontAsset('@betteroffice/fonts-cjk', 'NotoSansJP-Regular.otf');

/** Латиница: TrueType, где CID и номер глифа совпадают. */
const LATIN_FONT = fontAsset('@betteroffice/fonts', 'Carlito-Regular.ttf');

describe('карта CID', () => {
  it('для TrueType не нужна', async () => {
    const bytes = new Uint8Array(await readFile(LATIN_FONT));

    expect(readGlyphToCid(bytes)).toBeNull();
  });

  it('на мусоре отвечает отказом, а не падением', () => {
    expect(readGlyphToCid(new Uint8Array(0))).toBeNull();
    expect(readGlyphToCid(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 1, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(readGlyphToCid(new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('в субсете CJK расходится с номерами глифов', async () => {
    const subsetter = await loadSubsetter();
    const font = new Uint8Array(await readFile(CJK_FONT));
    const subset = subsetter.subset(font, '日本語のテスト文書です。');
    const cidOf = readGlyphToCid(subset);

    expect(cidOf).not.toBeNull();
    expect(cidOf[0]).toBe(0);

    // Карта обязана быть биекцией: два глифа с одним CID — уже потеря
    const cids = new Set(cidOf);
    let different = 0;

    for (let glyph = 1; glyph < cidOf.length; glyph += 1) {
      if (cidOf[glyph] !== glyph) {
        different += 1;
      }
    }

    expect(cids.size).toBe(cidOf.length);
    expect(different).toBeGreaterThan(0);
  }, 120000);
});
