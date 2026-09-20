/**
 * Обработка одной задачи конвертации.
 *
 * Порядок: скачать вход из хранилища во временный каталог, конвертировать
 * через UNO, загрузить PDF обратно, отметить состояние задачи. Временный
 * каталог удаляется в `finally` при любом исходе — иначе диск реплики
 * заполнится остатками неудачных задач.
 *
 * Все комментарии на русском языке.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversionOptions } from '@doc-converter/contract';
import { convertViaUno, UnoConversionError } from './uno-converter.js';
import { downloadToFile, putFile, resultKey } from '../../storage/s3.js';
import { markCompleted, markFailed, markProcessing } from '../../queue/jobStatus.js';
import { logConversionError, logSuccess } from '../../nest/common/audit-log.js';
import { MIN_OUTPUT_BYTES } from '../../config/index.js';

/** Данные задачи в очереди. */
export interface UnoJobData {
  /** Идентификатор задачи. */
  jobId: string;
  /** Ключ входного файла в хранилище. */
  inputKey: string;
  /** Формат входного файла. */
  inputFormat: string;
  /** Параметры конвертации. */
  options: ConversionOptions;
}

/** Результат обработки задачи. */
export interface UnoJobResult {
  /** Идентификатор задачи. */
  jobId: string;
  /** Ключ результата в хранилище. */
  resultKey: string;
  /** Размер PDF. */
  sizeBytes: number;
  /** Число страниц. */
  pages: number;
  /** Длительность конвертации. */
  durationMs: number;
}

/**
 * Приводит ошибку к паре «код, сообщение».
 *
 * Код из `UnoConversionError` уже соответствует контракту; всё остальное —
 * внутренняя ошибка воркера, и наружу отдаётся общий код, чтобы текст
 * исключения Node не попал клиенту.
 *
 * @param err - пойманная ошибка
 * @returns код и сообщение
 */
function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof UnoConversionError) {
    return { code: err.code, message: err.message };
  }

  return {
    code: 'job_processing_failed',
    message: err instanceof Error ? err.message : 'Неизвестная ошибка обработки',
  };
}

/**
 * Обрабатывает задачу конвертации.
 *
 * @param data - данные задачи
 * @returns результат конвертации
 * @throws {Error} - пробрасывается дальше, чтобы BullMQ отметил задачу упавшей
 */
export async function processJob(data: UnoJobData): Promise<UnoJobResult> {
  const { jobId, inputKey, inputFormat, options } = data;

  const workDir = await mkdtemp(path.join(tmpdir(), `uno-${jobId.slice(0, 8)}-`));
  const inputPath = path.join(workDir, `input.${inputFormat}`);
  const outputPath = path.join(workDir, 'result.pdf');

  try {
    await markProcessing(jobId);
    await downloadToFile(inputKey, inputPath);

    const conversion = await convertViaUno(inputPath, outputPath, options);

    // Проверка на стороне воркера, а не только в Python: пустой файл мог
    // появиться и при формально успешном завершении скрипта
    const stats = await stat(outputPath);

    if (stats.size < MIN_OUTPUT_BYTES) {
      throw new UnoConversionError(
        'conversion_failed',
        `Экспорт вернул файл размером ${stats.size} Б — это не PDF`
      );
    }

    const key = resultKey(jobId);
    const sizeBytes = await putFile(key, outputPath);

    await markCompleted(jobId, key, sizeBytes);

    logSuccess({
      jobId,
      sizeBytes,
      pages: conversion.pages,
      durationMs: conversion.durationMs,
    });

    return {
      jobId,
      resultKey: key,
      sizeBytes,
      pages: conversion.pages,
      durationMs: conversion.durationMs,
    };
  } catch (err) {
    const { code, message } = toFailure(err);

    logConversionError({ jobId, code, message });

    await markFailed(jobId, code, message);

    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export default { processJob };
