/**
 * Минимальный разбор sfnt: то, что нужно раскладке строки и метрикам книги.
 *
 * Движок книг отдаёт текст строкой с именем семейства и начертанием — глифов
 * в печатном display list нет (в отличие от документов Word, где раскладку
 * считает wasm движка). Значит, раскладку делаем мы, а для неё нужны три вещи
 * из файла шрифта: соответствие «символ → номер глифа» (`cmap`), ширина глифа
 * (`hmtx`) и единица измерения (`head`).
 *
 * Чего здесь намеренно нет:
 *
 * - **контуров** (`glyf`, `CFF`): их несёт в PDF субсет harfbuzz, нам они
 *   не нужны;
 * - **лигатур, кернинга и переупорядочивания** (`GSUB`/`GPOS`): полного
 *   OT-шейпинга в сборке harfbuzz нет — `hb_ot_font_set_funcs` не экспортируется,
 *   а без него `hb_shape` работает вырожденно. Поэтому раскладка идёт один
 *   к одному: символ — глиф. Для книг это почти всегда верно (числа, даты,
 *   латиница, кириллица); расхождение со сложными скриптами записано
 *   ограничением в `docs/local-engine.md`.
 *
 * Разбор «мягкий», как в `pdf/cff.ts`: всё, что не сошлось, — `null`, а решение
 * принимает вызывающий. Ошибка разбора не должна ронять конвертацию книги.
 *
 * Все комментарии на русском языке.
 */

/** `head`: единицы на em — в них выражены и метрики, и ширины глифов. */
const HEAD_UNITS_PER_EM = 18;

/** `hhea`: подъём, спуск и число записей в `hmtx`. */
const HHEA_ASCENDER = 4;
const HHEA_DESCENDER = 6;
const HHEA_METRICS_COUNT = 34;

/** `maxp`: число глифов. */
const MAXP_GLYPHS = 4;

/** Запись таблицы `cmap`: платформа, кодировка и смещение подтаблицы. */
const CMAP_ENCODING_RECORD = 8;

/** Форматы подтаблиц `cmap`, которые разбирает этот модуль. */
const CMAP_FORMAT_BMP = 4;
const CMAP_FORMAT_FULL = 12;

/** Разобранный шрифт: то, чем раскладывается строка. */
export interface SfntFont {
  /** Единиц на em: делитель для метрик и ширин. */
  readonly unitsPerEm: number;
  /** Число глифов: граница для `advance`. */
  readonly glyphCount: number;
  /** Подъём из `hhea` в единицах шрифта (положительный). */
  readonly ascent: number;
  /** Спуск из `hhea` в единицах шрифта (отрицательный). */
  readonly descent: number;
  /**
   * Номер глифа для символа; `0` — глифа в шрифте нет.
   *
   * @param codePoint - код символа
   * @returns номер глифа
   */
  glyphId(codePoint: number): number;
  /**
   * Ширина глифа в единицах шрифта.
   *
   * @param glyphId - номер глифа
   * @returns ширина; `0` для глифа вне шрифта
   */
  advance(glyphId: number): number;
}

/** Запись каталога таблиц: где лежат байты. */
interface TableEntry {
  readonly offset: number;
  readonly length: number;
}

/**
 * Разбирает шрифт и возвращает то, что нужно раскладке.
 *
 * @param bytes - байты файла шрифта (TrueType или OpenType/CFF)
 * @returns разобранный шрифт или `null`, если файл не разобрался
 */
