/**
 * Что экспортёр PDF переносит в файл, а что пропускает.
 *
 * Список живёт отдельно от экспортёра не для красоты: тем же предикатом
 * пользуется предпросмотр. Он рисует страницы рендерером движка и потому
 * показывает больше, чем попадёт в скачанный файл, — и расхождение нужно
 * назвать пользователю до скачивания, а не оставить его находить самому.
 *
 * Раньше пропуск был молчаливым: `default` в разборе примитива просто
 * возвращал, а `DisplayPrimitive` заканчивается на `{ kind: string }`, поэтому
 * новый вид примитива у движка не ломал ни сборку, ни тесты — он просто
 * исчезал со страницы. Теперь пропущенное считается (`countUnsupported`)
 * и перечисляется по видам.
 *
 * Все комментарии на русском языке.
 */

import type { DisplayPage, DisplayPrimitive } from './types.js';

/**
 * Виды примитивов, которые экспортёр умеет рисовать.
 *
 * Список — не «что хотелось бы», а «что реализовано»: он совпадает
 * с ветками разбора в `export.ts`, и тест сверяет одно с другим. Виды,
 * которых здесь нет (`shape`, `text` у документов Word, всё, что движок
 * добавит в следующих версиях), до PDF не доезжают.
 */
export const SUPPORTED_KINDS = [
  'rect',
  'line',
  'image',
  'decoration',
  'glyphRun',
  'path',
] as const;

/** Вид примитива, который экспортёр переносит в PDF. */
export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

/** Счётчик пропущенного: вид примитива → сколько раз встретился. */
export type SkippedPrimitives = Readonly<Record<string, number>>;

/**
 * Проверяет, рисует ли экспортёр такой вид примитива.
 *
 * @param kind - вид примитива из display list
 * @returns true, если примитив попадёт в PDF
 */
export function isSupported(kind: string): boolean {
  return (SUPPORTED_KINDS as readonly string[]).includes(kind);
}

/**
 * Обходит примитивы страницы, включая колонтитулы.
 *
 * Колонтитулы лежат отдельными полосами (`page.header`/`page.footer`),
 * но рисуются тем же кодом и по тем же координатам — поэтому собирать
 * их нужно вместе с телом, иначе шрифт колонтитула не попадёт в файл,
 * а пропущенный примитив — в счётчик.
 *
 * @param page - страница
 * @returns примитивы в порядке отрисовки
 */
export function pagePrimitives(page: DisplayPage): readonly DisplayPrimitive[] {
  return [...(page.header?.primitives ?? []), ...page.primitives, ...(page.footer?.primitives ?? [])];
}

/**
 * Считает, что из вёрстки не доедет до PDF.
 *
 * Предпросмотр показывает страницы целиком — их рисует движок, — поэтому
 * перечень потерь строится по той же вёрстке, что уходит в экспортёр:
 * пользователь видит документ и одновременно знает, чего в скачанном файле
 * не будет.
 *
 * @param pages - страницы вёрстки
 * @returns вид примитива → сколько раз встретился
 */
export function countUnsupported(pages: readonly DisplayPage[]): SkippedPrimitives {
  const counts: Record<string, number> = {};

  for (const page of pages) {
    for (const primitive of pagePrimitives(page)) {
      if (!isSupported(primitive.kind)) {
        counts[primitive.kind] = (counts[primitive.kind] ?? 0) + 1;
      }
    }
  }

  return counts;
}
