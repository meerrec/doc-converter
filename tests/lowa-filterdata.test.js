/**
 * Согласованность параметров экспорта PDF: браузерный путь против серверного.
 *
 * Один и тот же документ должен конвертироваться одинаково независимо от того,
 * где это произошло. Параметры экспортёра задаются списком `FilterData`,
 * и списков теперь два: серверный — в `docker/uno/uno_convert.py`, браузерный —
 * в `apps/web/src/local/lowa/filterData.ts`.
 *
 * Разошедшись, они дадут разный результат, и заметить это можно было бы только
 * сравнением готовых PDF: файл получается валидным в обоих случаях. Поэтому
 * имена свойств разбираются прямо из Python-скрипта, а не переписываются
 * в тест: переписанный список сверялся бы сам с собой.
 *
 * Числовые коды версии PDF проверяются отдельно — они берутся из контракта,
 * и второго источника этих чисел быть не должно.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDF_VERSION_CODES } from '@doc-converter/contract';
import { buildFilterData } from '../apps/web/src/local/lowa/filterData.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UNO_SCRIPT = `${ROOT}docker/uno/uno_convert.py`;

/**
 * Извлекает имена свойств FilterData из серверного скрипта.
 *
 * Берётся только тело сборки параметров: в остальном файле есть строки,
 * не имеющие отношения к делу. Имена свойств записаны в PascalCase,
 * чем и отличаются от ключей параметров конвертации (`options.get("quality")`)
 * и от служебных строк.
 *
 * @returns множество имён свойств
 */
function serverFilterDataNames() {
  const source = readFileSync(UNO_SCRIPT, 'utf8');
  const start = source.indexOf('def build_filter_data');
  const end = source.indexOf('def load_document');

  expect(start, 'в uno_convert.py не найдена сборка FilterData').toBeGreaterThan(-1);
  expect(end, 'в uno_convert.py не найдена граница сборки FilterData').toBeGreaterThan(start);

  const body = source.slice(start, end);
  const names = new Set();

  for (const match of body.matchAll(/"([A-Z][A-Za-z]+)"/g)) {
    names.add(match[1]);
  }

  return names;
}

/** Параметры конвертации по умолчанию — те же, что в интерфейсе. */
const BASE_OPTIONS = {
  watermark: '',
  watermarkMode: 'single',
  fitToOnePage: true,
  pdfVersion: 'default',
  quality: 90,
  reduceImageResolution: true,
  maxImageResolution: 300,
  exportBookmarks: true,
  taggedPdf: false,
  userPassword: '',
  ownerPassword: '',
  restrictPermissions: false,
  allowPrinting: true,
  allowChanges: false,
};

/**
 * Собирает список имён из результата сборки параметров.
 *
 * @param options - параметры конвертации
 * @returns множество имён свойств
 */
function browserFilterDataNames(options) {
  return new Set(buildFilterData(options).map((entry) => entry.name));
}

const serverNames = serverFilterDataNames();

/**
 * Ключи, которые экспортёр принимает по выбору, а не вместе.
 *
 * Водяной знак задаётся либо одним по центру, либо мозаикой по странице,
 * и одновременно два этих свойства не имеют смысла: сравнивать их наличие
 * в списках «в лоб» нельзя. Соответствие режима и ключа проверяется отдельно.
 */
const ALTERNATIVE_KEYS = new Set(['Watermark', 'TiledWatermark']);

