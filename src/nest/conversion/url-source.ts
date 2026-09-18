/**
 * Загрузка исходного файла по ссылке.
 *
 * Перенос `fetchFileFromUrl` из Express-обработчика без изменения
 * поведения: те же проверки (SSRF через `validateUrl`, допустимые
 * Content-Type, предельный размер, непустое тело) и тот же статус ответа
 * при неудаче.
 *
 * Отдельно стоит отметить: неудачи загрузки отдаются как 500 с кодом
 * `internal`, а не как 4xx, хотя часть из них — про негодный запрос
 * (неподходящий Content-Type, слишком большой файл). Поведение сохранено
 * намеренно: менять статусы на этом этапе означало бы менять внешний контракт
 * вместе с переездом на другой фреймворк.
 */

import { Injectable } from '@nestjs/common';
import { isErrorCode } from '@doc-converter/contract';
import { FETCH_TIMEOUT_MS, MAX_FILE_BYTES } from '../../config/index.js';
import { validateUrl } from '../../security/urlGuard.js';
import { AppError } from '../common/app-error.js';

/** Допустимые типы содержимого ответа. */
const ALLOWED_CONTENT_TYPES = [
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
];

/** Загрузка файла по URL. */
@Injectable()
export class UrlSource {
  /**
   * Скачивает файл по ссылке.
   *
   * @param url - адрес файла
   * @param options - таймаут загрузки
   * @returns содержимое файла
   * @throws {AppError} - если адрес не прошёл проверку или загрузка не удалась
   */
  async fetch(url: string, options: { timeout?: number } = {}): Promise<Buffer> {
    const timeout = options.timeout ?? FETCH_TIMEOUT_MS;

    await this.assertAllowed(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      return await this.download(url, controller.signal);
    } catch (error) {
      throw this.toAppError(error, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Проверяет адрес: схему, отсутствие учётных данных, приватные диапазоны.
   *
   * Публичный, потому что проверка адреса выполняется до обращения к очереди,
   * а загрузка — после: так повторный запрос с тем же ключом не скачивает
   * файл заново. В Express-версии это же разделение задавалось порядком
   * middleware и обработчика.
   *
   * @param url - адрес файла
   * @throws {AppError} - если адрес запрещён
   */
  async assertAllowed(url: string): Promise<void> {
    // Проверка DNS выполняется внутри validateUrl всегда; опций она не берёт.
    // Прежний вызов передавал сюда { checkDns, timeout }, но validateUrl
    // разбирает только allowPrivate — то есть аргументы молча игнорировались
    const result = await validateUrl(url);

    if (result.isValid) {
      return;
    }

    throw new AppError(
      isErrorCode(result.code) ? result.code : 'url_malformed',
      result.error ?? 'Ссылка не прошла проверку',
      400
    );
  }

  /**
   * Выполняет запрос и проверяет ответ.
   *
   * @param url - адрес файла
   * @param signal - сигнал отмены
   * @returns содержимое файла
   * @throws {Error} - при неудачном ответе или недопустимом содержимом
   */
  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const response = await fetch(url, { method: 'GET', signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (ALLOWED_CONTENT_TYPES.every((type) => !contentType.includes(type))) {
      throw new Error(`Unsupported Content-Type: ${contentType}`);
    }

    const declaredLength = response.headers.get('content-length');

    if (declaredLength && Number(declaredLength) > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${declaredLength} bytes`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${buffer.length} bytes`);
    }

    if (buffer.length === 0) {
      throw new Error('File is empty');
    }

    return buffer;
  }

  /**
   * Приводит ошибку загрузки к формату ответа сервиса.
   *
   * @param error - исходная ошибка
   * @param timeout - таймаут загрузки
   * @returns ошибка приложения
   */
  private toAppError(error: unknown, timeout: number): AppError {
    if (error instanceof AppError) {
      return error;
    }

    const name = (error as { name?: string }).name;
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? 'Не удалось загрузить файл';

    if (name === 'AbortError') {
      return new AppError('internal', `Fetch timeout after ${timeout}ms`, 500);
    }

    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      return new AppError('internal', `Failed to fetch URL: ${message}`, 500);
    }

    return new AppError('internal', message, 500);
  }
}
