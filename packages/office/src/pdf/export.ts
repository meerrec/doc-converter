/**
 * Экспорт PDF: display list движка → файл.
 *
 * Движок отдаёт готовую вёрстку — страницы с примитивами, у текста есть
 * номера глифов, координаты и ширина. Значит, писать заново нужно не layout,
 * а сериализацию: как эти примитивы ложатся в синтаксис PDF.
 *
 * Что здесь важно и неочевидно:
 *
 * - **текст рисуется глифами, а не символами.** В потоке страницы стоит
 *   `<0041> Tj` — номер глифа в исходном шрифте, и он же индексирует
 *   `CIDToGIDMap /Identity`. Поэтому шрифт субсеттится с `RETAIN_GIDS`
 *   (см. `subset.ts`), а не как обычно;
 * - **формат шрифта определяет способ встраивания.** TrueType (таблица
 *   `glyf`) кладётся в `FontFile2` при `CIDFontType2`, а CFF-контейнер
 *   (`OTTO`, им приходят CJK-начертания) — в `FontFile3` с подтипом
 *   `OpenType` при `CIDFontType0`, где `CIDToGIDMap` не допускается вовсе.
 *   Признак читается из байтов: одно и то же семейство может прийти
 *   и файлом `.ttf`, и `.otf`;
 * - **`ToUnicode` строится из кластеров**, а кластеры — смещения в байтах
 *   UTF-8. Без этой таблицы текст виден, но не копируется и не ищется;
 * - **координаты переворачиваются**: display list считает Y вниз от верхнего
 *   края, PDF — вверх от нижнего.
 *
 * Чего экспортёр пока не делает (сознательно, а не по недосмотру):
 *
 * - **прогоны `kind: 'text'` пропускаются.** Так приходят номера пунктов
 *   списка у документов Word: движок не разложил их на глифы, отдав строку
 *   и CSS-шорткат шрифта. Книги приходят теми же строками, но их раскладывает
 *   наш шейпинг (`shape/`) до экспортёра, поэтому сюда такие прогоны
 *   не доходят;
 * - **повороты и масштаб текста** (`rotationDeg`, `horizontalScale`)
 *   игнорируются: текст рисуется по своим координатам глифов, и для
 *   неповёрнутого листа это верно;
 * - **параметры экспорта** (PDF/A, водяной знак, сжатие, версия) — предмет
 *   следующего шага; сейчас файл всегда PDF 1.7 без метаданных.
 *
 * Все комментарии на русском языке.
 */

import { PdfBuilder } from './builder.js';
import { readGlyphToCid } from './cff.js';
import { toUnicodeCMap } from './cmap.js';
import { parseColor } from './color.js';
import { decodeImage } from './image.js';
import { loadSubsetter } from './subset.js';
import type {
  ClipRect,
  DecorationPrimitive,
  DisplayList,
  DisplayPage,
  DisplayPrimitive,
  FontResource,
  GlyphRunPrimitive,
  ImagePrimitive,
  LinePrimitive,
  PathPrimitive,
  RectPrimitive,
} from './types.js';

/**
 * Перевод пикселей CSS в пункты PDF.
 *
 * 72/96 — отношение пункта к пикселю CSS: в пункте 1/72 дюйма, в пикселе
 * CSS 1/96. Число постоянное, потому что display list движка считает
 * страницы именно в пикселях CSS.
 */
const PX_TO_PT = 72 / 96;

/**
 * Толщина декорации, если движок не задал высоту.
 *
 * 0.5 pt — минимальная различимая линия: у тонких подчёркиваний высота
 * приходит нулевой, а нулевая толщина в PDF означает невидимый штрих.
 */
const MIN_DECORATION_PT = 0.5;

/** Что нужно экспортёру, чтобы собрать файл. */
export interface PdfExportOptions {
  /** Шрифты по тем номерам, которыми их называет display list. */
  readonly fonts: ReadonlyMap<number, FontResource>;
}

/** Собранные по шрифту данные: что субсеттить, что писать в `ToUnicode`. */
interface FontUsage {
  /** Символы, начертанные этим шрифтом: из них собирается субсет. */
  text: string;
  /** Номер глифа → символ. */
  readonly mapping: Map<number, string>;
  /** Номер глифа → ширина в тысячных долях em. */
  readonly widths: Map<number, number>;
}

