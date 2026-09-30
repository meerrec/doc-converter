/**
 * Разбор CFF: какой номер глифа движка соответствует какому CID.
 *
 * PDF адресует глифы **CID**, а display list движка называет их номерами
 * в шрифте (GID). У TrueType это одно и то же — потому и работает
 * `CIDToGIDMap /Identity`, — а у CID-keyed CFF связь задаёт charset,
 * и после субсеттинга она перестаёт быть тождественной: harfbuzz сохраняет
 * номера глифов (`RETAIN_GIDS`), но CID перенумеровывает. Без разбора
 * charset `<18E1> Tj` указал бы на чужой CID, и просмотрщик нарисовал бы
 * не те знаки — так и было со всеми CJK-документами.
 *
 * Модуль намеренно «мягкий»: всё, что не разобралось, — `null`, и вызывающий
 * оставляет прежнее правило (CID = GID). Ошибка разбора не должна ронять
 * экспорт документа: без карты текст поблекнет неверными знаками,
 * а с падением не соберётся вовсе.
 *
 * Все комментарии на русском языке.
 */

/** Сигнатура sfnt-контейнера с CFF: `OTTO`. */
const SFNT_OTTO = 0x4f54544f;

/** Оператор DICT: смещение charset. */
const OP_CHARSET = 15;

/** Оператор DICT: смещение CharStrings. */
const OP_CHARSTRINGS = 17;

/** Escape-оператор DICT (12 30): признак CID-keyed шрифта. */
const OP_ROS = 1200 + 30;

/** Прочитанная INDEX-структура CFF: смещения элементов в байтах. */
interface CffIndex {
  readonly count: number;
  /** Смещение сразу за INDEX. */
  readonly end: number;
  /** Границы элементов: `[начало, конец)` в байтах. */
  readonly items: readonly (readonly [number, number])[];
}

/**
 * Отдаёт карту «номер глифа → CID» для встроенного CFF-шрифта.
 *
 * @param sfnt - байты шрифта в контейнере sfnt
 * @returns CID по номеру глифа или `null`, если шрифт не CID-keyed CFF
 */
export function readGlyphToCid(sfnt: Uint8Array): Uint16Array | null {
  const cff = readCffTable(sfnt);

  if (cff === null) {
    return null;
  }

  // Смещение Name INDEX задаёт сам заголовок CFF
  const name = readIndex(cff, cff[2] ?? 0);
  const topDictIndex = name === null ? null : readIndex(cff, name.end);
  const topItem = topDictIndex?.items[0];
  const top = topItem === undefined ? null : parseDict(cff, topItem[0], topItem[1]);

  if (top === null || !top.has(OP_ROS)) {
    return null;
  }

  const charStringsOffset = top.get(OP_CHARSTRINGS)?.[0];
  const charsetOffset = top.get(OP_CHARSET)?.[0];

  if (charStringsOffset === undefined || charsetOffset === undefined) {
    return null;
  }

  const charStrings = readIndex(cff, charStringsOffset);

  if (charStrings === null) {
    return null;
  }

  return readCharset(cff, charsetOffset, charStrings.count);
}

/**
 * Достаёт таблицу `CFF ` из контейнера sfnt.
 *
 * @param sfnt - байты шрифта
 * @returns байты таблицы CFF или `null`, если её нет
 */
function readCffTable(sfnt: Uint8Array): Uint8Array | null {
  if (sfnt.byteLength < 12) {
    return null;
  }

  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);

  if (view.getUint32(0) !== SFNT_OTTO) {
    return null;
  }

  const tables = view.getUint16(4);

  for (let index = 0; index < tables; index += 1) {
    const at = 12 + index * 16;

    if (at + 16 > sfnt.byteLength) {
      return null;
    }

    const tag = String.fromCharCode(sfnt[at]!, sfnt[at + 1]!, sfnt[at + 2]!, sfnt[at + 3]!);

    if (tag !== 'CFF ') {
      continue;
    }

    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);

    if (offset + length > sfnt.byteLength) {
      return null;
    }

    return sfnt.subarray(offset, offset + length);
  }

  return null;
}

/**
 * Читает INDEX-структуру CFF.
 *
 * @param cff - байты таблицы CFF
 * @param at - смещение INDEX
 * @returns разобранная INDEX или `null`, если структура повреждена
 */
function readIndex(cff: Uint8Array, at: number): CffIndex | null {
  if (at < 0 || at + 2 > cff.byteLength) {
    return null;
  }

  const count = (cff[at]! << 8) | cff[at + 1]!;

  if (count === 0) {
    return { count, end: at + 2, items: [] };
  }

  const offSize = cff[at + 2]!;

  if (offSize < 1 || offSize > 4 || at + 3 + (count + 1) * offSize > cff.byteLength) {
    return null;
  }

  const offsets: number[] = [];

  for (let index = 0; index <= count; index += 1) {
    let value = 0;

    for (let byte = 0; byte < offSize; byte += 1) {
      value = value * 256 + cff[at + 3 + index * offSize + byte]!;
    }

    offsets.push(value);
  }

  // Смещения в CFF отсчитываются от байта перед данными и начинаются с единицы
  const dataStart = at + 3 + (count + 1) * offSize - 1;
  const items: (readonly [number, number])[] = [];

  for (let index = 0; index < count; index += 1) {
    const from = dataStart + offsets[index]!;
    const to = dataStart + offsets[index + 1]!;

    if (to > cff.byteLength || from > to) {
      return null;
    }

    items.push([from, to]);
  }

  return { count, end: dataStart + offsets[count]!, items };
}

