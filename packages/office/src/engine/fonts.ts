/**
 * Регистрация шрифтов в движке и построение цепочек подстановки.
 *
 * Шрифты регистрируем **сами**, а не через `source.prepareFontRequirements`:
 * тот отдаёт внутренние номера движка, по которым потом нельзя достать байты,
 * а байты нужны — их встраивает PDF. `registerFont` возвращает номер, который
 * мы и запоминаем вместе с содержимым файла.
 *
 * Вторая тонкость — **цепочка**. Display list ссылается на шрифт по номеру,
 * и в него попадают не только основные начертания, но и те, что движок взял
 * из fallback'а (CJK, арабский, иврит). Знать их все обязательно: глиф,
 * нарисованный шрифтом, байтов которого у нас нет, в PDF не попадёт.
 *
 * Все комментарии на русском языке.
 */

import type { FontResource } from '../pdf/types.js';
import { parseSfnt, type SfntFont } from '../shape/sfnt.js';

/** Скриптовые fallback'и: ими движок закрывает то, чего нет в основных. */
const SCRIPT_FALLBACKS = ['cjk-sc', 'cjk-tc', 'cjk-jp', 'cjk-kr', 'arabic', 'hebrew'] as const;

/**
 * Семейства, которых движок может не назвать в требованиях.
 *
 * Требования собираются по телу документа, а колонтитулы, поля и надписи
 * могут быть набраны другим шрифтом. Цепочки строим мы, поэтому зарегистрировать
 * лишнее дешевле, чем получить текст, для которого нет байтов.
 */
const EXTRA_FAMILIES: readonly (readonly [string, boolean, boolean])[] = [
  ['Calibri', false, false],
  ['Calibri', true, false],
  ['Cambria', false, false],
  ['Times New Roman', true, false],
  ['Courier New', false, false],
  ['Symbol', false, false],
];

/** Требование движка к шрифту: что именно нужно найти. */
export interface FontRequirement {
  /** Ключ цепочки: им же движок называет шрифт в измерении. */
  readonly key: string;
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /**
   * Скриптовые fallback'и, которые движок просит для этого требования.
   *
   * Поля может не быть: латинице и кириллице хватает основной гарнитуры.
   * Это поле движка (типы пакета его не описывают), поэтому наличие
   * проверяется здесь, а не предполагается.
   */
  readonly scripts?: readonly string[];
}

/** Отдаёт байты шрифта по требованию; `undefined` — такого шрифта нет. */
export type FontLoader = () => Promise<ArrayBuffer>;

/** Откуда берутся шрифты: обёртка над `@betteroffice/fonts`. */
export interface FontProvider {
  resolve(family: string, bold: boolean, italic: boolean): FontLoader | undefined;
  resolveScriptFallback?(script: string, bold: boolean, italic: boolean): FontLoader | undefined;
  resolveLastResort?(family: string, bold: boolean, italic: boolean): FontLoader | undefined;
}

/**
 * Хранилище шрифтов: то, куда их кладут перед вёрсткой.
 *
 * Это **сессия документа**, а не отдельный текстовый движок. У каждой сессии
 * свой набор шрифтов со своей нумерацией, и раскладку строк ведёт именно она:
 * зарегистрированные в другом месте байты ей не видны, абзац ложится одной
 * длинной строкой и налезает на соседние колонки. Проверено на документе
 * с таблицами — переносы появляются ровно тогда, когда шрифты легли сюда,
 * а номера цепочек взяты из ответов этого же хранилища: номера чужого
 * хранилища совпадают лишь у первого документа, а на втором расходятся,
 * и вёрстка снова теряет строки.
 */
export interface FontStore {
  registerFont(bytes: Uint8Array): number;
}

/**
 * Два хранилища, в которые кладутся одни и те же байты.
 *
 * Нумерация у них своя: сессия вёрстки считает шрифты со своего нуля,
 * движок отрисовки — со своего. Совпадают эти номера только у первого
 * документа в процессе — на втором расходятся, и вёрстка, получив чужие,
 * теряет строки. Поэтому шрифт регистрируется в обоих, а цепочки для вёрстки
 * и для примитивов строятся каждая из своих номеров.
 */
export interface FontStores {
  /** Хранилище сессии: его номера уходят в измерение вёрстки. */
  readonly layout: FontStore;
  /** Хранилище отрисовки: его номера приходят в примитивах и уходят в PDF. */
  readonly render: FontStore;
}

/** Что получилось: байты по номерам и цепочки по ключам требований. */
export interface FontRegistry {
  /** Номер шрифта в хранилище отрисовки → имя и байты. */
  readonly files: Map<number, FontResource>;
  /** Ключ требования → номера шрифтов для примитивов страницы. */
  readonly chains: Record<string, number[]>;
  /** Тот же ключ → номера для измерения вёрстки. */
  readonly layoutChains: Record<string, number[]>;
  /**
   * Разобранные таблицы шрифта по номеру отрисовки.
   *
   * Нужны там, где строку раскладываем мы сами — номера пунктов списка:
   * движок отдаёт их текстом, а в PDF они должны уйти глифами.
   *
   * @param id - номер шрифта в хранилище отрисовки
   * @returns разобранный шрифт или `null`
   */
  sfntOf(id: number): SfntFont | null;
  /**
   * Догружает семейство, которого не было в требованиях движка.
   *
   * Требования собираются по телу документа, а номера пунктов списка набраны
   * своим шрифтом, и его в них может не оказаться. Семейство проходит ту же
   * подстановку, что и остальные (`resolve`, затем `resolveLastResort`),
   * и ложится в оба хранилища — иначе его глифов не найдёт ни вёрстка,
   * ни экспортёр.
   *
   * @param family - имя семейства из документа
   * @param bold - полужирное начертание
   * @param italic - курсив
   * @returns номер шрифта в хранилище отрисовки или `null`
   */
  ensureFamily(family: string, bold: boolean, italic: boolean): Promise<number | null>;
}

