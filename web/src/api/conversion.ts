/**
 * Обращение к эндпоинтам конвертации.
 *
 * Интерфейс всегда работает в асинхронном режиме (async: true): синхронный
 * путь на сервере не сохраняет файл результата, поэтому скачать его было бы
 * нельзя. Постановка в очередь возвращает taskId, а готовность отслеживается
 * опросом GET /status.
 */

import { request, UPLOAD_TIMEOUT_MS } from './client';
import { STATUS_BATCH_SIZE } from '../config';
import type {
  ConversionAcceptedResponse,
  ConversionOptions,
  ConversionRequest,
  TaskStatusResponse,
  BatchStatusResponse,
} from './types';

/** Параметры постановки задачи в очередь. */
export interface SubmitParams {
  taskId: string;
  filetype: string;
  outputtype: string;
  /** Содержимое файла в base64. */
  data: string;
  /** Имя файла — уходит в title для отображения в метаданных задачи. */
  title?: string;
  options?: ConversionOptions;
}

/**
 * Убирает из опций пустые значения.
 *
 * Сервер отвергает null и пустые строки для объектных и строковых полей
 * (field_type_mismatch / region_invalid), поэтому незаполненные поля
 * не отправляются вовсе.
 *
 * @param options - опции конвертации
 * @returns объект только с заполненными полями
 */
function compactOptions(options: ConversionOptions): ConversionOptions {
  const result: ConversionOptions = {};

  if (typeof options.codePage === 'number') {
    result.codePage = options.codePage;
  }

  if (typeof options.delimiter === 'number') {
    result.delimiter = options.delimiter;
  }

  if (typeof options.region === 'string' && options.region.trim() !== '') {
    result.region = options.region.trim();
  }

  if (typeof options.password === 'string' && options.password !== '') {
    result.password = options.password;
  }

  if (options.documentLayout && Object.keys(options.documentLayout).length > 0) {
    result.documentLayout = options.documentLayout;
  }

  if (options.spreadsheetLayout && Object.keys(options.spreadsheetLayout).length > 0) {
    result.spreadsheetLayout = options.spreadsheetLayout;
  }

  return result;
}

/**
 * Ставит задачу конвертации в очередь.
 *
 * @param params - параметры задачи
 * @param signal - сигнал отмены
 * @returns ответ сервера с идентификатором задачи
 * @throws {ApiError} - если сервер отклонил запрос
 */
export async function submitConversion(
  params: SubmitParams,
  signal?: AbortSignal
): Promise<ConversionAcceptedResponse> {
  const body: ConversionRequest = {
    filetype: params.filetype,
    outputtype: params.outputtype,
    data: params.data,
    key: params.taskId,
    async: true,
    ...(params.title ? { title: params.title.slice(0, 255) } : {}),
    ...compactOptions(params.options ?? {}),
  };

  return request<ConversionAcceptedResponse>('/ConvertService.ashx', {
    method: 'POST',
    body,
    signal,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/**
 * Запрашивает статусы задач одной пачкой.
 *
 * Один запрос на всю пачку вместо запроса на задачу: каждый HTTP-запрос
 * расходует общий лимит частоты, поэтому пакетный опрос экономит бюджет
 * пропорционально числу активных задач.
 *
 * @param taskIds - идентификаторы задач
 * @param signal - сигнал отмены
 * @returns статусы задач (порядок соответствует серверному)
 */
export async function fetchStatuses(
  taskIds: string[],
  signal?: AbortSignal
): Promise<TaskStatusResponse[]> {
  if (taskIds.length === 0) {
    return [];
  }

  const results: TaskStatusResponse[] = [];

  for (let offset = 0; offset < taskIds.length; offset += STATUS_BATCH_SIZE) {
    const chunk = taskIds.slice(offset, offset + STATUS_BATCH_SIZE);
    const query = chunk.map((id) => `taskIds=${encodeURIComponent(id)}`).join('&');

    const response = await request<BatchStatusResponse>(`/status?${query}`, { signal });

    results.push(...response.tasks);
  }

  return results;
}

/**
 * Запрашивает статус одной задачи.
 *
 * @param taskId - идентификатор задачи
 * @param signal - сигнал отмены
 * @returns статус задачи
 */
export async function fetchStatus(
  taskId: string,
  signal?: AbortSignal
): Promise<TaskStatusResponse> {
  return request<TaskStatusResponse>(`/status/${encodeURIComponent(taskId)}`, { signal });
}
