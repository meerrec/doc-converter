/**
 * Вызов конвертации через UNO-бридж LibreOffice.
 *
 * Скрипт на Python запускается отдельным процессом на каждую задачу: он
 * подключается к уже работающему soffice по UNO-сокету, конвертирует файл
 * и завершается. Держать Python-процесс постоянно нельзя — модуль `uno`
 * не рассчитан на несколько независимых сессий в одном процессе, а падение
 * интерпретатора унесло бы с собой и бридж.
 *
 * Все комментарии на русском языке.
 */

import { spawn } from 'node:child_process';
import { PYTHON_BIN, UNO_SCRIPT_PATH, CONVERSION_TIMEOUT_MS } from '@doc-converter/config';
import { PDF_VERSION_CODES, type ConversionOptions } from '@doc-converter/contract';

/**
 * Приводит параметры контракта к виду, который понимает Python-скрипт.
 *
 * Версия PDF передаётся числовым кодом `SelectPdfVersion`: в контракте она
 * названа так, как её видит пользователь («1.7», «pdfa-2b»), а экспортёр
 * LibreOffice принимает числа. Соответствие задано в контракте, чтобы
 * эта деталь не расползалась по коду.
 *
 * @param options - параметры из API
 * @returns параметры для скрипта
 */
function toScriptOptions(options: ConversionOptions): Record<string, unknown> {
  return {
    ...options,
    pdfVersionCode: PDF_VERSION_CODES[options.pdfVersion],
  };
}

/** Результат успешной конвертации. */
export interface UnoConversionResult {
  /** Число страниц в PDF. */
  pages: number;
  /** Размер результата в байтах. */
  bytes: number;
  /** Сколько миллисекунд заняла конвертация. */
  durationMs: number;
}

/** Ошибка конвертации с кодом из контракта. */
export class UnoConversionError extends Error {
  /**
   * @param code - код ошибки из контракта
   * @param message - текст ошибки
   */
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UnoConversionError';
  }
}

/** Форма JSON-ответа Python-скрипта. */
interface UnoScriptResponse {
  /** Признак успеха. */
  ok?: boolean;
  /** Число страниц. */
  pages?: number;
  /** Размер файла. */
  bytes?: number;
  /** Текст ошибки. */
  error?: string;
}

/**
 * Разбирает ответ Python-скрипта.
 *
 * Скрипт печатает одну строку JSON последней строкой вывода: остальное —
 * сообщения самого LibreOffice, которые могут попасть в stdout.
 *
 * @param stdout - накопленный вывод процесса
 * @returns разобранный ответ или null, если JSON не найден
 */
function parseResponse(stdout: string): UnoScriptResponse | null {
  const lines = stdout.trim().split('\n');

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();

    if (!line || !line.startsWith('{')) {
      continue;
    }

    try {
      return JSON.parse(line) as UnoScriptResponse;
    } catch {
      // Строка похожа на JSON, но не разобралась — пробуем предыдущую
    }
  }

  return null;
}

/**
 * Конвертирует файл через UNO.
 *
 * @param inputPath - путь к исходному файлу
 * @param outputPath - путь, по которому должен появиться PDF
 * @param options - параметры конвертации
 * @param timeoutMs - таймаут конвертации
 * @returns результат конвертации
 * @throws {UnoConversionError} - если конвертация не удалась или превысила таймаут
 */
export function convertViaUno(
  inputPath: string,
  outputPath: string,
  options: ConversionOptions,
  timeoutMs: number = CONVERSION_TIMEOUT_MS
): Promise<UnoConversionResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const child = spawn(
      PYTHON_BIN,
      [
        UNO_SCRIPT_PATH,
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--options',
        JSON.stringify(toScriptOptions(options)),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      // SIGKILL, а не SIGTERM: интерпретатор может ждать ответа от soffice
      // и не обработать мягкий сигнал, а задача уже израсходовала свой бюджет
      child.kill('SIGKILL');

      reject(
        new UnoConversionError(
          'conversion_timeout',
          `Конвертация превысила ${Math.round(timeoutMs / 1000)} с`
        )
      );
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      finish(() => {
        reject(new UnoConversionError('uno_unavailable', `Не удалось запустить Python: ${err.message}`));
      });
    });

    child.on('close', (code) => {
      finish(() => {
        const response = parseResponse(stdout);

        if (code !== 0 || !response?.ok) {
          const message =
            response?.error ??
            stderr.trim().split('\n').pop() ??
            `Python завершился с кодом ${code}`;

          // Скрипт сообщает об отсутствии бриджа отдельным текстом: это
          // инфраструктурная ошибка, а не проблема документа
          const unoDown = /Connection refused|Unable to connect|no such|ConnectionRefused/i.test(message);

          reject(
            new UnoConversionError(unoDown ? 'uno_unavailable' : 'conversion_failed', message)
          );
          return;
        }

        resolve({
          pages: response.pages ?? 0,
          bytes: response.bytes ?? 0,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  });
}

export default { convertViaUno, UnoConversionError };