/**
 * Регистрирует шрифты и строит цепочки.
 *
 * @param stores - хранилища вёрстки и отрисовки
 * @param provider - источник байтов
 * @param requirements - что запросил движок по этому документу
 * @returns реестр шрифтов
 */
export async function registerFonts(
  stores: FontStores,
  provider: FontProvider,
  requirements: readonly FontRequirement[]
): Promise<FontRegistry> {
  const files = new Map<number, FontResource>();

  /** Номера одного шрифта в обоих хранилищах. */
  interface Registered {
    readonly render: number;
    readonly layout: number;
  }

  /** Загружает байты и отдаёт номера; `null` — шрифта нет. */
  const register = async (name: string, loader: FontLoader | undefined): Promise<Registered | null> => {
    if (loader === undefined) {
      return null;
    }

    const data = new Uint8Array(await loader());

    // Байты грузятся один раз, а кладутся в оба хранилища: расхождение
    // наборов между вёрсткой и отрисовкой и есть причина потерянных строк
    const render = stores.render.registerFont(data);
    const layout = stores.layout.registerFont(data);

    files.set(render, { name, bytes: data });

    return { render, layout };
  };

  // Скриптовые fallback'и общие для всех цепочек: они добирают то, чего нет
  // в основной гарнитуре, и стоят в конце каждой цепочки. Но грузятся
  // не все подряд, а только названные движком: CJK-начертания весят больше
  // 20 МБ, и документ на кириллице не должен платить за них. Движок сообщает
  // нужные скрипты в требованиях (`scripts`), пустой список означает, что
  // fallback'и не понадобятся
  const neededScripts = new Set<string>();

  for (const requirement of requirements) {
    for (const script of requirement.scripts ?? []) {
      neededScripts.add(script);
    }
  }

  const scriptIds: number[] = [];
  const scriptLayoutIds: number[] = [];

  for (const script of SCRIPT_FALLBACKS) {
    if (!neededScripts.has(script)) {
      continue;
    }

    const ids = await register(`script:${script}`, provider.resolveScriptFallback?.(script, false, false));

    if (ids !== null) {
      scriptIds.push(ids.render);
      scriptLayoutIds.push(ids.layout);
    }
  }

  const chains: Record<string, number[]> = {};
  const layoutChains: Record<string, number[]> = {};

  /**
   * Регистрирует семейство и заводит для него цепочку.
   *
   * @param key - ключ цепочки
   * @param family - имя семейства в документе
   * @param bold - полужирное начертание
   * @param italic - курсив
   */
  const addChain = async (key: string, family: string, bold: boolean, italic: boolean): Promise<void> => {
    if (chains[key] !== undefined) {
      return;
    }

    // `resolveLastResort` замыкает подстановку: он отвечает для любого
    // семейства, тогда как `resolve` — только для известных. Без него
    // документ с незнакомой гарнитурой остался бы вовсе без шрифта
    const loader = provider.resolve(family, bold, italic) ?? provider.resolveLastResort?.(family, bold, italic);
    const base = await register(key, loader);

    chains[key] = base === null ? [...scriptIds] : [base.render, ...scriptIds];
    layoutChains[key] = base === null ? [...scriptLayoutIds] : [base.layout, ...scriptLayoutIds];
  };

  for (const [family, bold, italic] of EXTRA_FAMILIES) {
    await addChain(`${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`, family, bold, italic);
  }

  for (const requirement of requirements) {
    await addChain(requirement.key, requirement.family, requirement.bold, requirement.italic);
  }

  /** Разобранные таблицы: разбор стоит времени, а шрифт спрашивают многократно. */
  const parsed = new Map<number, SfntFont>();

  return {
    files,
    chains,
    layoutChains,

    sfntOf(id: number): SfntFont | null {
      const cached = parsed.get(id);

      if (cached !== undefined) {
        return cached;
      }

      const file = files.get(id);

      if (file === undefined) {
        return null;
      }

      // Файл, который не разобрался, для раскладки бесполезен: глифов из него
      // не получить. В кэш он не попадает — повторная попытка стоит дешевле,
      // чем запись «здесь ничего нет» с риском ошибиться
      const sfnt = parseSfnt(file.bytes);

      if (sfnt !== null) {
        parsed.set(id, sfnt);
      }

      return sfnt;
    },

    async ensureFamily(family: string, bold: boolean, italic: boolean): Promise<number | null> {
      // Ключ тот же, что у требований движка: одно семейство не должно
      // оказаться в реестре дважды под разными именами
      const key = `${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`;

      await addChain(key, family, bold, italic);

      return chains[key]?.[0] ?? null;
    },
  };
}
