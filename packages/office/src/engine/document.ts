/**
 * Прогон документа через движок: файл → вёрстка и примитивы отрисовки.
 *
 * Здесь один шаг конвейера: открыть пакет, зарегистрировать шрифты, разложить
 * документ по страницам, получить display list. Ни PDF, ни страницы, ни
 * воркера этот модуль не знает — на входе байты, на выходе примитивы.
 *
 * Порядок шагов не переставляется: требования к шрифтам движок отдаёт только
 * по открытому документу, а layout считается уже против зарегистрированных
 * шрифтов. Поэтому регистрация стоит между открытием и вёрсткой.
 *
 * Все комментарии на русском языке.
 */

import { buildResidentRegionLayoutRequest, computeLayout, getLayoutKernelInputs } from '@betteroffice/docx/editor';
import { configureDefaultFonts, getRustTextEngine, type ResidentMeasurementConfig } from '@betteroffice/docx/layout';
import { buildRustDisplayList } from '@betteroffice/docx/layout/render';
import * as bundledFonts from '@betteroffice/fonts';
import { createYrsSession } from '@betteroffice/docx/yrs';
import type { CanvasFonts } from './canvas-fonts.js';
import { registerFonts, type FontProvider, type FontRequirement } from './fonts.js';
import { shapeTextRuns } from './textRuns.js';
import type { DisplayList, FontResource } from '../pdf/types.js';

/** Результат прогона: то, из чего собирается PDF. */
export interface RenderedDocument {
  /** Вёрстка: страницы с примитивами. */
  readonly displayList: DisplayList;
  /** Шрифты по номерам, которыми их называет display list. */
  readonly fonts: Map<number, FontResource>;
  readonly pageCount: number;
}

/**
 * Настраивает движок на встроенный набор шрифтов.
 *
 * Вызывается один раз на страницу: настройка живёт в модуле движка глобально,
 * а повторный вызов сбрасывает её и заново разрешает провайдера.
 */
let configured = false;

/** Готовит движок к работе. */
function configureOnce(): void {
  if (configured) {
    return;
  }

  configureDefaultFonts({ fonts: bundledFonts });
  configured = true;
}

/** Что нужно прогону, кроме самого файла. */
export interface RenderDocxOptions {
  /**
   * Реестр шрифтов canvas.
   *
   * Нужен предпросмотру: номера пунктов списка и всё, что не удалось
   * разложить на глифы, рисуется строкой, а для этого начертание должно быть
   * зарегистрировано в окружении. Экспортёру PDF он не нужен — тот рисует
   * глифами.
   */
  readonly canvasFonts?: CanvasFonts;
}

/**
 * Раскладывает документ Word и отдаёт примитивы отрисовки.
 *
 * @param bytes - байты файла DOCX
 * @param options - шрифты canvas, если документ готовится к предпросмотру
 * @returns вёрстка и шрифты
 */
export async function renderDocx(
  bytes: Uint8Array,
  options: RenderDocxOptions = {}
): Promise<RenderedDocument> {
  configureOnce();

  const provider = bundledFonts.createFontProvider() as FontProvider;
  const session = await createYrsSession({ clientId: 1 });
  const { document } = session.openDocx(bytes, true);

  const renderEnv = {
    themeColors: {},
    defaultTabStopTwips: document?.package?.settings?.defaultTabStop ?? null,
    numericIds: {},
    showHiddenText: false,
  };

  const request = buildResidentRegionLayoutRequest(document, 0, renderEnv);
  const requirements = JSON.parse(
    session.layoutFontRequirementsJson(JSON.stringify(request))
  ) as FontRequirement[];

  // Одни и те же байты ложатся в два хранилища: сессии — для раскладки строк,
  // движка отрисовки — для глифов. Нумерация у них своя, и подмена одной
  // другой работает лишь до второго документа: у него номера расходятся,
  // и вёрстка теряет переносы (проверено на документе с таблицами)
  const engine = await getRustTextEngine();
  const registry = await registerFonts({ layout: session, render: engine }, provider, requirements);
  const { chains, layoutChains } = registry;

  const measurement: ResidentMeasurementConfig = {
    fontChains: layoutChains,
    defaults: { fontSize: 11, fontFamily: 'Calibri' },
    compat: {
      noLeading: document?.package?.settings?.compatibilityFlags?.noLeading ?? false,
      doNotExpandShiftReturn: document?.package?.settings?.compatibilityFlags?.doNotExpandShiftReturn ?? false,
    },
    // `true` — не флаг «включить», а утверждение: меру считает движок.
    // С ним прогоны приходят глифами; без него каждый прогон — примитив
    // `text` без глифов, и текста в PDF не будет вовсе
    authoritativeShaping: true,
  };

  const { layout } = computeLayout({ document, pageGap: 0, session, renderEnv, measurement });
  const kernel = getLayoutKernelInputs(layout);

  // Без измеренной основы примитивы не собрать: `measured` — вход сборщика,
  // а не подсказка. Пустая вёрстка здесь означала бы пустой PDF, поэтому
  // отказ громкий
  if (kernel === undefined) {
    throw new Error('движок не отдал измеренную основу вёрстки');
  }

  const built = await buildRustDisplayList({ ...kernel, layout, fontChains: chains });

  // Присваивание с явным типом — это и есть проверка стыка: если движок
  // переименует поле в примитивах, ошибка будет здесь, а не в пустом PDF
  const engineList: DisplayList = built;

  // Номера пунктов списка движок отдаёт строкой: он не разложил их сам,
  // а в PDF текст уходит глифами. Раскладка идёт до экспортёра и до
  // предпросмотра — оба должны видеть одну и ту же вёрстку
  const displayList = await shapeTextRuns(engineList, registry, options.canvasFonts);

  return { displayList, fonts: registry.files, pageCount: displayList.pages.length };
}