describe('FilterData: браузерный путь против серверного', () => {
  it('при полном наборе параметров списки совпадают', () => {
    const browserNames = browserFilterDataNames({
      ...BASE_OPTIONS,
      watermark: 'черновик',
      userPassword: 'открыть',
      ownerPassword: 'владелец',
    });

    // Каждое свойство, которое отправляет браузер, должно существовать
    // и на сервере: иначе параметр просто не дойдёт до экспортёра.
    for (const name of browserNames) {
      expect(serverNames.has(name), `свойство ${name} есть только в браузерном пути`).toBe(true);
    }

    // И наоборот: свойство, которое знает сервер, не должно потеряться
    // в браузере — иначе результат разойдётся при одинаковых настройках.
    // Взаимоисключающие ключи пропускаются: их пара проверяется отдельно.
    for (const name of serverNames) {
      if (ALTERNATIVE_KEYS.has(name)) {
        continue;
      }

      expect(browserNames.has(name), `свойство ${name} потеряно в браузерном пути`).toBe(true);
    }
  });

  it('водяной знак добавляется только при непустом значении и своим ключом', () => {
    const withoutWatermark = browserFilterDataNames(BASE_OPTIONS);

    expect(withoutWatermark.has('Watermark')).toBe(false);
    expect(withoutWatermark.has('TiledWatermark')).toBe(false);

    const single = browserFilterDataNames({ ...BASE_OPTIONS, watermark: 'черновик' });
    expect(single.has('Watermark')).toBe(true);
    expect(single.has('TiledWatermark')).toBe(false);

    // Пробелы по краям не делают знак значимым: строка из пробелов — это
    // отсутствие знака, а не знак из пробелов
    const blank = browserFilterDataNames({ ...BASE_OPTIONS, watermark: '   ' });
    expect(blank.has('Watermark')).toBe(false);

    const tiled = browserFilterDataNames({
      ...BASE_OPTIONS,
      watermark: 'черновик',
      watermarkMode: 'tiled',
    });
    expect(tiled.has('TiledWatermark')).toBe(true);
    expect(tiled.has('Watermark')).toBe(false);
  });

  it('шифрование включается паролем, без отдельного флага', () => {
    // Флага шифрования в контракте нет: включённым его делает заданный пароль.
    // Проверяются оба пароля — они независимы, и любого достаточно.
    for (const options of [
      { ...BASE_OPTIONS, userPassword: 'открыть' },
      { ...BASE_OPTIONS, ownerPassword: 'владелец' },
    ]) {
      expect(browserFilterDataNames(options).has('EncryptFile')).toBe(true);
    }

    expect(browserFilterDataNames(BASE_OPTIONS).has('EncryptFile')).toBe(false);
  });

  it('права не ограничиваются, если ограничение выключено', () => {
    const unrestricted = buildFilterData({ ...BASE_OPTIONS, userPassword: 'открыть' });
    const byName = new Map(unrestricted.map((entry) => [entry.name, entry.value]));

    // Битовые флаги: 4 — печать, 8 — изменение содержимого. При выключенном
    // ограничении оба разрешения выдаются независимо от того, что выбрано
    // в полях печати и изменений
    expect(byName.get('Printing')).toBe(4);
    expect(byName.get('Change')).toBe(8);

    const restricted = buildFilterData({
      ...BASE_OPTIONS,
      userPassword: 'открыть',
      restrictPermissions: true,
      allowPrinting: false,
      allowChanges: false,
    });
    const restrictedByName = new Map(restricted.map((entry) => [entry.name, entry.value]));

    expect(restrictedByName.get('Printing')).toBe(0);
    expect(restrictedByName.get('Change')).toBe(0);
  });

  it('отсутствие необязательных полей не ломает сборку', () => {
    // Водяной знак и пароли в контракте необязательны: интерфейс их
    // не заполняет, и в задачу они могут не попасть вовсе
    const data = buildFilterData({
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
    });

    expect(data.length).toBeGreaterThan(0);
    expect(data.some((entry) => entry.value === undefined)).toBe(false);
  });

  it('версия PDF передаётся кодом из контракта', () => {
    for (const [version, code] of Object.entries(PDF_VERSION_CODES)) {
      const data = buildFilterData({ ...BASE_OPTIONS, pdfVersion: version });
      const entry = data.find((item) => item.name === 'SelectPdfVersion');

      expect(entry?.value, `версия ${version}`).toBe(code);
    }
  });
});