/**
 * Строит PDF из display list.
 *
 * @param displayList - вёрстка документа
 * @param options - шрифты по номерам
 * @returns байты PDF
 */
export async function buildPdf(displayList: DisplayList, options: PdfExportOptions): Promise<Uint8Array> {
  const pages = displayList.pages;
  const usage = collectFontUsage(pages);

  const pdf = new PdfBuilder();

  // Номер дерева страниц резервируется первым: на него ссылаются `/Parent`
  // каждой страницы, а содержимое дерева известно только после их сборки
  const pagesRef = pdf.add('');
  const fonts = await emitFonts(pdf, usage, options.fonts);
  const images = emitImages(pdf, pages);
  const alphas = emitAlphaStates(pdf, pages);

  const pageRefs: number[] = [];

  for (const page of pages) {
    pageRefs.push(emitPage(pdf, pagesRef, page, fonts, images, alphas));
  }

  pdf.replace(
    pagesRef,
    `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`
  );

  return pdf.build(pdf.add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`));
}

/**
 * Обходит примитивы страницы, включая колонтитулы.
 *
 * Колонтитулы лежат отдельными полосами (`page.header`/`page.footer`),
 * но рисуются тем же кодом и по тем же координатам — поэтому собирать
 * их нужно вместе с телом, иначе шрифт колонтитула не попадёт в файл.
 *
 * @param page - страница
 * @returns примитивы в порядке отрисовки
 */
function pagePrimitives(page: DisplayPage): readonly DisplayPrimitive[] {
  return [...(page.header?.primitives ?? []), ...page.primitives, ...(page.footer?.primitives ?? [])];
}

/**
 * Собирает по каждому шрифту символы, глифы и их ширины.
 *
 * @param pages - страницы документа
 * @returns данные по номерам шрифтов
 */
function collectFontUsage(pages: readonly DisplayPage[]): Map<number, FontUsage> {
  const usage = new Map<number, FontUsage>();

  for (const page of pages) {
    for (const primitive of pagePrimitives(page)) {
      if (primitive.kind !== 'glyphRun') {
        continue;
      }

      const run = primitive as GlyphRunPrimitive;
      const entry = usage.get(run.fontId) ?? { text: '', mapping: new Map(), widths: new Map() };

      entry.text += run.text;

      // `cluster` — смещение в БАЙТАХ, поэтому режем текст по байтам,
      // а не по знакам: у кириллицы знак занимает два байта, и «посимвольный»
      // разрез дал бы в ToUnicode половину символа
      const encoded = new TextEncoder().encode(run.text);

      for (const [index, glyph] of run.glyphs.entries()) {
        const next = run.glyphs[index + 1];
        const from = glyph.cluster;
        const to = next?.cluster ?? encoded.byteLength;

        if (to > from) {
          const piece = new TextDecoder().decode(encoded.subarray(from, to));

          // Первое соответствие важнее: один глиф может встретиться
          // в разных контекстах, а таблица допускает только одно значение
          if (piece !== '' && !entry.mapping.has(glyph.id)) {
            entry.mapping.set(glyph.id, piece);
          }
        }

        if (glyph.advance !== undefined && run.size > 0) {
          entry.widths.set(glyph.id, (glyph.advance / run.size) * 1000);
        }
      }

      usage.set(run.fontId, entry);
    }
  }

  return usage;
}

/** Сигнатура sfnt-контейнера с таблицей CFF: `OTTO`. */
const SFNT_OTTO = [0x4f, 0x54, 0x54, 0x4f];

/**
 * Определяет, лежит ли в байтах CFF-контейнер.
 *
 * По сигнатуре, а не по имени: провайдер отдаёт и `.ttf`, и `.otf`, а один
 * и тот же шрифт встречается в обоих видах. У TrueType сигнатура другая
 * (`0x00010000` или `true`), и на неё здесь отвечает «нет».
 *
 * @param bytes - байты sfnt
 * @returns true, если контейнер несёт CFF
 */
function isCffFont(bytes: Uint8Array): boolean {
  return SFNT_OTTO.every((byte, index) => bytes[index] === byte);
}

/**
 * Встроенный шрифт: как его назвать на странице и как перевести глиф в CID.
 *
 * `cidOf` заполнен только для CID-keyed CFF: у TrueType номер глифа и есть
 * CID, и карта там не нужна.
 */
interface EmbeddedFont {
  readonly name: string;
  /** Номер объекта шрифта в файле. */
  readonly ref: number;
  /** CID по номеру глифа; `null` — номера совпадают. */
  readonly cidOf: Uint16Array | null;
}

/**
 * Добавляет шрифты и возвращает их имена в ресурсах страниц.
 *
 * @param pdf - сборщик
 * @param usage - собранные символы и ширины
 * @param resources - байты шрифтов по номерам
 * @returns номер шрифта → встроенный шрифт
 */
async function emitFonts(
  pdf: PdfBuilder,
  usage: ReadonlyMap<number, FontUsage>,
  resources: ReadonlyMap<number, FontResource>
): Promise<Map<number, EmbeddedFont>> {
  const subsetter = await loadSubsetter();
  const embedded = new Map<number, EmbeddedFont>();

  for (const [fontId, entry] of usage) {
    const resource = resources.get(fontId);

    // Шрифт, которого нет среди зарегистрированных, молча пропускается:
    // текст этим шрифтом не нарисуется, но остальной документ соберётся.
    // Так приходит fallback, о котором хост не знает
    if (resource === undefined) {
      continue;
    }

    const name = `F${fontId}`;
    const subset = subsetter.subset(resource.bytes, entry.text);
    const cff = isCffFont(subset);

    // У CID-keyed CFF номер глифа и CID расходятся после субсеттинга,
    // а PDF адресует глифы именно CID — см. `cff.ts`. Ширины и `ToUnicode`
    // поэтому тоже пересчитываются на CID: иначе они описывали бы
    // не те знаки, что нарисованы
    const cidOf = cff ? readGlyphToCid(subset) : null;
    const cidOfGlyph = (glyph: number): number | null => {
      if (cidOf === null) {
        return glyph;
      }

      return cidOf[glyph] ?? null;
    };

    const fileRef = cff
      ? pdf.addStream(
          `<< /Filter /FlateDecode /Subtype /OpenType /Length1 ${subset.byteLength} >>`,
          subset
        )
      : pdf.addStream(`<< /Filter /FlateDecode /Length1 ${subset.byteLength} >>`, subset);

    // Поле с файлом шрифта у двух форматов называется по-разному, и подмена
    // одного другим не косметическая ошибка: `FontFile2` с CFF внутри
    // просмотрщик читает как TrueType и не рисует ни одного глифа
    const fontFile = cff ? `/FontFile3 ${fileRef} 0 R` : `/FontFile2 ${fileRef} 0 R`;

    const descriptorRef = pdf.add(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 ${fontFile} >>`
    );

    const widths = [...entry.widths.entries()]
      .flatMap(([glyph, width]) => {
        const cid = cidOfGlyph(glyph);

        return cid === null ? [] : [`${cid} [${Math.round(width)}]`];
      })
      .join(' ');

    // `CIDToGIDMap` — поле только `CIDFontType2`. У CIDFontType0 соответствие
    // CID→GID задаёт charset самого CFF, и лишнее поле делает словарь
    // недействительным
    const descendant = cff
      ? `/Subtype /CIDFontType0`
      : `/Subtype /CIDFontType2 /CIDToGIDMap /Identity`;

    const descendantRef = pdf.add(
      `<< /Type /Font ${descendant} /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorRef} 0 R /DW 1000 /W [${widths}] >>`
    );

    // Ключи `ToUnicode` — тоже CID: по ним просмотрщик сопоставляет
    // нарисованный глиф символу при копировании и поиске
    const mapping = new Map<number, string>();

    for (const [glyph, piece] of entry.mapping) {
      const cid = cidOfGlyph(glyph);

      if (cid !== null && !mapping.has(cid)) {
        mapping.set(cid, piece);
      }
    }

    const toUnicodeRef = pdf.addStream('<< /Filter /FlateDecode >>', toUnicodeCMap(mapping));

    const fontRef = pdf.add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${descendantRef} 0 R] /ToUnicode ${toUnicodeRef} 0 R >>`
    );

    embedded.set(fontId, { name, ref: fontRef, cidOf });
  }

  return embedded;
}

/** Картинка, разложенная на объекты PDF. */
interface EmittedImage {
  readonly ref: number;
  readonly name: string;
}

/**
 * Добавляет картинки документа.
 *
 * Байты приходят прямо в `relId` как `data:`-ссылка — отдельного хранилища
 * у браузерного пути нет.
 *
 * @param pdf - сборщик
 * @param pages - страницы документа
 * @returns ссылка на картинку → объект
 */
function emitImages(pdf: PdfBuilder, pages: readonly DisplayPage[]): Map<string, EmittedImage> {
  const emitted = new Map<string, EmittedImage>();

  for (const page of pages) {
    for (const primitive of pagePrimitives(page)) {
      if (primitive.kind !== 'image') {
        continue;
      }

      const relId = (primitive as ImagePrimitive).relId;

      if (emitted.has(relId)) {
        continue;
      }

      const bytes = readDataUrl(relId);

      if (bytes === null) {
        continue;
      }

      try {
        emitted.set(relId, emitImage(pdf, bytes, relId));
      } catch {
        // Битая или неподдержанная картинка не должна ронять весь документ:
        // без неё страница останется читаемой, с ней — не соберётся вовсе
      }
    }
  }

  return emitted;
}

/**
 * Добавляет одну картинку.
 *
 * @param pdf - сборщик
 * @param bytes - байты файла картинки
 * @param relId - ссылка, из которой выводится имя объекта
 * @returns объект картинки
 */
function emitImage(pdf: PdfBuilder, bytes: Uint8Array, relId: string): EmittedImage {
  const decoded = decodeImage(bytes);
  const name = imageName(relId);

  if (decoded.kind === 'jpeg') {
    const { width, height, components } = decoded.image;
    const colorSpace = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const ref = pdf.addStream(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode >>`,
      decoded.image.bytes
    );

    return { ref, name };
  }

  const { width, height, rgb, alpha } = decoded.image;
  const dict = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`;

  if (alpha === null) {
    return {
      ref: pdf.addStream(`${dict} >>`, rgb),
      name,
    };
  }

  // Прозрачности в PDF нет: она лежит отдельным объектом-маской, а картинка
  // на неё ссылается. Маска — тот же поток, но в оттенках серого
  const maskRef = pdf.addStream(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`,
    alpha
  );

  return {
    ref: pdf.addStream(`${dict} /SMask ${maskRef} 0 R >>`, rgb),
    name,
  };
}

