/**
 * Субсеттинг шрифта по начертанным символам — через harfbuzz.
 *
 * Встраивать шрифт в PDF целиком нельзя: Carlito весит под 700 КБ, а CJK-шрифты
 * по несколько мегабайт, и документ из одной страницы потянул бы их все.
 * Поэтому в файл попадает только использованная часть.
 *
 * Ключевая тонкость — **флаг `RETAIN_GIDS`**. Display list движка ссылается
 * на глифы по их номерам в исходном шрифте, а обычный субсет перенумеровывает
 * глифы подряд. Без этого флага `<0041> Tj` в потоке страницы показал бы
 * не тот знак: вместо «Абзац» выводилось «63» — проверено на `pdf-lib`,
 * который субсеттит именно так. С флагом номера остаются исходными,
 * и `CIDToGIDMap /Identity` становится верным по построению.
 *
 * Субсет задаётся **набором символов**, а не глифов: эта сборка harfbuzz
 * на набор глифов отвечает пустым blob. Для нашего случая разницы нет —
 * текст прогонов известен.
 *
 * Все комментарии на русском языке.
 */

import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import { readAsset } from '../assets.js';

/** Режим памяти, при котором harfbuzz не копирует буфер себе. */
const HB_MEMORY_MODE_WRITABLE = 2;

/** Оставить номера глифов такими же, как в исходном шрифте. */
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x00000002;

/**
 * Подмножество экспортов harfbuzz, которое здесь используется.
 *
 * Своими типами, а не из пакета: `harfbuzzjs` описывает полный C-API,
 * а нам нужна горстка функций — и под неё проще удержать соответствие
 * сигнатурам, чем разбираться, почему не сходится чужой универсальный тип.
 */
interface HarfbuzzExports {
  readonly memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number
  ): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
  hb_set_add(set: number, codepoint: number): void;
  _initialize?: () => void;
}

/** Готовый субсеттер: держит загруженный модуль harfbuzz. */
export interface FontSubsetter {
  /**
   * Оставляет в шрифте только перечисленные символы.
   *
   * @param font - исходный sfnt (TrueType или OpenType)
   * @param text - символы, которые должны остаться
   * @returns байты субсета
   */
  subset(font: Uint8Array, text: string): Uint8Array;
}

/** Загруженный модуль: один на страницу — второй экземпляр дублировал бы память. */
let loading: Promise<FontSubsetter> | null = null;

/**
 * Загружает harfbuzz и возвращает субсеттер.
 *
 * Загрузка мемоизирована: модуль весит 636 КБ и держит собственную память,
 * а нужен он всем шрифтам документа.
 *
 * @returns субсеттер
 */
export function loadSubsetter(): Promise<FontSubsetter> {
  loading ??= start();

  return loading;
}

/**
 * Выполняет загрузку модуля.
 *
 * @returns субсеттер
 */
async function start(): Promise<FontSubsetter> {
  const bytes = await readAsset(subsetWasmUrl);
  const { instance } = await WebAssembly.instantiate(bytes);
  const wasm = instance.exports as unknown as HarfbuzzExports;

  // Модуль собран как reactor: без `_initialize` его таблицы остаются
  // неинициализированными, и первый же вызов падает
  wasm._initialize?.();

  return { subset: (font, text) => subsetOrThrow(wasm, font, text) };
}

/**
 * Выполняет субсеттинг.
 *
 * @param wasm - экспорты harfbuzz
 * @param font - исходный шрифт
 * @param text - оставляемые символы
 * @returns байты субсета
 */
function subsetOrThrow(wasm: HarfbuzzExports, font: Uint8Array, text: string): Uint8Array {
  // Представление памяти берётся заново после каждого роста: `malloc`
  // при нехватке места растит память, и прежний `Uint8Array` становится
  // отсоединённым — обращение к нему читает мусор, а не данные
  const heap = (): Uint8Array => new Uint8Array(wasm.memory.buffer);

  const input = wasm.hb_subset_input_create_or_fail();

  if (input === 0) {
    throw new Error('harfbuzz не создал вход субсеттинга');
  }

  wasm.hb_subset_input_set_flags(input, wasm.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_RETAIN_GIDS);

  const codepoints = wasm.hb_subset_input_unicode_set(input);

  for (const char of text) {
    wasm.hb_set_add(codepoints, char.codePointAt(0) ?? 0);
  }

  const buffer = wasm.malloc(font.byteLength);
  heap().set(font, buffer);

  const blob = wasm.hb_blob_create(buffer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = wasm.hb_face_create(blob, 0);

  let subset = 0;
  let source = 0;
  let result: Uint8Array;

  try {
    // `hb_subset_or_fail` возвращает face, а не blob: байты достаются
    // через `hb_face_reference_blob` — иначе длина всегда ноль
    subset = wasm.hb_subset_or_fail(face, input);

    if (subset === 0) {
      throw new Error('harfbuzz не построил субсет');
    }

    source = wasm.hb_face_reference_blob(subset);
    const offset = wasm.hb_blob_get_data(source, 0);
    const length = wasm.hb_blob_get_length(source);

    result = heap().slice(offset, offset + length);
  } finally {
    // Освобождение не должно подменять исходную ошибку: в этой сборке
    // `hb_blob_destroy` падает («table index is out of bounds»), и упавший
    // `finally` скрыл бы причину отказа
    for (const release of [
      () => wasm.hb_blob_destroy(source),
      () => wasm.hb_blob_destroy(blob),
      () => wasm.hb_face_destroy(subset),
      () => wasm.hb_face_destroy(face),
      () => wasm.hb_subset_input_destroy(input),
      () => wasm.free(buffer),
    ]) {
      try {
        release();
      } catch {
        // намеренно: см. выше
      }
    }
  }

  return result;
}
