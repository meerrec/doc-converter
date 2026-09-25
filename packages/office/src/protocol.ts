/**
 * Протокол обмена между страницей и офисом в воркере.
 *
 * Обмен идёт по `MessageChannel`, который создаёт сама сборка: UNO живёт
 * в воркере, и обратиться к нему из главного потока можно только сообщением.
 * Сообщения проходят `structuredClone`, поэтому передаются только простые
 * значения: пути в виртуальной файловой системе и параметры экспорта.
 * Содержимое документа идёт **мимо протокола** — через общую файловую систему
 * сборки (`FS`), иначе каждый документ копировался бы в сообщение целиком.
 *
 * Коды ошибок свои, а не из серверного контракта: причины отказа здесь иные
 * (модуль не загрузился, вкладке не хватило памяти), и общий список заставлял
 * бы клиента ждать от одного пути того, что бывает только в другом. Серверный
 * контракт при этом не меняется.
 *
 * Гарды рукописные и без zod: входящее сообщение проверяется целиком, и это
 * единственное место, где данные приходят из другого потока. Схему сюда
 * добавлять нельзя — валидатор весит четверть клиентского бандла, а нужен он
 * только серверу.
 *
 * Все комментарии на русском языке.
 */

import type { FilterDataEntry } from './filterData';

/**
 * Коды отказов браузерного пути.
 *
 * `lowa_oom` отделён от прочих намеренно: исчерпание памяти — единственный
 * отказ, который пользователь может обойти, выбрав документ меньше, и это
 * стоит показать отдельной подсказкой.
 */
export const LOCAL_ERROR_CODES = [
  /** Сборка не загрузилась или не инициализировалась. */
  'lowa_boot_failed',
  /** Документ не открылся (неподдерживаемый формат, повреждённый файл). */
  'lowa_load_failed',
  /** Экспорт PDF не удался. */
  'lowa_export_failed',
  /** Исчерпана память вкладки. */
  'lowa_oom',
  /** Операция не уложилась в таймаут. */
  'lowa_timeout',
  /** Офис в воркере недоступен (упал или ещё не готов). */
  'lowa_unavailable',
] as const;

/** Код отказа браузерного пути. */
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

// ===========================================================================
// Запросы: страница → офис
// ===========================================================================

/** Общая часть запроса: по `id` ответ связывается с ожиданием. */
interface RequestBase {
  readonly id: number;
}

/**
 * Задание на конвертацию.
 *
 * `filterData` передаётся готовым списком пар, а не параметрами интерфейса:
 * сборка `FilterData` — чистая функция на стороне страницы (см. `filterData.ts`),
 * и она же сверяется с серверным списком в тестах. Воркеру остаётся
 * превратить пары в последовательность UNO.
 */
export interface ConvertRequest extends RequestBase {
  readonly kind: 'convert';
  /** Путь входного документа в виртуальной файловой системе. */
  readonly source: string;
  /** Путь результата там же. */
  readonly target: string;
  /** Имя фильтра экспорта: `calc_pdf_Export` или `writer_pdf_Export`. */
  readonly filterName: string;
  readonly filterData: readonly FilterDataEntry[];
  /**
   * Подгонка под одну страницу (`ScaleToPages`).
   *
   * Применяется только к книге: у текстового документа свойства страничного
   * стиля называются иначе, и серверный путь тоже правит их только для Calc.
   */
  readonly scaleToPages: boolean;
}

/** Открыть документ для предпросмотра: в окне, а не скрыто. */
export interface PreviewRequest extends RequestBase {
  readonly kind: 'preview';
  readonly source: string;
}

/** Закрыть открытый документ, освободив память. */
export interface CloseRequest extends RequestBase {
  readonly kind: 'close';
}

/**
 * Текущий размер линейной памяти сборки.
 *
 * Нужен не для работы, а для проверок: утечка памяти между задачами —
 * причина, по которой проект однажды отказался от WASM, и следить за ней
 * нужно на живой странице, а не только в отчёте прогона.
 */
