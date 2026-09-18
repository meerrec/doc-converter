/**
 * Конвейер конвертации: источник → проверка содержимого → fork-пул → результат.
 *
 * Модуль общий для обоих путей выполнения. Синхронный путь вызывает его
 * из обработчика запроса (процесс API), асинхронный — из обработчика задачи
 * очереди (процесс воркера). Разница между путями только в том, кто инициатор
 * и как выглядит ответ; подготовка и проверки здесь одни и те же.
 *
 * Раньше подготовка была продублирована: `api/routes/convert.js` и
 * `worker/processor.js` независимо декодировали base64, сверяли сигнатуры
 * и проверяли архив, причём расходились в деталях.
 */

import { Injectable } from '@nestjs/common';
import { MAX_FILE_BYTES } from '../../config/index.js';
import { convertWithLimits } from '../../worker/sandbox.js';
import { AppError } from '../common/app-error.js';
import { ContentValidator } from './content-validator.js';
import { UrlSource } from './url-source.js';

/** Источник исходного файла: ссылка либо содержимое в base64. */
export interface ConversionSource {
  /** Адрес файла. */
  url?: string;
  /** Содержимое файла в base64. */
  data?: string;
}

/** Контекст выполнения задачи. */
export interface ConversionContext {
  /** Идентификатор запроса для логов. */
  requestId?: string;
  /** Идентификатор задачи. */
  taskId: string;
  /** Признак синхронного пути: влияет на ожидание слота в семафоре. */
  isSync: boolean;
}

/**
 * Результат конвертации, каким его отдаёт fork-пул.
 *
 * Ошибка описана по факту использования: конвертер проставляет в неё
 * `errorCode`, который уходит клиенту как код ошибки API.
 */
export interface ConversionOutcome {
  /** Признак успеха. */
  success: boolean;
  /** Содержимое результата при успехе. */
  result?: Buffer;
  /** Ошибка при неудаче. */
  error?: { errorCode?: string; message?: string };
}

/** Конвейер конвертации. */
@Injectable()
export class ConversionService {
  /**
   * @param contentValidator - проверка содержимого файла
   * @param urlSource - загрузка файла по ссылке
   */
  constructor(
    private readonly contentValidator: ContentValidator,
    private readonly urlSource: UrlSource
  ) {}

  /**
   * Проверяет источник **до** обращения к очереди и хранилищу задач.
   *
   * Разделение на две стадии повторяет порядок Express-версии, где проверка
   * содержимого стояла в middleware — раньше обработчика. Это важно по двум
   * причинам: клиент с заведомо негодным файлом получает отказ, не дожидаясь
   * ответа Valkey, и повторный запрос с тем же ключом не скачивает файл заново.
   *
   * Для `data` содержимое разбирается и проверяется здесь же, и буфер
   * возвращается, чтобы не разбирать его второй раз. Для `url` проверяется
   * только адрес: файл скачивается позже, уже после проверки идемпотентности.
   *
   * @param source - ссылка или содержимое в base64
   * @param declaredFormat - формат, объявленный клиентом
   * @returns разобранный буфер для `data`, либо null для `url`
   * @throws {AppError} - если источник не прошёл проверку
   */
  async checkSource(
    source: ConversionSource,
    declaredFormat: string
  ): Promise<Buffer | null> {
    if (source.url) {
      await this.urlSource.assertAllowed(source.url);
      return null;
    }

    const buffer = this.decodeBase64(source.data);

    await this.contentValidator.validate(buffer, declaredFormat);

    return buffer;
  }

  /**
   * Достаёт содержимое файла после проверки идемпотентности.
   *
   * @param source - ссылка или содержимое в base64
   * @param prepared - буфер, разобранный на стадии проверки (для `data`)
   * @param declaredFormat - формат, объявленный клиентом
   * @returns содержимое файла
   * @throws {AppError} - если файл не получен или не прошёл проверку
   */
  async obtainInput(
    source: ConversionSource,
    prepared: Buffer | null,
    declaredFormat: string
  ): Promise<Buffer> {
    if (prepared) {
      return prepared;
    }

    if (!source.url) {
      throw new AppError('exactly_one_source_required', 'Источник не указан', 400);
    }

    const buffer = await this.urlSource.fetch(source.url);

    await this.contentValidator.validate(buffer, declaredFormat);

    return buffer;
  }

  /**
   * Выполняет конвертацию в fork-пуле.
   *
   * Опции передаются в формате Р7-Офис, без предварительного преобразования.
   * Это важно: `fork-worker` читает из них только `password`, а преобразователь
   * `mapR7OptionsToLibreOffice` переименовывает его в `Password` — из-за чего
   * асинхронный путь молча терял пароль защищённого документа, тогда как
   * синхронный, передававший опции как есть, работал. Остальные опции движок
   * всё равно не использует (см. docs/architecture.md).
   *
   * @param buffer - содержимое исходного файла
   * @param inputFormat - формат исходного файла
   * @param outputFormat - требуемый формат результата
   * @param options - опции конвертации в формате Р7
   * @param context - контекст задачи
   * @returns результат конвертации
   */
  async convert(
    buffer: Buffer,
    inputFormat: string,
    outputFormat: string,
    options: Record<string, unknown>,
    context: ConversionContext
  ): Promise<ConversionOutcome> {
    // Приведение на границе с JS-модулем: `sandbox.js` объявляет ошибку как
    // `object`, и точнее вывести её форму из JSDoc нельзя. После перевода
    // домена на TypeScript (этап 4) приведение уйдёт
    return convertWithLimits(
      buffer,
      inputFormat,
      outputFormat,
      options,
      context
    ) as unknown as Promise<ConversionOutcome>;
  }

  /**
   * Разбирает содержимое из base64 с контролем размера.
   *
   * @param data - содержимое в base64
   * @returns содержимое файла
   * @throws {AppError} - если данные не разбираются или слишком велики
   */
  private decodeBase64(data?: string): Buffer {
    if (!data || typeof data !== 'string') {
      throw new AppError('data_invalid_base64', 'Invalid base64 data', 400);
    }

    const buffer = Buffer.from(data, 'base64');

    if (buffer.length > MAX_FILE_BYTES) {
      throw new AppError(
        'data_too_large',
        `Data size ${buffer.length} exceeds max ${MAX_FILE_BYTES}`,
        413
      );
    }

    return buffer;
  }
}