export function parseSfnt(bytes: Uint8Array): SfntFont | null {
  const tables = readTables(bytes);

  if (tables === null) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const maxp = tables.get('maxp');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');

  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) {
    return null;
  }

  const unitsPerEm = readUint16(view, head, HEAD_UNITS_PER_EM);

  if (unitsPerEm === null || unitsPerEm === 0) {
    return null;
  }

  const ascent = readInt16(view, hhea, HHEA_ASCENDER);
  const descent = readInt16(view, hhea, HHEA_DESCENDER);
  const metricsCount = readUint16(view, hhea, HHEA_METRICS_COUNT);
  const glyphCount = maxp === undefined ? 0 : (readUint16(view, maxp, MAXP_GLYPHS) ?? 0);

  if (ascent === null || descent === null || metricsCount === null || metricsCount === 0) {
    return null;
  }

  const lookup = readCmap(view, cmap);

  if (lookup === null) {
    return null;
  }

  const lastAdvanceAt = hmtx.offset + (metricsCount - 1) * 4;

  return {
    unitsPerEm,
    glyphCount,
    ascent,
    descent,
    glyphId: lookup,
    advance(glyphId: number): number {
      if (glyphId < 0) {
        return 0;
      }

      // У глифов за последней записью `hmtx` ширина совпадает с ней —
      // так устроен формат: моноширинный «хвост» не хранится вовсе
      const at = glyphId < metricsCount ? hmtx.offset + glyphId * 4 : lastAdvanceAt;

      return readUint16(view, { offset: at, length: 2 }, 0) ?? 0;
    },
  };
}

/**
 * Читает каталог таблиц sfnt.
 *
 * @param bytes - байты файла шрифта
 * @returns таблицы по тегам или `null`, если каталог не сошёлся
 */
function readTables(bytes: Uint8Array): Map<string, TableEntry> | null {
  if (bytes.byteLength < 12) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);

  if (12 + count * 16 > bytes.byteLength) {
    return null;
  }

  const tables = new Map<string, TableEntry>();

  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);

    if (offset + length > bytes.byteLength) {
      continue;
    }

    tables.set(tag, { offset, length });
  }

  return tables;
}

/**
 * Выбирает подтаблицу `cmap` и отдаёт поиск глифа.
 *
 * Приоритет — от полной таблицы к BMP: сначала (3,10) и (0,4+), затем (3,1)
 * и (0,3). Так для шрифта с обеими подтаблицами берётся та, что покрывает
 * иероглифы за пределами BMP.
 *
 * @param view - вид на байты шрифта
 * @param cmap - таблица `cmap`
 * @returns поиск глифа по символу или `null`, если форматов 4 и 12 нет
 */
function readCmap(view: DataView, cmap: TableEntry): ((codePoint: number) => number) | null {
  const count = readUint16(view, cmap, 2);

  if (count === null) {
    return null;
  }

  let best: { readonly format: number; readonly at: number; readonly rank: number } | null = null;

  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + index * CMAP_ENCODING_RECORD;
    const platform = readUint16(view, cmap, record - cmap.offset);
    const encoding = readUint16(view, cmap, record + 2 - cmap.offset);
    const offset = readUint32(view, cmap, record + 4 - cmap.offset);

    if (platform === null || encoding === null || offset === null) {
      continue;
    }

    const sub = cmap.offset + offset;
    const format = readUint16(view, cmap, sub - cmap.offset);

    if (format !== CMAP_FORMAT_BMP && format !== CMAP_FORMAT_FULL) {
      continue;
    }

    const rank = cmapRank(platform, encoding, format);

    if (best === null || rank > best.rank) {
      best = { format, at: sub, rank };
    }
  }

  if (best === null) {
    return null;
  }

  return best.format === CMAP_FORMAT_FULL
    ? fullCmapLookup(view, best.at)
    : bmpCmapLookup(view, best.at);
}

/**
 * Вес подтаблицы при выборе: чем больше, тем предпочтительнее.
 *
 * @param platform - идентификатор платформы
 * @param encoding - идентификатор кодировки
 * @param format - формат подтаблицы
 * @returns вес
 */
function cmapRank(platform: number, encoding: number, format: number): number {
  // Полная таблица (формат 12) важнее BMP-таблицы: она покрывает всё,
  // что покрывает четвёрка, и вдобавок иероглифы за пределами BMP
  if (format === CMAP_FORMAT_FULL) {
    return platform === 3 && encoding === 10 ? 40 : 30;
  }

  if (platform === 3 && encoding === 1) {
    return 20;
  }

  return platform === 0 ? 10 : 1;
}

