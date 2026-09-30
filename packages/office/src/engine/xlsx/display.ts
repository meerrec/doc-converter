/**
 * Печатный display list книги → примитивы PDF.
 *
 * Движок отдаёт страницу командами (`fillRect`, `line`, `path`, `text`),
 * наш экспортёр понимает примитивы (`rect`, `line`, `path`, `glyphRun`,
 * `decoration`). Перевод между ними — здесь, и он не механический: текст
 * приходит строкой с именем семейства, а в PDF должен уйти глифами, поэтому
 * каждая текстовая команда раскладывается шейпингом (`shape/`), а шрифт
 * для неё берётся из реестра книги.
 *
 * Типы команд описаны здесь своими, а не импортированы из движка: его
 * определения лежат во внутренних чанках сборки, а не в публичной точке
 * входа. Структурная типизация TypeScript проверяет стык сама — там, где
 * результат `printDisplayList` передаётся сюда.
 *
 * Все комментарии на русском языке.
 */

import { parseColor } from '../../pdf/color.js';
import type {
  ClipRect,
  DisplayPrimitive,
  LinePrimitive,
  PathCommand,
  PathPrimitive,
  RectPrimitive,
} from '../../pdf/types.js';
import { shapeRun } from '../../shape/shape.js';
import { scriptFallbackOf } from '../../shape/script.js';
import type { BookDefaults } from './bookXml.js';
import type { BookFonts } from './fonts.js';

/** Пункт → пиксель: кегль команды приходит в пунктах, координаты — в пикселях. */
const PT_TO_PX = 96 / 72;

/** Толщина декорации в долях кегля: как в `paintDisplayList` движка. */
const UNDERLINE_SHIFT = 0.1;
const STRIKE_SHIFT = 0.26;
const DECORATION_THICKNESS = 0.05;

/** Прямоугольник заливки — фон ячейки, полоса выделения. */
export interface FillRectCommand {
  readonly op: 'fillRect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly clip?: ClipRect;
}

/** Отрезок — граница ячейки, разделитель. */
export interface LineCommand {
  readonly op: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly color: string;
  readonly style?: 'dashed' | 'dotted' | 'double';
  readonly clip?: ClipRect;
}

/** Путь — фигуры и всё, что нарисовано кривыми. */
export interface PathShapeCommand {
  readonly op: 'path';
  readonly commands: readonly PathCommand[];
  readonly fill: string;
  readonly stroke?: { readonly color: string; readonly width: number };
  readonly clip?: ClipRect;
}

/** Текст ячейки: строка, кегль и начертание — глифов движок не даёт. */
export interface TextCommand {
  readonly op: 'text';
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly clip?: ClipRect;
  readonly align?: 'left' | 'center' | 'right';
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly highlight?: string;
  readonly dashedUnderline?: boolean;
  readonly fontFamily?: string;
}

/** Команда печатного display list. */
export type EngineCommand = FillRectCommand | LineCommand | PathShapeCommand | TextCommand;

/** Печатный display list: размеры и команды. */
export interface EngineDisplayList {
  readonly width: number;
  readonly height: number;
  readonly commands: readonly EngineCommand[];
}

/** Что нужно, чтобы перевести команды в примитивы. */
export interface FrameContext {
  readonly fonts: BookFonts;
  readonly defaults: BookDefaults;
}

/**
 * Переводит display list страницы в примитивы PDF.
 *
 * @param displayList - печатный display list диапазона
 * @param context - шрифты книги и её умолчания
 * @returns примитивы в порядке отрисовки
 */
export async function toPrimitives(
  displayList: EngineDisplayList,
  context: FrameContext
): Promise<readonly DisplayPrimitive[]> {
  const primitives: DisplayPrimitive[] = [];

  for (const command of displayList.commands) {
    switch (command.op) {
      case 'fillRect':
        primitives.push(rectPrimitive(command));
        break;
      case 'line':
        primitives.push(...linePrimitives(command));
        break;
      case 'path':
        primitives.push(pathPrimitive(command));
        break;
      case 'text':
        primitives.push(...(await textPrimitives(command, context)));
        break;
    }
  }

  return primitives;
}

/**
 * Переводит заливку прямоугольника.
 *
 * @param command - команда заливки
 * @returns прямоугольник
 */
function rectPrimitive(command: FillRectCommand): RectPrimitive {
  const color = parseColor(command.color);

  return {
    kind: 'rect',
    x: command.x,
    y: command.y,
    w: command.w,
    h: command.h,
    fill: command.color,
    clip: command.clip,
    alpha: color.alpha,
  };
}

/**
 * Переводит отрезок, разворачивая двойную линию в две.
 *
 * @param command - команда отрезка
 * @returns один или два отрезка
 */
