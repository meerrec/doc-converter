/**
 * Шрифты книги: чем набран текст и что уйдёт в PDF.
 *
 * Печатный display list отдаёт текст строкой с именем семейства и начертанием —
 * глифов в нём нет. Значит, шрифт нужен дважды: нам — чтобы разложить строку
 * (`shape/`), экспортёру PDF — чтобы встроить те же байты. Один файл на оба
 * дела и есть причина существования реестра.
 *
 * Грузится только то, что встретилось. Книга на кириллице платит за латиницу
 * и кириллицу, но не за CJK-начертания, которые весят больше 20 МБ. Порядок
 * подстановки повторяет серверный путь: основное семейство, затем последняя
 * надежда (Excel подставляет сюда Calibri, как и PowerPoint), а скриптовые
 * начертания запрашиваются отдельно — уже после того, как выяснилось, что
 * в основном шрифте символов нет.
 *
 * Все комментарии на русском языке.
 */

import type { BundledFontScript, BundledFontSource } from '@betteroffice/fonts';
import { createFontProvider } from '@betteroffice/fonts';
import type { FontResource } from '../../pdf/types.js';
import { parseSfnt, type SfntFont } from '../../shape/sfnt.js';

/** Шрифт книги: байты для PDF и разобранные таблицы для раскладки. */
export interface BookFont {
  /** Номер, которым шрифт называется в примитивах страницы. */
  readonly id: number;
  /** Имя семейства — попадает в `/BaseFont`. */
  readonly family: string;
  readonly bytes: Uint8Array;
  readonly sfnt: SfntFont;
}

/** Реестр шрифтов одной книги. */
export interface BookFonts {
  /**
   * Отдаёт основное начертание семейства.
   *
   * @param family - имя семейства из книги
   * @param bold - полужирное начертание
   * @param italic - курсив
   * @returns шрифт или `null`, если подстановка не нашлась
   */
  family(family: string, bold: boolean, italic: boolean): Promise<BookFont | null>;
  /**
   * Отдаёт начертание для письменности, которой нет в основном шрифте.
   *
   * @param script - имя скрипта
   * @param bold - полужирное начертание
   * @param italic - курсив
   * @returns шрифт или `null`
   */
  script(script: BundledFontScript, bold: boolean, italic: boolean): Promise<BookFont | null>;
  /** Шрифты по номерам — то, что ждёт экспортёр PDF. */
  resources(): ReadonlyMap<number, FontResource>;
}

/**
 * Создаёт реестр шрифтов книги.
 *
 * @param provider - источник байтов; по умолчанию — шрифты поставки
 * @returns реестр
 */
export function createBookFonts(provider?: BundledFontSource): BookFonts {
  const source = provider ?? createFontProvider();
  const files = new Map<number, FontResource>();
  const cache = new Map<string, Promise<BookFont | null>>();
  let nextId = 0;

  /**
   * Загружает и разбирает шрифт по ключу кэша.
   *
   * @param key - ключ «что именно попросили»
   * @param family - имя семейства для `/BaseFont`
   * @param loader - откуда взять байты
   * @returns шрифт или `null`
   */
  const load = (
    key: string,
    family: string,
    loader: (() => Promise<ArrayBuffer>) | undefined
  ): Promise<BookFont | null> => {
    const pending = cache.get(key);

    if (pending !== undefined) {
      return pending;
    }

    const started = (async (): Promise<BookFont | null> => {
      if (loader === undefined) {
        return null;
      }

      const bytes = new Uint8Array(await loader());
      const sfnt = parseSfnt(bytes);

      // Файл, который не разобрался, для раскладки бесполезен: глифов
      // из него не получить, а в PDF он попал бы пустым
      if (sfnt === null) {
        return null;
      }

      nextId += 1;

      const font: BookFont = { id: nextId, family, bytes, sfnt };

      files.set(nextId, { name: family, bytes });

      return font;
    })();

    cache.set(key, started);

    return started;
  };

  return {
    family(family: string, bold: boolean, italic: boolean): Promise<BookFont | null> {
      const key = `family:${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
      // Подстановка та же, что у серверного пути: известное семейство,
      // а для незнакомого — Calibri, как это делает Excel
      const loader = source.resolve(family, bold, italic) ?? source.resolveLastResort(family, bold, italic, 'powerpoint');

      return load(key, family, loader);
    },

    script(script: BundledFontScript, bold: boolean, italic: boolean): Promise<BookFont | null> {
      const key = `script:${script}|${bold ? 1 : 0}|${italic ? 1 : 0}`;

      return load(key, script, source.resolveScriptFallback(script, bold, italic));
    },

    resources(): ReadonlyMap<number, FontResource> {
      return files;
    },
  };
}
