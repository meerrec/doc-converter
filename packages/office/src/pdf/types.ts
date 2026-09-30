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
 * **Имена полей — движка, а не свои.** Здесь стояло `alpha` там, где движок
 * шлёт `opacity`: поле необязательное, поэтому расхождение не ловилось типами,
 * а прозрачность документов Word не доезжала до PDF вовсе — водяные знаки
 * и полупрозрачные заливки выходили плотными. Описывая движок, называйте его
 * словами: единственная защита здесь — структурная типизация на стыке.
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

/**
 * Прямоугольник обрезки: за его пределами примитив не рисуется.
 *
 * Так приходит текст книги: ячейка обрезает содержимое, если оно шире
 * колонки. В PDF это оператор `W n`, а не «обрезать координаты» —
 * знаки за границей просто не выводятся.
 */
export interface ClipRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Прогон текста, уже разложенный на глифы — движком (Word) или нами (книга). */
export interface GlyphRunPrimitive {
  readonly kind: 'glyphRun';
  readonly fontId: number;
  readonly size: number;
  readonly color: string;
  readonly text: string;
  readonly glyphs: readonly PositionedGlyph[];
  /** Обрезка по ячейке; у документа Word её нет. */
  readonly clip?: ClipRect;
  /** Прозрачность: `1` — непрозрачный, поле отсутствует. */
  readonly opacity?: number;
  /**
   * Поворот в градусах по часовой стрелке вокруг центра прямоугольника
   * прогона (`pdf/geometry.ts`). Отсутствует — поворота нет.
   */
  readonly rotationDeg?: number;
  /** Горизонтальный масштаб в процентах: `100` — обычный, отсутствует — он же. */
  readonly horizontalScale?: number;
}

/** Прямоугольник: заливка фона, граница таблицы, плашка. */
export interface RectPrimitive {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
  readonly clip?: ClipRect;
  readonly opacity?: number;
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
  readonly clip?: ClipRect;
  readonly opacity?: number;
}

/** Картинка: байты лежат в `relId` как `data:`-ссылка. */
export interface ImagePrimitive {
  readonly kind: 'image';
  readonly relId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Прозрачность: `1` — непрозрачный, поле отсутствует. */
  readonly opacity?: number;
  readonly clip?: ClipRect;
}

/** Команда пути — подмножество графических операторов PDF. */
export type PathCommand =
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  | { readonly type: 'line'; readonly x: number; readonly y: number }
  | {
      readonly type: 'quad';
      readonly cpx: number;
      readonly cpy: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: 'cubic';
      readonly cp1x: number;
      readonly cp1y: number;
      readonly cp2x: number;
      readonly cp2y: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly type: 'close' };

/**
 * Путь: фигуры, диаграммы, всё, что движок книг отдаёт командой `path`.
 *
 * Квадратичная кривая здесь допустима, хотя оператора `q` в PDF нет:
 * экспортёр переводит её в кубическую — так ближе к тому, что нарисовал бы
 * canvas, чем ломаная.
 */
export interface PathPrimitive {
  readonly kind: 'path';
  readonly commands: readonly PathCommand[];
  readonly fill?: string;
  readonly stroke?: { readonly color: string; readonly width: number };
  readonly clip?: ClipRect;
  readonly opacity?: number;
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
  readonly clip?: ClipRect;
  readonly opacity?: number;
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
  | DecorationPrimitive
  | PathPrimitive;

/** Всё, что встречается в display list, включая пока не поддержанное. */
export type DisplayPrimitive = PaintablePrimitive | TextRunPrimitive | { readonly kind: string };

/** Колонтитул: своя система координат внутри полосы страницы. */
export interface HeaderFooterRegion {
  readonly y: number;
  readonly height: number;
  readonly primitives: readonly DisplayPrimitive[];
}

/**
 * Матрица содержимого страницы: масштаб и сдвиг.
 *
 * Так выражается подгонка книги под страницу (`fitToOnePage`) и её поля:
 * содержимое сжимается целиком, а не пересчитывается поэлементно. Вектор
 * от этого не страдает — текст остаётся текстом, меняется только матрица.
 */
export interface PageTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
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
  readonly transform?: PageTransform;
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
