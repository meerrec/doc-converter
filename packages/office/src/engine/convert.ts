/**
 * Конвейер своего движка: файл → PDF.
 *
 * Это стык двух половин. Вёрстку отдаёт BetterOffice (`document.ts` — Word,
 * `xlsx.ts` — книги), а PDF из неё собирает наш экспортёр (`pdf/`). Здесь же
 * параметры интерфейса проверяются на поддержку: их общий язык описан
 * контрактом (`ConversionOptions`), и отвергнуть запрос лучше, чем молча
 * выдать файл не с теми галочками.
 *
 * **Пароли не поддержаны.** Шифрование PDF — отдельная подсистема (стандартный
 * security handler), и обещать её наличие здесь нельзя: выданный без защиты
 * файл, когда защиту просили, хуже отказа. Поэтому запрос с паролем
 * отвергается, а не игнорируется молча.
 *
 * Все комментарии на русском языке.
 */

import type { ConversionOptions } from '@doc-converter/contract';
import { browserFormatOf } from '../filters.js';
import { buildPdf } from '../pdf/export.js';
import { renderDocx } from './document.js';
import { EngineError } from './errors.js';
import { renderXlsx } from './xlsx.js';

/** Что получилось из файла. */
export interface ConvertedDocument {
  /** Готовый PDF. */
  readonly bytes: Uint8Array;
  /** Число страниц PDF. */
  readonly pageCount: number;
  /** Число листов книги; у документа Word — null. */
  readonly sheets: number | null;
}

/** Задание конвейеру. */
export interface ConvertInput {
  readonly bytes: Uint8Array;
  /** Имя файла: из него берётся формат. */
  readonly fileName: string;
  /** Параметры, выбранные пользователем. */
  readonly options: ConversionOptions;
}

/**
 * Отвергает параметры, которых движок не умеет.
 *
 * В v1 браузерный путь собирает обычный PDF 1.7: PDF/A, водяной знак, теги
 * структуры, пароли и ограничения прав не поддержаны. Параметры качества
 * изображений и закладки не отвергаются — они относятся к экспорту
 * LibreOffice, а свой экспортёр их просто не применяет.
 *
 * @param options - параметры конвертации
 */
function assertSupported(options: ConversionOptions): void {
  if (options.pdfVersion !== 'default') {
    throw new EngineError(
      'engine_unsupported',
      'PDF/A в браузерном движке не поддерживается'
    );
  }

  if ((options.watermark ?? '').trim() !== '') {
    throw new EngineError(
      'engine_unsupported',
      'водяной знак в браузерном движке не поддерживается'
    );
  }

  if (options.taggedPdf) {
    throw new EngineError(
      'engine_unsupported',
      'теги структуры в браузерном движке не поддерживаются'
    );
  }

  if ((options.userPassword ?? '') !== '' || (options.ownerPassword ?? '') !== '') {
    throw new EngineError(
      'engine_unsupported',
      'пароль на PDF в браузерном движке не поддерживается'
    );
  }

  if (options.restrictPermissions) {
    throw new EngineError(
      'engine_unsupported',
      'ограничение прав на PDF в браузерном движке не поддерживается'
    );
  }
}

/**
 * Конвертирует документ в PDF.
 *
 * @param input - байты файла, его имя и параметры
 * @returns PDF, число страниц и число листов (для книги)
 */
export async function convertDocument(input: ConvertInput): Promise<ConvertedDocument> {
  const format = browserFormatOf(input.fileName);

  if (format === null) {
    throw new EngineError('engine_unsupported', `формат не поддержан: ${input.fileName}`);
  }

  assertSupported(input.options);

  try {
    if (format === 'docx') {
      const rendered = await renderDocx(input.bytes);

      return {
        bytes: await buildPdf(rendered.displayList, {
          fonts: rendered.fonts,
        }),
        pageCount: rendered.pageCount,
        sheets: null,
      };
    }

    const rendered = await renderXlsx(input.bytes, {
      fitToOnePage: input.options.fitToOnePage,
    });

    return {
      bytes: rendered.pdf,
      pageCount: rendered.pageCount,
      sheets: rendered.sheets,
    };
  } catch (error) {
    // Отказ движка — свой код: сообщения wasm-модуля английские и говорят
    // о внутренностях («docx-layout wasm is not initialized»), а показать
    // пользователю нужно причину, а не устройство
    if (error instanceof EngineError) {
      throw error;
    }

    throw new EngineError(
      'engine_convert_failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}
