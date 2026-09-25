/**
 * Офис на этой странице: адреса его файлов и запуск.
 *
 * Единственное место, где движок (`@doc-converter/office`) встречается
 * с адресами конкретной страницы. Движок адресов не знает — они приходят
 * параметрами, и это не формальность: те же файлы в проде отдаёт nginx,
 * в dev-режиме — плагин (`dev/office-dev.ts`), а движок остаётся переносимым.
 *
 * Canvas ищется в документе по идентификатору, который задан не нами: его
 * требует Qt-бэкенд сборки. Элемент обязан существовать к моменту запуска —
 * сборка ищет его при инициализации, и созданный позже до неё не дойдёт.
 * Поэтому он лежит в `index.html`, а не в разметке React.
 */

import { ensureOffice, type LocalSession } from '@doc-converter/office';

/** Каталог файлов сборки LibreOffice (в проде — локация nginx). */
const ASSETS_URL = '/lowa/';

/** Обвязка UNO: перенесённый код allotropia. */
const RUNTIME_URL = '/uno/runtime.js';

/** Мост: собирается из исходников пакета (`vite.bridge.config.ts`). */
const BRIDGE_URL = '/bridge.js';

/** Идентификатор canvas, которого ждёт сборка. */
const CANVAS_ID = 'qtcanvas';

/**
 * Запускает офис и возвращает сессию.
 *
 * Запуск мемоизирован в движке: повторный вызов вернёт ту же сессию,
 * а не поднимет вторую сборку.
 *
 * @returns сессия офиса
 */
export function openOffice(): Promise<LocalSession> {
  const canvas = document.getElementById(CANVAS_ID);

  if (!(canvas instanceof HTMLCanvasElement)) {
    return Promise.reject(new Error(`в документе нет canvas #${CANVAS_ID}`));
  }

  return ensureOffice({
    canvas,
    assetsUrl: ASSETS_URL,
    runtimeUrl: RUNTIME_URL,
    bridgeUrl: BRIDGE_URL,
  });
}