export interface MemoryRequest extends RequestBase {
  readonly kind: 'memory';
}

/** Запрос страницы к офису. */
export type BridgeRequest =
  | ConvertRequest
  | PreviewRequest
  | CloseRequest
  | MemoryRequest;

/**
 * Запрос без идентификатора: его присваивает сессия при отправке.
 *
 * Идентификатор не задаётся вызывающим намеренно: он связывает ответ
 * с ожиданием, и второй источник нумерации рано или поздно дал бы
 * совпадение или пропуск.
 */
export type BridgeCall =
  | Omit<ConvertRequest, 'id'>
  | Omit<PreviewRequest, 'id'>
  | Omit<CloseRequest, 'id'>
  | Omit<MemoryRequest, 'id'>;

// ===========================================================================
// Ответы: офис → страница
// ===========================================================================

/** Офис готов принимать запросы. */
export interface ReadyResponse {
  readonly kind: 'ready';
}

/** Результат открытия документа. */
export interface PreviewResult {
  /** Число листов книги; у текстового документа — null. */
  readonly sheets: number | null;
}

/** Результат замера памяти. */
export interface MemoryResult {
  /** Размер линейной памяти WASM в байтах. */
  readonly heapBytes: number;
}

/**
 * Результат запроса: зависит от того, что запрашивалось.
 *
 * У конвертации результата нет намеренно. Готовый PDF лежит в файловой
 * системе сборки, и читает его страница — у воркера своей файловой системы
 * нет, размер ему взять неоткуда, а возвращать «сколько-то байт» значило бы
 * пересказывать то, что страница и так увидит, когда возьмёт файл.
 */
export type BridgeResult = PreviewResult | MemoryResult | null;

/** Успешное завершение запроса. */
export interface DoneResponse {
  readonly kind: 'done';
  readonly id: number;
  readonly result: BridgeResult;
}

/** Отказ. */
export interface FailedResponse {
  readonly kind: 'failed';
  readonly id: number;
  readonly code: LocalErrorCode;
  readonly message: string;
}

/** Ответ офиса странице. */
export type BridgeResponse = ReadyResponse | DoneResponse | FailedResponse;

// ===========================================================================
// Гарды
// ===========================================================================

/**
 * Проверяет, что значение — неотрицательное целое число.
 *
 * @param value - проверяемое значение
 * @returns true, если это неотрицательное целое
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Проверяет, что значение — один из кодов отказа.
 *
 * @param value - проверяемое значение
 * @returns true, если код известен
 */
function isLocalErrorCode(value: unknown): value is LocalErrorCode {
  return (
    typeof value === 'string' &&
    (LOCAL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Проверяет, что сообщение — ответ офиса.
 *
 * Проверка нужна обеим сторонам: страница отбрасывает чужие сообщения,
 * пришедшие в порт, а не доверяет форме пришедшего. Сообщение с чужого порта
 * или изменившийся формат иначе привели бы к обращению к полям `undefined`.
 *
 * @param value - значение из события порта
 * @returns true, если это ответ офиса
 */
export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  switch (message['kind']) {
    case 'ready':
      return true;
    case 'done':
      return isNonNegativeInteger(message['id']);
    case 'failed':
      return (
        isNonNegativeInteger(message['id']) &&
        isLocalErrorCode(message['code']) &&
        typeof message['message'] === 'string'
      );
    default:
      return false;
  }
}

/**
 * Проверяет, что сообщение — запрос страницы.
 *
 * @param value - значение из события порта
 * @returns true, если это запрос к офису
 */
export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (!isNonNegativeInteger(message['id'])) {
    return false;
  }

  switch (message['kind']) {
    case 'convert':
      return (
        typeof message['source'] === 'string' &&
        typeof message['target'] === 'string' &&
        typeof message['filterName'] === 'string' &&
        Array.isArray(message['filterData']) &&
        typeof message['scaleToPages'] === 'boolean'
      );
    case 'preview':
      return typeof message['source'] === 'string';
    case 'close':
    case 'memory':
      return true;
    default:
      return false;
  }
}
