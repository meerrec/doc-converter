/**
 * Цвет display list → операторы PDF.
 *
 * Движок книг отдаёт цвет строкой: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`,
 * `rgba(...)` или `transparent`. Документы Word присылают `#rrggbb`. Разбор
 * здесь один на оба пути: раньше он жил прямо в экспортёре, но с появлением
 * книг форм стало больше, а поведение обязано остаться прежним — неизвестный
 * цвет по-прежнему чёрный, а не отказ сборки.
 *
 * Все комментарии на русском языке.
 */

/** Разобранный цвет: каналы для PDF и прозрачность отдельно. */
export interface ParsedColor {
  /** Три компоненты через пробел, каждая от 0 до 1. */
  readonly channels: string;
  /** Непрозрачность: `1` — плотный цвет. */
  readonly alpha: number;
}

/** Цвет по умолчанию: неразобранное значение рисуется чёрным. */
const BLACK: ParsedColor = { channels: '0 0 0', alpha: 1 };

/**
 * Разбирает цвет display list.
 *
 * @param value - строка цвета
 * @returns каналы и прозрачность; чёрный, если строка не разобрана
 */
export function parseColor(value: string): ParsedColor {
  const text = value.trim().toLowerCase();

  if (text === 'transparent') {
    return { channels: '0 0 0', alpha: 0 };
  }

  if (text.startsWith('#')) {
    return parseHex(text.slice(1));
  }

  if (text.startsWith('rgb')) {
    return parseFunctional(text);
  }

  return BLACK;
}

/**
 * Разбирает шестнадцатеричную запись.
 *
 * @param value - цифры цвета без решётки
 * @returns каналы и прозрачность
 */
function parseHex(value: string): ParsedColor {
  if (!/^[0-9a-f]+$/.test(value)) {
    return BLACK;
  }

  // Короткая запись (#rgb, #rgba) разворачивается удвоением каждой цифры
  const full =
    value.length === 3 || value.length === 4
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;

  if (full.length !== 6 && full.length !== 8) {
    return BLACK;
  }

  const alpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;

  return { channels: hexChannels(full), alpha };
}

/**
 * Разбирает запись `rgb(r, g, b)` и `rgba(r, g, b, a)`.
 *
 * @param value - строка вида `rgba(0, 0, 0, 0.5)`
 * @returns каналы и прозрачность
 */
function parseFunctional(value: string): ParsedColor {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');

  if (open < 0 || close < open) {
    return BLACK;
  }

  const parts = value
    .slice(open + 1, close)
    .split(/[\s,/]+/)
    .filter((part) => part !== '');

  if (parts.length < 3) {
    return BLACK;
  }

  const channels = parts.slice(0, 3).map(component);
  const alpha = parts.length > 3 ? Number(parts[3]) : 1;

  if (channels.some((channel) => channel === null) || !Number.isFinite(alpha)) {
    return BLACK;
  }

  return {
    channels: channels.map((channel) => (channel ?? 0).toFixed(3)).join(' '),
    alpha: Math.min(1, Math.max(0, alpha)),
  };
}

/**
 * Переводит компоненту цвета в долю единицы.
 *
 * @param part - значение компоненты
 * @returns доля или `null`, если значение не разобрано
 */
function component(part: string): number | null {
  if (part.endsWith('%')) {
    const percent = Number(part.slice(0, -1));

    return Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : null;
  }

  const value = Number(part);

  return Number.isFinite(value) ? Math.min(1, Math.max(0, value / 255)) : null;
}

/**
 * Переводит шесть цифр цвета в компоненты PDF.
 *
 * @param full - шесть цифр без решётки
 * @returns три компоненты через пробел
 */
function hexChannels(full: string): string {
  const part = (from: number): string => (parseInt(full.slice(from, from + 2), 16) / 255).toFixed(3);

  return `${part(0)} ${part(2)} ${part(4)}`;
}
