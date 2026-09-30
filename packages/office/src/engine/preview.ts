/**
 * Сессия предпросмотра: открытый документ, страницы которого берут по одной.
 *
 * Документ раскладывается один раз, а рисуется страницами и по требованию:
 * панель показывает только то, что попало в область видимости, и платит
 * за это памятью вкладки. Готовый PDF для предпросмотра не собирается вовсе —
 * страницы рисует canvas-рендерер движка из той же вёрстки, что уходит
 * в экспортёр.
 *
 * Три вещи, которые здесь важны и не видны снаружи:
 *
 * - **Сессия удерживает документ.** У документа Word это display list
 *   (вёрстка целиком), у книги — открытая книга и план её страниц. Держать
 *   их дольше, чем открыта панель, незачем, поэтому закрывает сессию тот,
 *   кто её открыл, — очередь;
 * - **Сессия переживает чужую конвертацию.** Номера шрифтов в хранилище
 *   отрисовки не переиспользуются: наши вызовы его только пополняют
 *   (`session.clearFonts()` чистит другое хранилище — хранилище правок).
 *   Значит, вёрстка открытого предпросмотра остаётся верной, пока идёт
 *   конвертация другого файла, и закрывать панель при каждой задаче
 *   не нужно. Это утверждение закреплено тестом;
 * - **Растр отдаётся один раз.** За каждый `ImageBitmap` отвечает тот,
 *   кто его получил: не нарисованный вовремя растр закрывает клиент,
 *   а нарисованный — панель.
 *
 * Все комментарии на русском языке.
 */

import { GlyphCache, loadGlyphOutlineProvider } from '@betteroffice/docx/layout/render';
import type { ConversionOptions } from '@doc-converter/contract';
import { PREVIEW_MAX_PAGE_PIXELS, PREVIEW_MAX_SCALE } from '../constants.js';
import { browserFormatOf } from '../filters.js';
import { countUnsupported, type SkippedPrimitives } from '../pdf/support.js';
import { assertSupported } from './convert.js';
import type { ConvertInput } from './convert.js';
import { createCanvasFonts, type CanvasFonts } from './canvas-fonts.js';
import { renderDocx } from './document.js';
import { EngineError } from './errors.js';
import { createImageResolver, rasterizeDocxPage, rasterizeXlsxPage, supportsRaster } from './raster.js';
import { openXlsxPlan, pageFrame, pageImages, type OpenedXlsx, type XlsxPagePlan } from './xlsx/render.js';

/** Размер страницы в пикселях CSS: по нему панель ставит плейсхолдеры. */
export interface PreviewPageSize {
  readonly width: number;
  readonly height: number;
}

/** Открытый документ, страницы которого берут по одной. */
export interface PreviewSession {
  readonly pageCount: number;
  /** Число листов книги; у документа Word — null. */
  readonly sheets: number | null;
  /** Размеры страниц: панель знает их до первого растра. */
  readonly pages: readonly PreviewPageSize[];
  /**
   * Что из вёрстки не попадёт в скачанный PDF (вид примитива → сколько раз).
   *
   * Предпросмотр рисует движок, который умеет больше нашего экспортёра,
   * поэтому расхождение возможно — и о нём честнее сказать до скачивания.
   */
  readonly skipped: SkippedPrimitives;
  /**
   * Растр страницы.
   *
   * @param pageIndex - номер страницы с нуля
   * @param scale - во сколько раз увеличить страницу (dpr × зум панели);
   *   потолок ставит сессия, чтобы растр не съел память вкладки
   * @returns растр или `null`, если сессия уже закрыта
   */
  render(pageIndex: number, scale: number): Promise<ImageBitmap | null>;
  /** Закрывает документ. Повторный вызов ничего не делает. */
  close(): void;
}

/**
 * Открывает документ для предпросмотра.
 *
 * @param input - байты файла, его имя и параметры (те же, что у конвертации)
 * @returns сессию предпросмотра
 */
