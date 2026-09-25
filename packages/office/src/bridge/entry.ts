/**
 * Точка входа офиса в воркере: приём запросов страницы и ответы на них.
 *
 * Этот файл собирается отдельным бандлом (IIFE) и передаётся сборке в списке
 * `Module.uno_scripts` — то есть исполняется в том же воркере, что и UNO,
 * после перенесённой обвязки. Отсюда и разделение: `office.ts` знает про UNO,
 * а здесь только транспорт — порт, проверка входящих сообщений и превращение
 * исключений в коды отказов.
 *
 * Обмен односторонний по инициативе: страница присылает запрос, офис отвечает
 * `done` или `failed`. Уведомлений от офиса по своей инициативе нет — фоновых
 * операций у него тоже нет, а всё, что происходит само (перерисовка окна),
 * происходит внутри сборки.
 *
 * Все комментарии на русском языке.
 */

import { Office, OfficeError } from './office.js';
import { isBridgeRequest } from '../protocol.js';
import type { BridgeRequest, BridgeResponse, LocalErrorCode } from '../protocol.js';
import type { LowaModule, Zetajs } from '../types.js';

/**
 * Признак исчерпания памяти в сообщении сборки.
 *
 * Отдельного кода ошибки у WASM-модуля нет: исчерпание памяти приходит либо
 * исключением JS при попытке вырастить память, либо через `abort()`. Тексты
 * этих сообщений и перечислены — других способов отличить нехватку памяти
 * от прочих отказов у нас нет.
 */
const OUT_OF_MEMORY_PATTERN = /out of memory|oom|maximum memory|cannot enlarge memory/i;

const module: LowaModule | undefined = globalThis.Module;

/**
 * Приводит исключение к тексту для журнала страницы.
 *
 * @param error - пойманное исключение
 * @returns описание
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Определяет код отказа.
 *
 * Ошибки операций приходят с кодом от `Office`; всё остальное — либо нехватка
 * памяти, либо сбой, о котором известно только то, на какой операции он
 * случился.
 *
 * @param error - пойманное исключение
 * @param kind - операция, во время которой произошёл отказ
 * @returns код отказа
 */
function classify(error: unknown, kind: BridgeRequest['kind']): LocalErrorCode {
  if (error instanceof OfficeError) {
    return error.code;
  }

  if (OUT_OF_MEMORY_PATTERN.test(describe(error))) {
    return 'lowa_oom';
  }

  switch (kind) {
    case 'convert':
      return 'lowa_export_failed';
    case 'preview':
      return 'lowa_load_failed';
    default:
      return 'lowa_unavailable';
  }
}

/**
 * Выполняет запрос страницы.
 *
 * @param office - офис в воркере
 * @param request - запрос
 * @returns ответ для страницы
 */
function handle(office: Office, request: BridgeRequest): BridgeResponse {
  try {
    switch (request.kind) {
      case 'convert':
        return { kind: 'done', id: request.id, result: office.convert(request) };
      case 'preview':
        return { kind: 'done', id: request.id, result: office.preview(request.source) };
      case 'close':
        return { kind: 'done', id: request.id, result: office.close() };
      case 'memory':
        return { kind: 'done', id: request.id, result: office.memory() };
    }
  } catch (error) {
    return {
      kind: 'failed',
      id: request.id,
      code: classify(error, request.kind),
      message: describe(error),
    };
  }
}

/**
 * Начинает обслуживание запросов.
 *
 * @param zetajs - обвязка UNO
 * @param lowaModule - сборка
 */
function start(zetajs: Zetajs, lowaModule: LowaModule): void {
  const port = zetajs.mainPort;
  const office = new Office(zetajs, lowaModule);

  port.onmessage = (event: MessageEvent) => {
    const request: unknown = event.data;

    // Чужое сообщение отбрасывается молча, но не игнорируется: в порт может
    // писать и сама сборка, а падать на незнакомом формате значило бы
    // останавливать офис из-за служебного сообщения
    if (!isBridgeRequest(request)) {
      return;
    }

    port.postMessage(handle(office, request));
  };

  port.postMessage({ kind: 'ready' } satisfies BridgeResponse);
}

if (module?.zetajs === undefined) {
  // Скрипт попадает в воркер только через `uno_scripts`, и там `Module`
  // уже существует. Его отсутствие означает, что бандл подключили не тем
  // способом, — сообщить об этом странице некому, потому что порта тоже нет
  throw new Error('bridge: Module.zetajs недоступен — скрипт запущен вне сборки');
} else {
  module.zetajs
    .then((zetajs) => start(zetajs, module))
    .catch((error: unknown) => {
      // Обвязка не создалась: сообщить странице нечего, её ждёт таймаут
      // готовности, а причина остаётся в журнале воркера
      console.error('bridge: обвязка UNO не создана:', describe(error));
    });
}
