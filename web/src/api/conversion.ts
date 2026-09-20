/**
 * Обращение к эндпоинтам конвертации XLSX → PDF.
 *
 * Постановка задачи — `POST /convert/xlsx-to-pdf` с файлом в multipart/form-data;
 * файл уходит телом запроса, а не в base64, поэтому кодировать его в памяти
 * вкладки больше не нужно. Идентификатор задачи выдаёт сервер: клиент его
 * не придумывает и не может переиспользовать (как было с полем `key`,
 * на котором держалась идемпотентность старого API).
 */

import { convertAcceptedSchema, jobStatusResponseSchema } from '@doc-converter/contract';
import type {
  ConversionOptions,
  ConvertAccepted,
  JobStatusResponse,
} from '@doc-converter/contract';
import { request, UPLOAD_TIMEOUT_MS } from './client';
import { STATUS_CONCURRENCY, STATUS_MIN_INTERVAL_MS } from '../config';
import { createLimiter } from '../lib/limiter';

/** Параметры постановки задачи. */
export interface SubmitParams {
  /** Исходная книга Excel. */
  file: File;
  /** Параметры конвертации. */
  options: ConversionOptions;
}

/**
 * Собирает тело multipart-запроса.
 *
 * Поля multipart — строки, поэтому числа и булевы значения приводятся
 * к строкам: сервер разбирает их схемой контракта (`booleanField`
 * и `integerField`).
 *
 * Пустые необязательные строки не отправляются вовсе: пустой водяной знак
 * сервер принял бы как значение, а пустой пароль — как пароль из нуля
 * символов, то есть PDF оказался бы защищённым «никаким» паролем.
 *
 * @param params - файл и параметры конвертации
 * @returns тело запроса
 */
export function buildConversionForm(params: SubmitParams): FormData {
  const { file, options } = params;
  const form = new FormData();

  form.append('file', file, file.name);

  const watermark = options.watermark?.trim() ?? '';

  if (watermark !== '') {
    form.append('watermark', watermark);
  }

  form.append('watermarkMode', options.watermarkMode);
  form.append('fitToOnePage', String(options.fitToOnePage));
  form.append('pdfVersion', options.pdfVersion);
  form.append('quality', String(options.quality));
  form.append('reduceImageResolution', String(options.reduceImageResolution));
  form.append('maxImageResolution', String(options.maxImageResolution));
  form.append('exportBookmarks', String(options.exportBookmarks));
  form.append('taggedPdf', String(options.taggedPdf));

  if (options.userPassword) {
    form.append('userPassword', options.userPassword);
  }

  if (options.ownerPassword) {
    form.append('ownerPassword', options.ownerPassword);
  }

  form.append('restrictPermissions', String(options.restrictPermissions));
  form.append('allowPrinting', String(options.allowPrinting));
  form.append('allowChanges', String(options.allowChanges));

  return form;
}

/**
 * Ставит задачу конвертации в очередь.
 *
 * @param params - файл и параметры конвертации
 * @param signal - сигнал отмены
 * @returns ответ сервера с идентификатором задачи
 * @throws {ApiError} - если сервер отклонил запрос
 */
export async function submitConversion(
  params: SubmitParams,
  signal?: AbortSignal
): Promise<ConvertAccepted> {
  return request<ConvertAccepted>('/convert/xlsx-to-pdf', {
    method: 'POST',
    body: buildConversionForm(params),
    parse: (value) => convertAcceptedSchema.parse(value),
    signal,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/**
 * Ограничитель запросов статуса.
 *
 * Батча в новом API нет: статус запрашивается по каждой задаче отдельно,
 * поэтому единственный способ не выйти за лимит частоты сервера — общая
 * пауза между запусками. Живёт столько же, сколько приложение: отмена опроса
 * идёт через сигнал конкретного запроса, а не через `clear()`.
 */
const statusLimiter = createLimiter(STATUS_CONCURRENCY, STATUS_MIN_INTERVAL_MS);

/**
 * Запрашивает состояние одной задачи.
 *
 * @param jobId - идентификатор задачи, выданный сервером
 * @param signal - сигнал отмены
 * @returns состояние задачи и ссылка на результат, если он готов
 * @throws {ApiError} - если задача не найдена или сервер ответил ошибкой
 */
export async function fetchStatus(
  jobId: string,
  signal?: AbortSignal
): Promise<JobStatusResponse> {
  return statusLimiter.run((limiterSignal) =>
    request<JobStatusResponse>(`/convert/status/${encodeURIComponent(jobId)}`, {
      // Сигналы объединяются: запрос прервётся и при уходе со страницы,
      // и при очистке ограничителя
      signal: signal ? AbortSignal.any([signal, limiterSignal]) : limiterSignal,
      parse: (value) => jobStatusResponseSchema.parse(value),
    })
  );
}