function linePrimitives(command: LineCommand): readonly LinePrimitive[] {
  const color = parseColor(command.color);
  const base: LinePrimitive = {
    kind: 'line',
    x1: command.x1,
    y1: command.y1,
    x2: command.x2,
    y2: command.y2,
    strokeWidth: command.width,
    color: command.color,
    clip: command.clip,
    alpha: color.alpha,
  };

  if (command.style === 'dashed') {
    return [{ ...base, dash: [4, 2] }];
  }

  if (command.style === 'dotted') {
    return [{ ...base, dash: [1, 2] }];
  }

  if (command.style !== 'double') {
    return [base];
  }

  // Двойная граница в canvas — две тонкие линии по обе стороны от исходной
  // (см. `paintDisplayList`): одиночная с той же толщиной выглядела бы жирнее
  const offset = Math.max(command.width * 0.8, 0.8);
  const thickness = Math.max(command.width * 0.6, 0.5);
  const horizontal = Math.abs(command.y1 - command.y2) <= Math.abs(command.x1 - command.x2);
  const [dx, dy] = horizontal ? [0, offset] : [offset, 0];

  return [
    { ...base, strokeWidth: thickness, x1: command.x1 - dx, y1: command.y1 - dy, x2: command.x2 - dx, y2: command.y2 - dy },
    { ...base, strokeWidth: thickness, x1: command.x1 + dx, y1: command.y1 + dy, x2: command.x2 + dx, y2: command.y2 + dy },
  ];
}

/**
 * Переводит путь.
 *
 * @param command - команда пути
 * @returns путь
 */
function pathPrimitive(command: PathShapeCommand): PathPrimitive {
  const fill = command.fill === '' ? undefined : command.fill;
  const stroke = command.stroke === undefined ? undefined : { color: command.stroke.color, width: command.stroke.width };
  const alpha = parseColor(fill ?? stroke?.color ?? '#000000').alpha;

  return {
    kind: 'path',
    commands: command.commands,
    fill,
    stroke,
    clip: command.clip,
    alpha,
  };
}

/**
 * Раскладывает текстовую команду: глифы, выделение и подчёркивание.
 *
 * Строка набирается основным семейством; если в нём нет части символов,
 * запрашивается начертание нужной письменности — CJK, арабское, еврейское.
 * Символы, которых не нашлось и там, пропускаются: как и в документах Word,
 * выдумывать для них форму нечем.
 *
 * @param command - команда текста
 * @param context - шрифты книги и её умолчания
 * @returns примитивы текста в порядке отрисовки
 */
async function textPrimitives(
  command: TextCommand,
  context: FrameContext
): Promise<readonly DisplayPrimitive[]> {
  const bold = command.bold === true;
  const italic = command.italic === true;
  const sizePx = command.fontSize * PT_TO_PX;
  const family = command.fontFamily ?? context.defaults.fontFamily;

  let font = await context.fonts.family(family, bold, italic);
  let run = font === null ? null : shapeRun(font.sfnt, command.text, sizePx);

  if (run === null || run.missing > 0) {
    const script = scriptFallbackOf(command.text);
    const fallback = script === null ? null : await context.fonts.script(script, bold, italic);
    const alternative = fallback === null ? null : shapeRun(fallback.sfnt, command.text, sizePx);

    // Основной шрифт остаётся, если подстановка потеряла больше символов
    if (alternative !== null && (run === null || alternative.missing < run.missing)) {
      font = fallback;
      run = alternative;
    }
  }

  if (font === null || run === null || run.glyphs.length === 0) {
    return [];
  }

  const penX = alignPen(command, run.width);
  const glyphs = run.glyphs.map((glyph) => ({ ...glyph, x: penX + glyph.x, y: command.y }));
  const primitives: DisplayPrimitive[] = [];
  const ascent = (font.sfnt.ascent * sizePx) / font.sfnt.unitsPerEm;
  const descent = (Math.abs(font.sfnt.descent) * sizePx) / font.sfnt.unitsPerEm;

  if (command.highlight !== undefined && command.highlight !== '') {
    primitives.push({
      kind: 'rect',
      // Выделение шире текста на пару пикселей — так его рисует движок
      x: penX - 2,
      y: command.y - ascent - 1,
      w: run.width + 4,
      h: ascent + descent + 2,
      fill: command.highlight,
      clip: command.clip,
    });
  }

  primitives.push({
    kind: 'glyphRun',
    fontId: font.id,
    size: sizePx,
    color: command.color,
    text: command.text,
    glyphs,
    clip: command.clip,
  });

  const thickness = Math.max(sizePx * DECORATION_THICKNESS, 0.5);

  if (command.underline === true || command.dashedUnderline === true) {
    primitives.push({
      kind: 'decoration',
      deco: 'underline',
      x: penX,
      y: command.y + sizePx * UNDERLINE_SHIFT,
      w: run.width,
      h: thickness,
      color: command.color,
      dashed: command.dashedUnderline === true,
      clip: command.clip,
    });
  }

  if (command.strike === true) {
    primitives.push({
      kind: 'decoration',
      deco: 'strike',
      x: penX,
      y: command.y - sizePx * STRIKE_SHIFT,
      w: run.width,
      h: thickness,
      color: command.color,
      clip: command.clip,
    });
  }

  return primitives;
}

/**
 * Считает начало строки по выравниванию.
 *
 * Координата команды означает разное при разном выравнивании — так же её
 * понимает `paintDisplayList`: слева это начало текста, справа — его конец,
 * по центру — середина.
 *
 * @param command - команда текста
 * @param width - ширина разложенной строки
 * @returns координата начала строки
 */
function alignPen(command: TextCommand, width: number): number {
  if (command.align === 'right') {
    return command.x - width;
  }

  if (command.align === 'center') {
    return command.x - width / 2;
  }

  return command.x;
}
