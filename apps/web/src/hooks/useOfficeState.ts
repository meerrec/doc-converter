/**
 * Состояние офиса в браузере.
 *
 * Загрузка офиса — процесс длительный и асинхронный (десятки мегабайт файлов
 * сборки, затем старт), и знать о нём нужно не только тому, кто её запустил:
 * панель офиса показывает ход загрузки, а кнопки строк — доступность
 * браузерного маршрута.
 *
 * `useSyncExternalStore`, а не `useState` с подпиской: состояние живёт
 * в движке, вне React, и подписка на него — ровно тот случай, для которого
 * этот хук и предназначен. Он же снимает подписку при размонтировании.
 */

import { useSyncExternalStore } from 'react';
import { officeState, subscribeOffice, type OfficeState } from '@doc-converter/office';

/**
 * Подписывается на состояние офиса.
 *
 * @returns текущее состояние
 */
export function useOfficeState(): OfficeState {
  return useSyncExternalStore(subscribeOffice, officeState);
}
