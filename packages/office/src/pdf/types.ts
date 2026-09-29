/**
 * То, что экспортёр PDF берёт из display list движка.
 *
 * Свои типы, а не импортированные из `@betteroffice/docx`: движку 0.3.0,
 * он активно развивается, и его типы примитивов лежат во внутренних чанках
 * сборки, а не в публичной точке входа. Описывая здесь только потребляемое,
 * мы получаем две вещи: смену версии движка видно по одному файлу, и она же
 * ловится типами на стыке — там, где результат `buildRustDisplayList`
 * передаётся в `buildPdf`. Структурная типизация TypeScript такую проверку
 * делает сама, без ручных гардов.
 *
 * Координаты — пиксели CSS (96 dpi), начало в левом верхнем углу страницы,
 * ось Y вниз. В PDF система другая, и пересчёт делает экспортёр.
 *
 * Все комментарии на русском языке.
 */

/** Глиф на своём месте: номер в шрифте, позиция и смещение кластера. */
export interface PositionedGlyph {
  /** Номер глифа в исходном шрифте: на него же ссылается `CIDToGIDMap`. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /**
   * Смещение символа в `text` — **в байтах UTF-8**, а не в знаках.
   *
   * У кириллицы кластеры идут 0, 2, 4…, у иероглифов 0, 3, 6… — считать
   * их индексами строки значит разрезать символ посередине и получить
   * в `ToUnicode` мусор вместо текста.
   */
  readonly cluster: number;
  /** Ширина глифа в пикселях: из неё считается `/W` в PDF. */
  readonly advance?: number;
}

/** Прогон текста, уже разложенный движком на глифы. */
export interface GlyphRunPrimitive {
  readonly kind: 'glyphRun';
  readonly fontId: number;
  readonly size: number;
  readonly color: string;
  readonly text: string;
  readonly glyphs: readonly PositionedGlyph[];
}

/** Прямоугольник: заливка фона, граница таблицы, плашка. */
export interface RectPrimitive {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/** Отрезок: граница, разделитель, подчёркивание таблицы. */
export interface LinePrimitive {
  readonly kind: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly strokeWidth: number;
  readonly color: string;
  readonly dash?: readonly number[];
}

/** Картинка: байты лежат в `relId` как `data:`-ссылка. */
export interface ImagePrimitive {
  readonly kind: 'image';
  readonly relId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Декорация текста: подчёркивание, зачёркивание, выделение. */
export interface DecorationPrimitive {
  readonly kind: 'decoration';
  readonly deco: 'underline' | 'strike' | 'highlight' | 'comment-range' | 'spell';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly dashed?: boolean;
  readonly dotted?: boolean;
}

/**
 * Прогон текста, который движок не разложил на глифы.
 *
 * Так приходят, например, номера пунктов списка: движок отдаёт строку,
 * позицию и CSS-шорткат шрифта (`700 13.333px Microsoft JhengHei, sans-serif`),
 * ожидая, что рисовать будет хост. Экспортёр PDF их пока пропускает —
 * см. `KNOWN_GAPS` в `export.ts`.
 */
export interface TextRunPrimitive {
  readonly kind: 'text';
  readonly text: string;
  readonly x: number;
  readonly baselineY: number;
  readonly font: string;
  readonly color: string;
}

/** Примитивы, которые экспортёр умеет рисовать. */
export type PaintablePrimitive =
  | GlyphRunPrimitive
  | RectPrimitive
  | LinePrimitive
  | ImagePrimitive
  | DecorationPrimitive;

/** Всё, что встречается в display list, включая пока не поддержанное. */
export type DisplayPrimitive = PaintablePrimitive | TextRunPrimitive | { readonly kind: string };

/** Колонтитул: своя система координат внутри полосы страницы. */
export interface HeaderFooterRegion {
  readonly y: number;
  readonly height: number;
  readonly primitives: readonly DisplayPrimitive[];
}

/** Страница display list. */
export interface DisplayPage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly primitives: readonly DisplayPrimitive[];
  /** Заливка страницы; отсутствует — фон белый. */
  readonly background?: string;
  readonly header?: HeaderFooterRegion;
  readonly footer?: HeaderFooterRegion;
}

/** Display list целиком. */
export interface DisplayList {
  readonly pages: readonly DisplayPage[];
}

/** Шрифт, зарегистрированный в движке: под каким именем и с какими байтами. */
export interface FontResource {
  /** Имя семейства — попадает в `/BaseFont` как подсказка просмотрщику. */
  readonly name: string;
  readonly bytes: Uint8Array;
}
