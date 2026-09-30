/**
 * Определение письменности строки: какой fallback-шрифт ей нужен.
 *
 * Основная гарнитура книги (Calibri, Cambria и их совместители) закрывает
 * латиницу и кириллицу. Иероглифы, арабское письмо и иврит приходят из
 * отдельных начертаний, которые лежат в `@betteroffice/fonts(-cjk)` и грузятся
 * по требованию: CJK весит больше 20 МБ, и книга на кириллице платить за них
 * не должна.
 *
 * Различение — по диапазонам кодов, а не по языку документа: язык в XLSX
 * не обязателен, а диапазоны дают достаточную точность. Внутри CJK выбор
 * между упрощённым, традиционным, японским и корейским письмом — тоже
 * эвристика: кана и хангыль опознаются точно, а иероглифы без каны
 * считаются упрощёнными (обычный случай для книг; ошибка стоит лишь
 * другого начертания того же набора).
 *
 * Все комментарии на русском языке.
 */

import type { BundledFontScript } from '@betteroffice/fonts';

/**
 * Отдаёт скриптовый fallback, которым набирается строка.
 *
 * @param text - текст ячейки
 * @returns имя скрипта или `null`, если хватает основной гарнитуры
 */
export function scriptFallbackOf(text: string): BundledFontScript | null {
  let cjk: 'cjk-jp' | 'cjk-kr' | 'cjk-sc' | null = null;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (isArabic(code)) {
      return 'arabic';
    }

    if (isHebrew(code)) {
      return 'hebrew';
    }

    if (cjk === null) {
      if (isJapaneseKana(code)) {
        cjk = 'cjk-jp';
      } else if (isHangul(code)) {
        cjk = 'cjk-kr';
      } else if (isHan(code)) {
        cjk = 'cjk-sc';
      }
    }
  }

  return cjk;
}

/**
 * Арабское письмо.
 *
 * @param code - код символа
 * @returns true для арабских блоков
 */
function isArabic(code: number): boolean {
  return (
    (code >= 0x0600 && code <= 0x06ff) ||
    (code >= 0x0750 && code <= 0x077f) ||
    (code >= 0x08a0 && code <= 0x08ff) ||
    (code >= 0xfb50 && code <= 0xfdff) ||
    (code >= 0xfe70 && code <= 0xfeff)
  );
}

/**
 * Еврейское письмо.
 *
 * @param code - код символа
 * @returns true для еврейских блоков
 */
function isHebrew(code: number): boolean {
  return (code >= 0x0590 && code <= 0x05ff) || (code >= 0xfb1d && code <= 0xfb4f);
}

/**
 * Японские слоговые азбуки.
 *
 * @param code - код символа
 * @returns true для хираганы и катаканы
 */
function isJapaneseKana(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff);
}

/**
 * Корейское письмо.
 *
 * @param code - код символа
 * @returns true для хангыля
 */
function isHangul(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * Иероглифы и полноширинные формы.
 *
 * @param code - код символа
 * @returns true для ханьских блоков
 */
function isHan(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2fdf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}
