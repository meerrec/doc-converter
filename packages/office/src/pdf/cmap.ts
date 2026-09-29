/**
 * Таблица `ToUnicode`: каким символам соответствуют глифы страницы.
 *
 * Шрифт в PDF встраивается как CID-шрифт с кодировкой `Identity-H`: в потоке
 * страницы стоят не коды символов, а номера глифов. Просмотрщик по ним ничего
 * не прочитает — копирование, поиск и доступность работают только благодаря
 * этой таблице. Для PDF/A она обязательна.
 *
 * Все комментарии на русском языке.
 */

import { latin1, utf16Be } from './builder.js';

/**
 * Сколько записей помещается в один блок `beginbfchar`.
 *
 * 100 — потолок, заданный форматом CMap: блок объявляет своё число записей
 * заранее, и просмотрщик читает ровно столько. Больше — синтаксическая
 * ошибка, из-за которой таблица не прочитается целиком.
 */
const BFCHAR_BLOCK = 100;

/**
 * Собирает поток CMap.
 *
 * @param mapping - номер глифа → символ (или несколько: лигатура)
 * @returns несжатые байты потока
 */
export function toUnicodeCMap(mapping: ReadonlyMap<number, string>): Uint8Array {
  // Нулевой глиф — `.notdef`, а не символ: попав в таблицу, он приписал бы
  // отсутствующему знаку чужое значение
  const entries = [...mapping.entries()].filter(([glyph]) => glyph > 0);

  const parts = [
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n',
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n',
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n',
  ];

  for (let index = 0; index < entries.length; index += BFCHAR_BLOCK) {
    const block = entries.slice(index, index + BFCHAR_BLOCK);

    parts.push(`${block.length} beginbfchar\n`);

    for (const [glyph, text] of block) {
      parts.push(`<${glyph.toString(16).padStart(4, '0').toUpperCase()}> <${utf16Be(text)}>\n`);
    }

    parts.push('endbfchar\n');
  }

  parts.push('endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n');

  return latin1(parts.join(''));
}