/**
 * Поиск глифа по подтаблице формата 4 (BMP).
 *
 * @param view - вид на байты шрифта
 * @param at - смещение подтаблицы
 * @returns поиск глифа
 */
function bmpCmapLookup(view: DataView, at: number): (codePoint: number) => number {
  const segments = (readUint16(view, { offset: at, length: 2 }, 6) ?? 0) / 2;

  // Раскладка формата 4: за заголовком идут четыре массива по `segments`
  // значений, а `idRangeOffset` считается от собственной позиции — отсюда
  // и абсолютное смещение `glyphIdAt` ниже
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;

  return (codePoint: number): number => {
    if (codePoint > 0xffff) {
      return 0;
    }

    let low = 0;
    let high = segments - 1;
    let segment = -1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const end = view.getUint16(ends + middle * 2);

      if (codePoint <= end) {
        segment = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    if (segment < 0) {
      return 0;
    }

    const start = view.getUint16(starts + segment * 2);

    if (codePoint < start) {
      return 0;
    }

    const delta = view.getInt16(deltas + segment * 2);
    const range = view.getUint16(ranges + segment * 2);

    if (range === 0) {
      return (codePoint + delta) & 0xffff;
    }

    const gidAt = ranges + segment * 2 + range + (codePoint - start) * 2;

    if (gidAt + 2 > view.byteLength) {
      return 0;
    }

    const gid = view.getUint16(gidAt);

    return gid === 0 ? 0 : (gid + delta) & 0xffff;
  };
}

/**
 * Поиск глифа по подтаблице формата 12 (полная карта).
 *
 * @param view - вид на байты шрифта
 * @param at - смещение подтаблицы
 * @returns поиск глифа
 */
function fullCmapLookup(view: DataView, at: number): (codePoint: number) => number {
  const groups = view.getUint32(at + 12);
  const first = at + 16;

  return (codePoint: number): number => {
    let low = 0;
    let high = groups - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const groupAt = first + middle * 12;
      const start = view.getUint32(groupAt);
      const end = view.getUint32(groupAt + 4);

      if (codePoint < start) {
        high = middle - 1;
        continue;
      }

      if (codePoint > end) {
        low = middle + 1;
        continue;
      }

      return view.getUint32(groupAt + 8) + (codePoint - start);
    }

    return 0;
  };
}

/**
 * Читает `uint16` по смещению внутри таблицы.
 *
 * @param view - вид на байты шрифта
 * @param table - таблица, внутри которой считается смещение
 * @param at - смещение от начала таблицы
 * @returns значение или `null`, если оно выходит за границы файла
 */
function readUint16(view: DataView, table: TableEntry, at: number): number | null {
  const offset = table.offset + at;

  return offset + 2 > view.byteLength ? null : view.getUint16(offset);
}

/**
 * Читает `int16` по смещению внутри таблицы.
 *
 * @param view - вид на байты шрифта
 * @param table - таблица, внутри которой считается смещение
 * @param at - смещение от начала таблицы
 * @returns значение или `null`, если оно выходит за границы файла
 */
function readInt16(view: DataView, table: TableEntry, at: number): number | null {
  const offset = table.offset + at;

  return offset + 2 > view.byteLength ? null : view.getInt16(offset);
}

/**
 * Читает `uint32` по смещению внутри таблицы.
 *
 * @param view - вид на байты шрифта
 * @param table - таблица, внутри которой считается смещение
 * @param at - смещение от начала таблицы
 * @returns значение или `null`, если оно выходит за границы файла
 */
function readUint32(view: DataView, table: TableEntry, at: number): number | null {
  const offset = table.offset + at;

  return offset + 4 > view.byteLength ? null : view.getUint32(offset);
}