export async function openPreview(input: ConvertInput): Promise<PreviewSession> {
  const format = browserFormatOf(input.fileName);

  if (format === null) {
    throw new EngineError('engine_unsupported', `формат не поддержан: ${input.fileName}`);
  }

  // Параметры проверяются теми же словами, что и у конвертации: предпросмотр
  // обещает те же страницы, что скачаются, и отвергать их по-разному нельзя
  assertSupported(input.options);

  try {
    return format === 'docx'
      ? await openDocxSession(input.bytes)
      : await openXlsxSession(input.bytes, input.options);
  } catch (error) {
    if (error instanceof EngineError) {
      throw error;
    }

    throw new EngineError(
      'engine_convert_failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Готовит сессию документа Word.
 *
 * @param bytes - байты DOCX
 * @returns сессия
 */
async function openDocxSession(bytes: Uint8Array): Promise<PreviewSession> {
  const canvasFonts = createCanvasFonts();
  const rendered = await renderDocx(bytes, { canvasFonts });
  const displayList = rendered.displayList;

  // Обводки глифов берутся из того же хранилища, которое наполнила вёрстка.
  //
  // Пустой контур здесь — не ошибка: у пробела и других невидимых знаков
  // контуров нет вовсе, и рендерер движка так и должен их пропускать. Ловит
  // он при этом только исключения — промах по номеру шрифта, — и уходит
  // на рисование строкой
  const glyphCache = new GlyphCache({ provider: await loadGlyphOutlineProvider() });
  const resolveImage = createImageResolver();

  return sessionOf({
    sheets: null,
    skipped: countUnsupported(displayList.pages),
    pages: displayList.pages.map((page) => ({ width: page.width, height: page.height })),
    render: async (pageIndex, scale) => {
      const page = displayList.pages[pageIndex];

      if (page === undefined) {
        throw new EngineError('engine_convert_failed', `в документе нет страницы ${pageIndex + 1}`);
      }

      // Приведение: страницы — те же объекты, что построил движок. Наш
      // `shapeTextRuns` их копирует, сохраняя и поля, которых нет в наших
      // типах (рамки страниц, сноски), и номера шрифтов из его хранилища.
      // Оговорка та же, что у экспортёра: типы движка лежат во внутренних
      // чанках сборки, поэтому описываем потребляемое, а стык проверяем тут
      return rasterizeDocxPage(
        page as Parameters<typeof rasterizeDocxPage>[0],
        scale,
        { glyphCache, resolveImage }
      );
    },
  });
}

/**
 * Готовит сессию книги.
 *
 * @param bytes - байты XLSX
 * @param options - параметры конвертации
 * @returns сессия
 */
async function openXlsxSession(
  bytes: Uint8Array,
  options: ConversionOptions
): Promise<PreviewSession> {
  const opened = await openXlsxPlan(bytes, { fitToOnePage: options.fitToOnePage });
  const canvasFonts = createCanvasFonts();
  const resolveImage = createImageResolver();

  const pages = opened.pages.map((plan: XlsxPagePlan) => ({
    width: plan.paper.width,
    height: plan.paper.height,
  }));

  return sessionOf({
    pages,
    sheets: opened.sheets,
    // Пропущенного у книги нет: страница рисуется теми же четырьмя командами
    // движка (`fillRect`, `line`, `path`, `text`), которые разбирает наш
    // переводчик, и картинками, которые ставим мы сами
    skipped: {},
    render: async (pageIndex, scale) => {
      const plan = opened.pages[pageIndex];

      if (plan === undefined) {
        throw new EngineError('engine_convert_failed', `в книге нет страницы ${pageIndex + 1}`);
      }

      const frame = pageFrame(opened, pageIndex);

      // Canvas рисует текст вызовом `fillText`, а он идёт системным шрифтом,
      // если нужного начертания нет в наборе воркера: тогда выравнивание
      // и обрезка по ячейке разъедутся с PDF
      await registerFrameFonts(canvasFonts, frame, opened);

      return rasterizeXlsxPage(
        frame,
        { paper: plan.paper, margins: plan.margins, scale: plan.scale },
        scale,
        pageImages(opened, pageIndex),
        resolveImage
      );
    },
    close: () => {
      opened.workbook.dispose();
    },
  });
}

/**
 * Регистрирует в canvas начертания, которыми набран display list книги.
 *
 * Семейства берутся из самих команд: движок называет в них семейство
 * и начертание, и регистрировать весь набор поставки значило бы качать
 * десятки мегабайт ради одной страницы.
 *
 * @param canvasFonts - реестр шрифтов canvas
 * @param frame - печатный display list диапазона
 * @param opened - открытая книга: из неё берётся семейство по умолчанию
 */
async function registerFrameFonts(
  canvasFonts: CanvasFonts,
  frame: Parameters<typeof rasterizeXlsxPage>[0],
  opened: OpenedXlsx
): Promise<void> {
  for (const command of frame.commands) {
    if (command.op !== 'text') {
      continue;
    }

    await canvasFonts.ensure(
      command.fontFamily ?? opened.defaults.fontFamily,
      command.bold === true,
      command.italic === true
    );
  }
}

/**
 * Собирает сессию из её частей.
 *
 * Общая часть — то, что не зависит от формата: счётчик закрытий, потолок
 * масштаба и отказ там, где растеризовать нечем.
 *
 * @param parts - страницы, число листов, пропущенное, отрисовка и освобождение
 * @returns сессия
 */
function sessionOf(parts: {
  readonly pages: readonly PreviewPageSize[];
  readonly sheets: number | null;
  readonly skipped: SkippedPrimitives;
  readonly render: (pageIndex: number, scale: number) => Promise<ImageBitmap>;
  readonly close?: () => void;
}): PreviewSession {
  let closed = false;

  return {
    pageCount: parts.pages.length,
    sheets: parts.sheets,
    pages: parts.pages,
    skipped: parts.skipped,

    async render(pageIndex: number, scale: number): Promise<ImageBitmap | null> {
      if (closed) {
        // Сессию закрыли, пока запрос был в пути: растр никому не нужен,
        // и рисовать его — лишняя работа воркера
        return null;
      }

      // Порядок проверок важен: «такой страницы нет» — ошибка вызывающего,
      // и она одна и та же в любом окружении, а «рисовать нечем» — свойство
      // среды. Сказать про страницу раньше честнее: в Node иначе любой
      // запрос выглядел бы отказом окружения
      const page = parts.pages[pageIndex];

      if (page === undefined) {
        throw new EngineError('engine_convert_failed', `в документе нет страницы ${pageIndex + 1}`);
      }

      if (!supportsRaster()) {
        throw new EngineError(
          'engine_unsupported',
          'предпросмотр страниц доступен только в браузере'
        );
      }

      return parts.render(pageIndex, pageScale(page, scale));
    },

    close(): void {
      if (closed) {
        return;
      }

      closed = true;
      parts.close?.();
    },
  };
}

/**
 * Ограничивает масштаб растра.
 *
 * Панель просит масштаб по устройству экрана и зуму, а растр — это память
 * вкладки: страница A4 при масштабе 2 занимает около 20 МБ, и просьба
 * «покажи крупнее» не должна стоить сотен мегабайт. Поэтому масштаб
 * ограничен и сверху, и по площади страницы.
 *
 * @param page - размеры страницы в пикселях CSS
 * @param requested - запрошенный масштаб
 * @returns допустимый масштаб
 */
function pageScale(page: PreviewPageSize, requested: number): number {
  const area = page.width * page.height;
  const byArea = area > 0 ? Math.sqrt(PREVIEW_MAX_PAGE_PIXELS / area) : PREVIEW_MAX_SCALE;

  return Math.max(1, Math.min(requested, PREVIEW_MAX_SCALE, byArea));
}
