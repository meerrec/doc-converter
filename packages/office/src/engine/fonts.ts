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
}

/** Отдаёт байты шрифта по требованию; `undefined` — такого шрифта нет. */
export type FontLoader = () => Promise<ArrayBuffer>;

/** Откуда берутся шрифты: обёртка над `@betteroffice/fonts`. */
export interface FontProvider {
  resolve(family: string, bold: boolean, italic: boolean): FontLoader | undefined;
  resolveScriptFallback?(script: string, bold: boolean, italic: boolean): FontLoader | undefined;
  resolveLastResort?(family: string, bold: boolean, italic: boolean): FontLoader | undefined;
}

/** Движок в той части, которая нужна регистрации. */
export interface FontEngine {
  registerFont(bytes: Uint8Array): number;
}

/** Что получилось: байты по номерам и цепочки по ключам требований. */
export interface FontRegistry {
  /** Номер шрифта в движке → имя и байты. */
  readonly files: Map<number, FontResource>;
  /** Ключ требования → номера шрифтов в порядке подстановки. */
  readonly chains: Record<string, number[]>;
}

/**
 * Регистрирует шрифты и строит цепочки.
 *
 * @param engine - текстовый движок
 * @param provider - источник байтов
 * @param requirements - что запросил движок по этому документу
 * @returns реестр шрифтов
 */
export async function registerFonts(
  engine: FontEngine,
  provider: FontProvider,
  requirements: readonly FontRequirement[]
): Promise<FontRegistry> {
  const files = new Map<number, FontResource>();

  /** Загружает байты и отдаёт номер; `null` — шрифта нет. */
  const register = async (name: string, loader: FontLoader | undefined): Promise<number | null> => {
    if (loader === undefined) {
      return null;
    }

    const data = new Uint8Array(await loader());
    const id = engine.registerFont(data);

    files.set(id, { name, bytes: data });

    return id;
  };

  // Скриптовые fallback'и общие для всех цепочек: они добирают то,
  // чего нет в основной гарнитуре, и стоят в конце каждой цепочки
  const scriptIds: number[] = [];

  for (const script of SCRIPT_FALLBACKS) {
    const id = await register(`script:${script}`, provider.resolveScriptFallback?.(script, false, false));

    if (id !== null) {
      scriptIds.push(id);
    }
  }

  const chains: Record<string, number[]> = {};

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

    chains[key] = base === null ? [...scriptIds] : [base, ...scriptIds];
  };

  for (const [family, bold, italic] of EXTRA_FAMILIES) {
    await addChain(`${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`, family, bold, italic);
  }

  for (const requirement of requirements) {
    await addChain(requirement.key, requirement.family, requirement.bold, requirement.italic);
  }

  return { files, chains };
}
