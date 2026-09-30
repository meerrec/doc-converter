/**
 * Регистрация шрифтов: движок называет, что ему нужно, — грузим ровно это.
 *
 * Проверка стоит на уровне `registerFonts`, а не сквозного прогона: в Node
 * шрифты читаются с диска, и лишний шрифт там ничего не стоит. Цена заметна
 * в браузере — одни только CJK-начертания весят больше 20 МБ, и документ
 * на кириллице не должен их скачивать. Поэтому здесь важны не байты,
 * а то, о чём спросили провайдера.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { registerFonts } from '../packages/office/src/engine/fonts.js';

/**
 * Хранилище-заглушка: выдаёт номера шрифтов.
 *
 * @returns хранилище с растущей нумерацией
 */
function fakeStore() {
  let next = 0;

  return {
    registerFont() {
      next += 1;

      return next;
    },
  };
}

/**
 * Пара хранилищ — как в конвейере: сессия вёрстки и движок отрисовки.
 *
 * @returns хранилища для `registerFonts`
 */
function fakeStores() {
  return { layout: fakeStore(), render: fakeStore() };
}

/**
 * Семейства, которые провайдер-заглушка считает известными: остальным
 * он отвечает `undefined`, и подстановку замыкает last resort.
 */
const KNOWN_FAMILIES = new Set([
  'Calibri',
  'Cambria',
  'Courier New',
  'Georgia',
  'Symbol',
  'Times New Roman',
]);

/** Провайдер-заглушка: записывает, что у него спросили. */
function fakeProvider() {
  const asked = [];
  const bytes = () => async () => new ArrayBuffer(8);

  return {
    asked,
    resolve(family, bold, italic) {
      asked.push(`resolve:${family}|${bold ? 1 : 0}|${italic ? 1 : 0}`);

      return KNOWN_FAMILIES.has(family) ? bytes() : undefined;
    },
    resolveScriptFallback(script) {
      asked.push(`script:${script}`);

      return bytes();
    },
    resolveLastResort(family) {
      asked.push(`last:${family}`);

      return bytes();
    },
  };
}

/** Требование, к которому добавляются проверяемые скрипты. */
const CALIBRI = { key: 'calibri|0|0', family: 'Calibri', bold: false, italic: false };

/**
 * Имена шрифтов, попавших в реестр.
 *
 * @param registry - реестр из `registerFonts`
 * @returns имена без порядка регистрации
 */
function namesOf(registry) {
  return [...registry.files.values()].map((font) => font.name);
}

describe('регистрация шрифтов', () => {
  it('не грузит скриптовые fallback\'и, если движок их не назвал', async () => {
    const provider = fakeProvider();
    const registry = await registerFonts(fakeStores(), provider, [CALIBRI]);

    expect(provider.asked.filter((call) => call.startsWith('script:'))).toEqual([]);
    expect(namesOf(registry).filter((name) => name.startsWith('script:'))).toEqual([]);
    expect(registry.chains[CALIBRI.key]).toEqual([1]);
  });

  it('грузит только названный скрипт', async () => {
    const provider = fakeProvider();
    const registry = await registerFonts(fakeStores(), provider, [
      { ...CALIBRI, scripts: ['cjk-jp'] },
    ]);
    const scripts = namesOf(registry).filter((name) => name.startsWith('script:'));

    expect(provider.asked).toContain('script:cjk-jp');
    expect(scripts).toEqual(['script:cjk-jp']);
  });

  it('замыкает цепочку каждого требования общим набором скриптов', async () => {
    const provider = fakeProvider();
    const registry = await registerFonts(fakeStores(), provider, [
      { ...CALIBRI, scripts: ['arabic'] },
      { key: 'georgia|0|0', family: 'Georgia', bold: false, italic: false, scripts: ['hebrew'] },
    ]);

    // Порядок — как в SCRIPT_FALLBACKS, чтобы цепочки не зависели от порядка
    // требований: у обоих требований хвост одинаковый
    const expectedTail = [...registry.files.entries()]
      .filter(([, font]) => font.name.startsWith('script:'))
      .map(([id]) => id);

    expect(namesOf(registry).filter((name) => name.startsWith('script:')).sort()).toEqual([
      'script:arabic',
      'script:hebrew',
    ]);

    for (const key of [CALIBRI.key, 'georgia|0|0']) {
      const chain = registry.chains[key];

      expect(chain.slice(1)).toEqual(expectedTail);
      expect(chain).toHaveLength(expectedTail.length + 1);
    }
  });

  it('подставляет last resort вместо ненайденного семейства', async () => {
    const provider = fakeProvider();
    const unknown = { key: 'загадочный|0|0', family: 'Загадочный', bold: false, italic: false };
    const registry = await registerFonts(fakeStores(), provider, [unknown]);

    expect(provider.asked).toContain('last:Загадочный');
    expect(namesOf(registry)).toContain('загадочный|0|0');
  });
});