/**
 * Разбирает DICT-структуру CFF.
 *
 * Интересуют только целые операнды: смещения и признак CID-keyed шрифта.
 * Вещественные числа (шрифтовые матрицы) пропускаются — их значения
 * экспортёру не нужны.
 *
 * @param cff - байты таблицы CFF
 * @param from - начало DICT
 * @param to - конец DICT
 * @returns оператор → операнды или `null`, если DICT повреждён
 */
function parseDict(cff: Uint8Array, from: number, to: number): Map<number, number[]> | null {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];

  for (let at = from; at < to; ) {
    const first = cff[at]!;

    if (first <= 21) {
      const operator = first === 12 ? 1200 + cff[at + 1]! : first;

      dict.set(operator, operands);
      operands = [];
      at += first === 12 ? 2 : 1;
      continue;
    }

    if (first === 28) {
      if (at + 3 > to) {
        return null;
      }

      operands.push((((cff[at + 1]! << 8) | cff[at + 2]!) << 16) >> 16);
      at += 3;
      continue;
    }

    if (first === 29) {
      if (at + 5 > to) {
        return null;
      }

      operands.push(
        ((cff[at + 1]! << 24) | (cff[at + 2]! << 16) | (cff[at + 3]! << 8) | cff[at + 4]!) | 0
      );
      at += 5;
      continue;
    }

    if (first === 30) {
      // Вещественное число в BCD: конец — ниббл 0xF в любом из двух байтов
      let end = at + 1;

      while (end < to) {
        const byte = cff[end]!;

        if ((byte >> 4) === 0xf || (byte & 0x0f) === 0xf) {
          break;
        }

        end += 1;
      }

      if (end >= to) {
        return null;
      }

      at = end + 1;
      continue;
    }

    if (first >= 32 && first <= 246) {
      operands.push(first - 139);
      at += 1;
      continue;
    }

    if (first >= 247 && first <= 250) {
      operands.push((first - 247) * 256 + cff[at + 1]! + 108);
      at += 2;
      continue;
    }

    if (first >= 251 && first <= 254) {
      operands.push(-(first - 251) * 256 - cff[at + 1]! - 108);
      at += 2;
      continue;
    }

    // Байты 22–27, 31 и 255 в DICT не определены
    return null;
  }

  return dict;
}

/**
 * Читает charset и строит карту «GID → CID».
 *
 * В CID-keyed шрифте charset перечисляет для каждого глифа его CID —
 * в порядке номеров глифов, начиная с первого после `.notdef`.
 *
 * @param cff - байты таблицы CFF
 * @param at - смещение charset
 * @param glyphs - число глифов из CharStrings
 * @returns CID по номеру глифа или `null`, если charset не разобран
 */
function readCharset(cff: Uint8Array, at: number, glyphs: number): Uint16Array | null {
  if (at < 0 || at >= cff.byteLength || glyphs < 1 || glyphs > 0xffff) {
    return null;
  }

  const format = cff[at]!;
  const cids = new Uint16Array(glyphs);

  // Нулевой глиф — `.notdef`, его CID всегда ноль
  cids[0] = 0;

  if (format === 0) {
    if (at + 1 + (glyphs - 1) * 2 > cff.byteLength) {
      return null;
    }

    for (let glyph = 1; glyph < glyphs; glyph += 1) {
      cids[glyph] = (cff[at + 1 + (glyph - 1) * 2]! << 8) | cff[at + 2 + (glyph - 1) * 2]!;
    }

    return cids;
  }

  if (format !== 1 && format !== 2) {
    return null;
  }

  let cursor = at + 1;
  let glyph = 1;

  while (glyph < glyphs) {
    // Формат 1 хранит длину диапазона одним байтом, формат 2 — двумя:
    // различие проверено на наборе Noto CJK, где оба формата и встречаются
    const size = format === 1 ? 3 : 4;

    if (cursor + size > cff.byteLength) {
      return null;
    }

    const first = (cff[cursor]! << 8) | cff[cursor + 1]!;
    const left = format === 1 ? cff[cursor + 2]! : (cff[cursor + 2]! << 8) | cff[cursor + 3]!;

    for (let step = 0; step <= left && glyph < glyphs; step += 1) {
      cids[glyph] = (first + step) & 0xffff;
      glyph += 1;
    }

    cursor += size;
  }

  return cids;
}
