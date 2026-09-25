/**
 * Ресурс «офис»: запуск сборки и наблюдение за ней.
 *
 * Это единственная точка запуска, и она мемоизирована. Причина не в экономии
 * загрузки: сборка инициализирует модуль и создаёт воркер, а второй запуск
 * в том же документе дал бы вторую копию — то есть удвоенную память вкладки
 * (линейная память сборки — 1 ГБ). Поэтому провал запуска терминален: сбросить
 * промис значило бы разрешить повторный запуск в документе, где уже могла
 * остаться половина первого.
 *
 * Состояние отдаётся подпиской, а не возвратом промиса: загрузка длится
 * заметное время и состоит из этапов (файлы сборки качаются по байтам, потом
 * сборка стартует), а знать о них нужно и тому, кто запуск не инициировал.
 *
 * Все комментарии на русском языке.
 */

import { boot } from './boot.js';
import { preloadAssets } from './preload.js';
import type { LocalSession } from './session.js';

/** Что нужно сборке, чтобы загрузиться. */
export interface OfficeAssets {
  /** Canvas, в котором сборка рисует окно офиса (уже в документе). */
  readonly canvas: HTMLCanvasElement;
  /** Каталог файлов сборки. */
  readonly assetsUrl: string;
  /** Адрес перенесённой обвязки UNO. */
  readonly runtimeUrl: string;
  /** Адрес собранного моста. */
  readonly bridgeUrl: string;
}

/**
 * Состояние офиса.
 *
 * `failed` — терминальное: сборку в этом документе запустить заново нельзя,
 * и задачам нужно отказать сразу, а не ждать `BOOT_TIMEOUT_MS`.
 */
export type OfficeState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'loading';
      readonly loadedBytes: number;
      readonly totalBytes: number | null;
    }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string };

/** Начатая загрузка: одна на документ. */
let pending: Promise<LocalSession> | null = null;

/** Последнее состояние: его получает каждый новый подписчик. */
let state: OfficeState = { kind: 'idle' };

/** Подписчики состояния. */
const listeners = new Set<(state: OfficeState) => void>();

/**
 * Заменяет состояние и оповещает подписчиков.
 *
 * @param next - новое состояние
 */
function setState(next: OfficeState): void {
  state = next;

  for (const listener of listeners) {
    listener(state);
  }
}

/**
 * Подписывается на состояние офиса.
 *
 * Подписчику сразу приходит текущее состояние: иначе тот, кто подписался
 * после запуска, не узнал бы ни о готовности, ни о провале.
 *
 * @param listener - вызывается при каждом изменении
 * @returns отмена подписки
 */
export function subscribeOffice(listener: (state: OfficeState) => void): () => void {
  listeners.add(listener);
  listener(state);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Возвращает текущее состояние офиса.
 *
 * @returns состояние
 */
export function officeState(): OfficeState {
  return state;
}

/**
 * Загружает сборку и возвращает сессию офиса.
 *
 * @param assets - canvas и адреса файлов сборки
 * @returns сессия; при провале запуска — отклонённый промис
 */
export function ensureOffice(assets: OfficeAssets): Promise<LocalSession> {
  pending ??= start(assets);

  return pending;
}

/**
 * Выполняет загрузку: файлы сборки, затем старт.
 *
 * @param assets - canvas и адреса
 * @returns готовая сессия
 */
async function start(assets: OfficeAssets): Promise<LocalSession> {
  try {
    setState({ kind: 'loading', loadedBytes: 0, totalBytes: null });

    const files = await preloadAssets(assets.assetsUrl, (progress) => {
      setState({ kind: 'loading', ...progress });
    });

    const session = await boot({ ...assets, assets: files });

    setState({ kind: 'ready' });

    return session;
  } catch (error) {
    // Провал терминален: повторный запуск в том же документе дал бы вторую
    // копию модуля, поэтому состояние остаётся `failed` до перезагрузки
    setState({
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}