/**
 * Разбирает `data:`-ссылку и возвращает байты.
 *
 * @param url - ссылка вида `data:image/png;base64,…`
 * @returns байты или `null`, если ссылка не того вида
 */
function readDataUrl(url: string): Uint8Array | null {
  const separator = url.indexOf(',');

  if (!url.startsWith('data:') || separator < 0 || !url.slice(0, separator).includes('base64')) {
    return null;
  }

  try {
    const binary = atob(url.slice(separator + 1));
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

/**
 * Добавляет страницу и возвращает её номер.
 *
 * @param pdf - сборщик
 * @param pagesRef - номер дерева страниц
 * @param page - страница display list
 * @param fonts - встроенные шрифты по номерам
 * @param images - объекты картинок по именам
 * @returns номер объекта страницы
 */
function emitPage(
  pdf: PdfBuilder,
  pagesRef: number,
  page: DisplayPage,
  fonts: ReadonlyMap<number, EmbeddedFont>,
  images: ReadonlyMap<string, EmittedImage>,
  alphas: ReadonlyMap<number, EmittedAlpha>
): number {
  const height = page.height * PX_TO_PT;

  /** Переводит Y из системы display list в систему PDF. */
  const flip = (y: number): number => height - y * PX_TO_PT;

  const content: string[] = [];
  const usedFonts = new Set<number>();
  const usedImages = new Set<string>();
  const usedAlphas = new Set<number>();

  if (page.background !== undefined && page.background !== '') {
    content.push(`${fillColor(page.background)}`, `0 0 ${pt(page.width)} ${pt(page.height)} re f`);
  }

  // Матрица страницы: подгонка под лист (`fitToOnePage`) и поля книги.
  // Сжимается всё содержимое сразу, а не каждый примитив по отдельности, —
  // поэтому текст остаётся текстом, а не пересчитанными координатами
  const transform = page.transform;

  if (transform !== undefined) {
    const tx = transform.x * PX_TO_PT;
    const ty = height * (1 - transform.scale) - transform.y * PX_TO_PT;

    content.push(
      'q',
      `${transform.scale.toFixed(4)} 0 0 ${transform.scale.toFixed(4)} ${fixed(tx)} ${fixed(ty)} cm`
    );
  }

  for (const primitive of pagePrimitives(page)) {
    drawPrimitive(primitive, {
      content,
      flip,
      usedFonts,
      usedImages,
      usedAlphas,
      fonts,
      alphas,
    });
  }

  if (transform !== undefined) {
    content.push('Q');
  }

  const contentRef = pdf.addStream('<< /Filter /FlateDecode >>', new TextEncoder().encode(content.join('\n')));

  const resources = [...usedFonts]
    .map((fontId) => fonts.get(fontId))
    .filter((entry): entry is EmbeddedFont => entry !== undefined)
    .map((entry) => `/${entry.name} ${entry.ref} 0 R`)
    .join(' ');

  const xobjects = [...usedImages]
    .map((key) => images.get(key))
    .filter((entry): entry is EmittedImage => entry !== undefined)
    .map((entry) => `/${entry.name} ${entry.ref} 0 R`)
    .join(' ');

  const xobjectDict = xobjects === '' ? '' : ` /XObject << ${xobjects} >>`;

  const graphics = [...usedAlphas]
    .map((value) => alphas.get(value))
    .filter((entry): entry is EmittedAlpha => entry !== undefined)
    .map((entry) => `/${entry.name} ${entry.ref} 0 R`)
    .join(' ');

  const graphicsDict = graphics === '' ? '' : ` /ExtGState << ${graphics} >>`;

  return pdf.add(
    `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${pt(page.width)} ${pt(page.height)}] /Resources << /Font << ${resources} >>${xobjectDict}${graphicsDict} >> /Contents ${contentRef} 0 R >>`
  );
}

/** Что нужно, чтобы нарисовать один примитив. */
interface DrawContext {
  readonly content: string[];
  readonly flip: (y: number) => number;
  readonly usedFonts: Set<number>;
  readonly usedImages: Set<string>;
  readonly usedAlphas: Set<number>;
  readonly fonts: ReadonlyMap<number, EmbeddedFont>;
  readonly alphas: ReadonlyMap<number, EmittedAlpha>;
}

/** Состояние прозрачности, заведённое в файле. */
interface EmittedAlpha {
  readonly name: string;
  readonly ref: number;
}

/**
 * Заводит объекты состояния прозрачности на все встреченные значения.
 *
 * Прозрачность в PDF — не цвет с альфой, а отдельный словарь `/ExtGState`.
 * Объект общий на весь файл: одно и то же значение встречается на десятках
 * страниц, и заводить его каждый раз значило бы повторять словарь.
 *
 * @param pdf - сборщик
 * @param pages - страницы документа
 * @returns значение прозрачности → объект
 */
function emitAlphaStates(pdf: PdfBuilder, pages: readonly DisplayPage[]): Map<number, EmittedAlpha> {
  const values = new Set<number>();

  for (const page of pages) {
    for (const primitive of pagePrimitives(page)) {
      const alpha = (primitive as { alpha?: number }).alpha;

      if (alpha !== undefined && alpha < 1) {
        values.add(roundAlpha(alpha));
      }
    }
  }

  const states = new Map<number, EmittedAlpha>();
  let index = 0;

  for (const value of values) {
    index += 1;
    states.set(value, {
      name: `GS${index}`,
      ref: pdf.add(`<< /Type /ExtGState /ca ${value} /CA ${value} >>`),
    });
  }

  return states;
}

/**
 * Открывает графическое состояние примитива: прозрачность и обрезку.
 *
 * @param primitive - примитив с необязательными `alpha` и `clip`
 * @param context - поток страницы
 * @returns число открытых состояний, которые нужно закрыть
 */
function beginPrimitive(
  primitive: { readonly alpha?: number; readonly clip?: ClipRect },
  context: DrawContext
): number {
  const clip = primitive.clip;
  const alpha = primitive.alpha;
  const state = alpha !== undefined && alpha < 1 ? context.alphas.get(roundAlpha(alpha)) : undefined;
  const alphaRef = state === undefined ? null : state;

  if (clip === undefined && alphaRef === null) {
    return 0;
  }

  context.content.push('q');

  if (alphaRef !== null) {
    context.usedAlphas.add(roundAlpha(alpha ?? 1));
    context.content.push(`/${alphaRef.name} gs`);
  }

  if (clip !== undefined && clip.w > 0 && clip.h > 0) {
    context.content.push(
      `${pt(clip.x)} ${pt(context.flip(clip.y + clip.h))} ${pt(clip.w)} ${pt(clip.h)} re W n`
    );
  }

  return 1;
}

/**
 * Закрывает графическое состояние примитива.
 *
 * @param depth - что вернул `beginPrimitive`
 * @param context - поток страницы
 */
function endPrimitive(depth: number, context: DrawContext): void {
  if (depth > 0) {
    context.content.push('Q');
  }
}

/**
 * Округляет прозрачность до тысячных.
 *
 * Значения приходят из цветов вида `rgba(...)`, а словарь `/ExtGState` —
 * объект файла: без округления близкие значения заводили бы отдельные записи.
 *
 * @param value - прозрачность
 * @returns округлённое значение
 */
function roundAlpha(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

/**
 * Дорисовывает примитив в поток страницы.
 *
 * @param primitive - примитив display list
 * @param context - поток и собранные ссылки
 */
function drawPrimitive(primitive: DisplayPrimitive, context: DrawContext): void {
  switch (primitive.kind) {
    case 'rect':
      drawRect(primitive as RectPrimitive, context);
      return;
    case 'line':
      drawLine(primitive as LinePrimitive, context);
      return;
    case 'image':
      drawImage(primitive as ImagePrimitive, context);
      return;
    case 'decoration':
      drawDecoration(primitive as DecorationPrimitive, context);
      return;
    case 'glyphRun':
      drawGlyphRun(primitive as GlyphRunPrimitive, context);
      return;
    case 'path':
      drawPath(primitive as PathPrimitive, context);
      return;
    default:
      // `text` движка пока не поддержан — см. шапку файла
      return;
  }
}

/**
 * Рисует прямоугольник.
 *
 * @param primitive - прямоугольник
 * @param context - поток страницы
 */
function drawRect(primitive: RectPrimitive, context: DrawContext): void {
  if (primitive.w <= 0 || primitive.h <= 0) {
    return;
  }

  const depth = beginPrimitive(primitive, context);

  context.content.push(
    fillColor(primitive.fill),
    `${pt(primitive.x)} ${pt(context.flip(primitive.y + primitive.h))} ${pt(primitive.w)} ${pt(primitive.h)} re f`
  );

  endPrimitive(depth, context);
}

/**
 * Рисует отрезок.
 *
 * Толщина берётся из `strokeWidth`, а не из `width`: у линии display list
 * поле называется именно так, и опечатка здесь даёт волосяные линии
 * на месте границ таблиц.
 *
 * @param primitive - отрезок
 * @param context - поток страницы
 */
function drawLine(primitive: LinePrimitive, context: DrawContext): void {
  const width = primitive.strokeWidth > 0 ? primitive.strokeWidth : MIN_DECORATION_PT;

  const depth = beginPrimitive(primitive, context);

  context.content.push(
    `${strokeColor(primitive.color)} RG`,
    `${pt(width)} w`,
    dashPattern(primitive.dash),
    `${pt(primitive.x1)} ${pt(context.flip(primitive.y1))} m ${pt(primitive.x2)} ${pt(context.flip(primitive.y2))} l S`
  );

  endPrimitive(depth, context);
}

/**
 * Рисует картинку.
 *
 * @param primitive - картинка
 * @param context - поток страницы
 */
function drawImage(primitive: ImagePrimitive, context: DrawContext): void {
  if (primitive.w <= 0 || primitive.h <= 0) {
    return;
  }

  // Сам объект заведён заранее (`emitImages`), здесь только отмечается
  // использование: в ресурсы страницы попадает лишь то, что нарисовано
  context.usedImages.add(primitive.relId);

  const depth = beginPrimitive(primitive, context);

  context.content.push(
    'q',
    `${pt(primitive.w)} 0 0 ${pt(primitive.h)} ${pt(primitive.x)} ${pt(context.flip(primitive.y + primitive.h))} cm`,
    `/${imageName(primitive.relId)} Do`,
    'Q'
  );

  endPrimitive(depth, context);
}

/**
 * Рисует декорацию текста — подчёркивание, зачёркивание, выделение.
 *
 * @param primitive - декорация
 * @param context - поток страницы
 */
function drawDecoration(primitive: DecorationPrimitive, context: DrawContext): void {
  if (primitive.w <= 0) {
    return;
  }

  const thickness = Math.max(primitive.h, MIN_DECORATION_PT / PX_TO_PT);
  const pattern = primitive.dashed === true ? '[3 2] 0 d' : primitive.dotted === true ? '[1 2] 0 d' : '[] 0 d';

  const depth = beginPrimitive(primitive, context);

  context.content.push(
    fillColor(primitive.color),
    pattern,
    `${pt(primitive.x)} ${pt(context.flip(primitive.y + thickness))} ${pt(primitive.w)} ${pt(thickness)} re f`,
    '[] 0 d'
  );

  endPrimitive(depth, context);
}

/**
 * Рисует прогон текста.
 *
 * Каждый глиф ставится своей матрицей: координаты берутся из display list,
 * поэтому результат совпадает с тем, что показал бы рендер движка. Заодно
 * это снимает вопрос кернинга и лигатур — раскладку уже посчитал движок.
 *
 * В поток идёт **CID**, а не номер глифа движка: у CID-keyed CFF это разные
 * числа, и карта перевода лежит в `EmbeddedFont.cidOf`.
 *
 * @param primitive - прогон текста
 * @param context - поток страницы
 */
function drawGlyphRun(primitive: GlyphRunPrimitive, context: DrawContext): void {
  const font = context.fonts.get(primitive.fontId);

  if (font === undefined || primitive.glyphs.length === 0) {
    return;
  }

  const depth = beginPrimitive(primitive, context);

  context.usedFonts.add(primitive.fontId);
  context.content.push('BT', fillColor(primitive.color), `/${font.name} ${pt(primitive.size)} Tf`);

  for (const glyph of primitive.glyphs) {
    const cid = font.cidOf === null ? glyph.id : font.cidOf[glyph.id];

    // Глифа нет в субсете — рисовать нечего: пустой CID дал бы `.notdef`
    if (cid === undefined) {
      continue;
    }

    context.content.push(
      `1 0 0 1 ${pt(glyph.x)} ${pt(context.flip(glyph.y))} Tm`,
      `<${cid.toString(16).padStart(4, '0').toUpperCase()}> Tj`
    );
  }

  context.content.push('ET');

  endPrimitive(depth, context);
}

/**
 * Рисует путь: фигуры, диаграммы — всё, что движок отдал командой `path`.
 *
 * Квадратичная кривая переводится в кубическую: оператора `q` в PDF нет,
 * а ломаная на месте сглаженного угла заметна. Контрольные точки считаются
 * по обычной формуле подъёма степени — результат совпадает с тем, что
 * нарисовал бы canvas.
 *
 * @param primitive - путь
 * @param context - поток страницы
 */
function drawPath(primitive: PathPrimitive, context: DrawContext): void {
  if (primitive.commands.length === 0) {
    return;
  }

  const depth = beginPrimitive(primitive, context);

  /** Последняя точка пути: от неё считается квадратичная кривая. */
  let current: { x: number; y: number } | null = null;

  for (const command of primitive.commands) {
    switch (command.type) {
      case 'move':
        context.content.push(`${pt(command.x)} ${pt(context.flip(command.y))} m`);
        current = { x: command.x, y: command.y };
        break;
      case 'line':
        context.content.push(`${pt(command.x)} ${pt(context.flip(command.y))} l`);
        current = { x: command.x, y: command.y };
        break;
      case 'cubic':
        context.content.push(
          `${pt(command.cp1x)} ${pt(context.flip(command.cp1y))} ${pt(command.cp2x)} ${pt(context.flip(command.cp2y))} ${pt(command.x)} ${pt(context.flip(command.y))} c`
        );
        current = { x: command.x, y: command.y };
        break;
      case 'quad': {
        const from = current ?? { x: command.cpx, y: command.cpy };
        const firstX = from.x + (2 / 3) * (command.cpx - from.x);
        const firstY = from.y + (2 / 3) * (command.cpy - from.y);
        const secondX = command.x + (2 / 3) * (command.cpx - command.x);
        const secondY = command.y + (2 / 3) * (command.cpy - command.y);

        context.content.push(
          `${pt(firstX)} ${pt(context.flip(firstY))} ${pt(secondX)} ${pt(context.flip(secondY))} ${pt(command.x)} ${pt(context.flip(command.y))} c`
        );
        current = { x: command.x, y: command.y };
        break;
      }
      case 'close':
        context.content.push('h');
        break;
    }
  }

  const fill = primitive.fill;
  const stroke = primitive.stroke;

  if (fill !== undefined) {
    context.content.push(fillColor(fill));
  }

  if (stroke !== undefined) {
    context.content.push(
      `${strokeColor(stroke.color)} RG`,
      `${pt(stroke.width > 0 ? stroke.width : MIN_DECORATION_PT)} w`
    );
  }

  // Оператор выбирается по тому, что задано: `B` — заливка и обводка сразу
  context.content.push(fill !== undefined && stroke !== undefined ? 'B' : fill !== undefined ? 'f' : 'S');

  endPrimitive(depth, context);
}

/**
 * Имя объекта картинки по её ссылке.
 *
 * Имя обязано быть устойчивым: `emitImages` заводит объект один раз, а ссылок
 * на него в документе столько, сколько раз картинка нарисована. Индекс здесь
 * не подходит — по нему нельзя найти уже созданный объект.
 *
 * @param relId - ссылка на картинку
 * @returns имя без ведущей косой черты
 */
function imageName(relId: string): string {
  let hash = 0;

  for (let index = 0; index < relId.length; index += 1) {
    hash = (hash * 31 + relId.charCodeAt(index)) | 0;
  }

  return `Im${(hash >>> 0).toString(36)}`;
}

/**
 * Переводит пиксели в пункты и округляет.
 *
 * @param value - пиксели
 * @returns строка с числом
 */
function pt(value: number): string {
  return (value * PX_TO_PT).toFixed(2);
}

/**
 * Округляет значение, которое уже выражено в пунктах.
 *
 * Нужно там, где величина посчитана в пунктах, а не пришла в пикселях:
 * повторное умножение на `PX_TO_PT` в `pt` её бы испортило.
 *
 * @param value - значение в пунктах
 * @returns строка с числом
 */
function fixed(value: number): string {
  return value.toFixed(2);
}

/**
 * Цвет заливки: `#rrggbb` → `r g b rg`.
 *
 * @param color - цвет display list
 * @returns оператор цвета или чёрный, если цвет не разобран
 */
function fillColor(color: string): string {
  return `${channels(color)} rg`;
}

/**
 * Цвет обводки.
 *
 * @param color - цвет display list
 * @returns оператор цвета
 */
function strokeColor(color: string): string {
  return `${channels(color)} RG`;
}

/**
 * Разбирает `#rrggbb` в три числа от нуля до единицы.
 *
 * @param color - цвет display list
 * @returns три компоненты через пробел
 */
function channels(color: string): string {
  return parseColor(color).channels;
}

/**
 * Штриховой узор линии.
 *
 * @param dash - длины штрихов в пикселях
 * @returns оператор `d` или пустая строка, если линия сплошная
 */
function dashPattern(dash: readonly number[] | undefined): string {
  if (dash === undefined || dash.length === 0) {
    return '[] 0 d';
  }

  return `[${dash.map((value) => pt(value)).join(' ')}] 0 d`;
}
