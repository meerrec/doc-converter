/**
 * То, что LibreOffice читает из книги, а движок не отдаёт.
 *
 * Серверный путь задаёт только масштаб (`ScaleToPagesX/Y = 1` при
 * `fitToOnePage`), а бумагу, поля, ориентацию, разрывы и печать сетки
 * LibreOffice берёт из самого XLSX. `exportStructured` этих сведений
 * не возвращает вовсе, `printDisplayList` их не принимает. Значит,
 * чтобы браузерный PDF совпадал с серверным, их нужно прочитать самим —
 * ровно это и делает модуль.
 *
 * Разбор — по атрибутам тегов, без XML-парсера: нужны четыре-пять значений
 * на лист, а полноценный парсер стоил бы десятки килобайт в бандле страницы.
 * Всё, что не нашлось, остаётся `null`, и вызывающий подставляет умолчания
 * Excel — они же умолчания LibreOffice для книги без настроек печати.
 *
 * Все комментарии на русском языке.
 */

import { EXCEL_DEFAULT_FONT_SIZE_PT } from '../../constants.js';

/** Шрифт «Normal»: им набраны ячейки, если в ячейке не сказано иного. */
export interface BookDefaults {
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** Поля листа в пунктах. */
export interface PageMargins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Размер бумаги в пунктах. */
export interface PaperSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** Настройки печати листа, как их понимает LibreOffice. */
export interface SheetSetup {
  readonly margins: PageMargins;
  readonly paper: PaperSize;
  /** Масштаб из книги: `1` — 100 %. */
  readonly scale: number;
  /** Просят ли уместить лист по страницам (`pageSetUpPr@fitToPage`). */
  readonly fitToPage: boolean;
  /** Сколько страниц по ширине просит книга (`0` — не ограничивать). */
  readonly fitToWidth: number;
  readonly fitToHeight: number;
  /** Печатать ли сетку (`printOptions@gridLines`). */
  readonly gridLines: boolean;
  /** Ручные разрывы страниц: индексы строк и столбцов с нуля. */
  readonly rowBreaks: readonly number[];
  readonly colBreaks: readonly number[];
  /** Область печати в адресах A1 или `null`. */
  readonly printArea: string | null;
  /** Высота строки по умолчанию из `sheetFormatPr`, если задана. */
  readonly defaultRowHeightPt: number | null;
}

/** Умолчания Excel: ими набрана книга без стилей и настроек печати. */
const DEFAULT_FONT = { family: 'Calibri', sizePt: EXCEL_DEFAULT_FONT_SIZE_PT };
const DEFAULT_MARGINS: PageMargins = { left: 50.4, right: 50.4, top: 54, bottom: 54 };

/** Пунктов в миллиметре: размеры бумаги заданы в миллиметрах. */
const PT_PER_MM = 72 / 25.4;

/** Пунктов в дюйме: поля в OOXML заданы в дюймах. */
const PT_PER_INCH = 72;

/**
 * Размеры бумаги по коду OOXML.
 *
 * Таблица неполная намеренно: коды, которых здесь нет, всё равно должны
 * дать страницу, а не отказ, — для них берётся A4, как и для книги
 * без `pageSetup`.
 */
const PAPER_SIZES: Readonly<Record<number, readonly [number, number]>> = {
  1: [215.9, 279.4], // Letter
  3: [279.4, 431.8], // Tabloid
  5: [215.9, 355.6], // Legal
  8: [297, 420], // A3
  9: [210, 297], // A4
  11: [148, 210], // A5
  12: [257, 364], // B4 (JIS)
  13: [182, 257], // B5 (JIS)
};

/** Бумага по умолчанию — A4: её же подставляет LibreOffice. */
const A4: PaperSize = { widthPt: 210 * PT_PER_MM, heightPt: 297 * PT_PER_MM };

/**
 * Читает шрифт «Normal» книги.
 *
 * @param files - части пакета XLSX
 * @returns семейство, кегль и начертание
 */
export function readBookDefaults(files: ReadonlyMap<string, Uint8Array>): BookDefaults {
  const xml = readXml(files, 'xl/styles.xml');
  const font = xml === null ? null : firstMatch(xml, /<font>([\s\S]*?)<\/font>/);

  if (font === null) {
    return { fontFamily: DEFAULT_FONT.family, fontSizePt: DEFAULT_FONT.sizePt, bold: false, italic: false };
  }

  const family = attributeOf(firstMatch(font, /<name\b[^>]*\/?>/) ?? '', 'val');

  return {
    fontFamily: family ?? DEFAULT_FONT.family,
    fontSizePt: numberAttribute(firstMatch(font, /<sz\b[^>]*\/?>/) ?? '', 'val') ?? DEFAULT_FONT.sizePt,
    bold: hasFlag(font, 'b'),
    italic: hasFlag(font, 'i'),
  };
}

/**
 * Читает настройки печати листа.
 *
 * @param xml - разметка листа (`xl/worksheets/sheetN.xml`)
 * @param printArea - область печати из `definedNames`, если она есть
 * @returns настройки листа с умолчаниями Excel
 */
export function readSheetSetup(xml: string, printArea: string | null): SheetSetup {
  const margins = readMargins(xml);
  const setup = firstMatch(xml, /<pageSetup\b[^>]*\/?>/) ?? '';
  const sheetPr = firstMatch(xml, /<pageSetUpPr\b[^>]*\/?>/) ?? '';
  const printOptions = firstMatch(xml, /<printOptions\b[^>]*\/?>/) ?? '';
  const format = firstMatch(xml, /<sheetFormatPr\b[^>]*\/?>/) ?? '';
  const paper = readPaper(setup);

  return {
    margins,
    paper,
    scale: normalizeScale(numberAttribute(setup, 'scale')),
    fitToPage: attributeOf(sheetPr, 'fitToPage') === '1' || attributeOf(sheetPr, 'fitToPage') === 'true',
    fitToWidth: numberAttribute(setup, 'fitToWidth') ?? 1,
    fitToHeight: numberAttribute(setup, 'fitToHeight') ?? 1,
    gridLines: attributeOf(printOptions, 'gridLines') === '1',
    rowBreaks: readBreaks(xml, 'rowBreaks'),
    colBreaks: readBreaks(xml, 'colBreaks'),
    printArea,
    defaultRowHeightPt: numberAttribute(format, 'defaultRowHeight'),
  };
}

/**
 * Читает область печати листа из `xl/workbook.xml`.
 *
 * Область задаётся определённым именем `_xlnm.Print_Area` со ссылкой
 * на лист: `'Лист1'!$A$1:$C$10`. Возвращается сама ссылка на диапазон.
 *
 * @param workbook - разметка книги
 * @param sheetName - имя листа, как оно записано в книге
 * @returns адрес диапазона или `null`
 */
export function readPrintArea(workbook: string, sheetName: string): string | null {
  for (const match of workbook.matchAll(/<definedName\b[^>]*>([\s\S]*?)<\/definedName>/g)) {
    const tag = match[0];
    const body = match[1] ?? '';

    if (attributeOf(tag, 'name') !== '_xlnm.Print_Area') {
      continue;
    }

    const quoted = `'${sheetName.replace(/'/g, "''")}'!`;

    if (!body.startsWith(quoted)) {
      continue;
    }

    // В ссылке бывает несколько диапазонов через запятую — берём первый:
    // остальные встречаются редко, а страницу описывает именно он
    const range = body.slice(quoted.length).split(',')[0]?.replace(/\$/g, '').trim();

    if (range !== undefined && /^[A-Z]+\d+(:[A-Z]+\d+)?$/.test(range)) {
      return range;
    }
  }

  return null;
}

/** Лист книги: имя для ссылок и часть пакета с его разметкой. */
export interface SheetPart {
  readonly name: string;
  readonly path: string;
}

/**
 * Сопоставляет листы книги их частям пакета.
 *
 * Порядок тот же, что у `exportStructured`: он перечисляет листы в порядке
 * книги, и по этому же порядку выбираются настройки печати.
 *
 * @param workbook - разметка `xl/workbook.xml`
 * @param rels - разметка `xl/_rels/workbook.xml.rels`
 * @returns листы в порядке книги
 */
export function readSheetParts(workbook: string, rels: string): readonly SheetPart[] {
  const parts: SheetPart[] = [];

  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = match[0];
    const name = attributeOf(tag, 'name');
    const id = attributeOf(tag, 'r:id');

    if (name === null || id === null) {
      continue;
    }

    const target = relationshipTarget(rels, id);

    if (target !== null) {
      parts.push({ name, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` });
    }
  }

  return parts;
}

/**
 * Ищет цель связи по её идентификатору.
 *
 * @param rels - разметка отношений
 * @param id - идентификатор связи
 * @returns путь части или `null`
 */
function relationshipTarget(rels: string, id: string): string | null {
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    if (attributeOf(match[0], 'Id') === id) {
      return attributeOf(match[0], 'Target');
    }
  }

  return null;
}

/**
 * Читает части пакета в строки.
 *
 * @param files - части пакета
 * @param path - имя части
 * @returns разметка или `null`, если части нет
 */
function readXml(files: ReadonlyMap<string, Uint8Array>, path: string): string | null {
  const bytes = files.get(path);

  return bytes === undefined ? null : new TextDecoder().decode(bytes);
}

/**
 * Читает поля страницы из `pageMargins`.
 *
 * @param xml - разметка листа
 * @returns поля в пунктах
 */
function readMargins(xml: string): PageMargins {
  const tag = firstMatch(xml, /<pageMargins\b[^>]*\/?>/) ?? '';

  return {
    left: inchesToPt(numberAttribute(tag, 'left')) ?? DEFAULT_MARGINS.left,
    right: inchesToPt(numberAttribute(tag, 'right')) ?? DEFAULT_MARGINS.right,
    top: inchesToPt(numberAttribute(tag, 'top')) ?? DEFAULT_MARGINS.top,
    bottom: inchesToPt(numberAttribute(tag, 'bottom')) ?? DEFAULT_MARGINS.bottom,
  };
}

/**
 * Определяет размер бумаги по коду `pageSetup@paperSize`.
 *
 * @param setup - тег `pageSetup`
 * @returns размер с учётом ориентации
 */
function readPaper(setup: string): PaperSize {
  const code = numberAttribute(setup, 'paperSize');
  const size = code === null ? undefined : PAPER_SIZES[code];
  const base =
    size === undefined ? A4 : { widthPt: size[0] * PT_PER_MM, heightPt: size[1] * PT_PER_MM };

  return attributeOf(setup, 'orientation') === 'landscape'
    ? { widthPt: base.heightPt, heightPt: base.widthPt }
    : base;
}

/**
 * Читает ручные разрывы страниц.
 *
 * @param xml - разметка листа
 * @param tag - `rowBreaks` или `colBreaks`
 * @returns индексы разрывов с нуля
 */
function readBreaks(xml: string, tag: string): readonly number[] {
  const block = firstMatch(xml, new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));

  if (block === null) {
    return [];
  }

  const breaks: number[] = [];

  for (const match of block.matchAll(/<brk\b[^>]*\/?>/g)) {
    // Разрыв с `man="0"` автоматический: Excel вставляет такие для печати
    // по размеру бумаги, и учитывать их значило бы дублировать пагинацию
    if (attributeOf(match[0], 'man') === '0') {
      continue;
    }

    const id = numberAttribute(match[0], 'id');

    if (id !== null && id > 0) {
      breaks.push(id);
    }
  }

  return breaks.sort((left, right) => left - right);
}

/**
 * Ищет первое совпадение с образцом.
 *
 * @param text - где искать
 * @param pattern - образец
 * @returns первая группа совпадения или `null`
 */
function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);

  return match === null ? null : (match[1] ?? match[0]);
}

/**
 * Достаёт значение атрибута из тега.
 *
 * @param tag - разметка тега
 * @param name - имя атрибута
 * @returns значение или `null`
 */
function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);

  return match === null ? null : (match[1] ?? null);
}

/**
 * Достаёт числовое значение атрибута.
 *
 * @param tag - разметка тега
 * @param name - имя атрибута
 * @returns число или `null`
 */
function numberAttribute(tag: string, name: string): number | null {
  const value = attributeOf(tag, name);
  const parsed = value === null ? Number.NaN : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Проверяет, включён ли флаг начертания (`<b/>`, `<i/>`).
 *
 * @param font - разметка шрифта
 * @param name - имя тега
 * @returns true для включённого флага
 */
function hasFlag(font: string, name: string): boolean {
  const tag = firstMatch(font, new RegExp(`<${name}\\b[^>]*/?>`));

  return tag !== null && attributeOf(tag, 'val') !== '0' && attributeOf(tag, 'val') !== 'false';
}

/**
 * Переводит дюймы в пункты.
 *
 * @param value - значение в дюймах
 * @returns пункты или `null`
 */
function inchesToPt(value: number | null): number | null {
  return value === null ? null : value * PT_PER_INCH;
}

/**
 * Приводит масштаб из процентов к доле.
 *
 * @param value - масштаб в процентах
 * @returns доля от 0.1 до 1 и выше; `1`, если масштаб не задан
 */
function normalizeScale(value: number | null): number {
  if (value === null || value <= 0) {
    return 1;
  }

  // Масштаб меньше 10 % Excel не принимает, а нулевой означал бы пустую
  // страницу; граница защищает от битого значения в чужом файле
  return Math.max(0.1, value / 100);
}
