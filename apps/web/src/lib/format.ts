/**
 * Вспомогательные функции форматирования и разбора имён файлов.
 */

import { isInputFormat } from '@doc-converter/contract/formats';
import type { InputFormat } from '@doc-converter/contract';

/** Единицы измерения размера файла. */
const SIZE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ'] as const;

/**
 * Форматтер времени суток.
 *
 * Вынесен на уровень модуля намеренно: конструктор `Intl.DateTimeFormat`
 * обращается к данным локалей и стоит десятки микросекунд, а вызывается
 * форматирование в теле рендера каждой строки таблицы. Сам форматтер
 * неизменяем, поэтому один экземпляр на процесс безопасен.
 */
const TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Форматирует размер файла для показа пользователю.
 *
 * @param bytes - размер в байтах
 * @returns строка вида «1,4 МБ»
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} ${SIZE_UNITS[0]}`;
  }

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value < 10 ? 1 : 0;

  return `${value.toFixed(fractionDigits).replace('.', ',')} ${SIZE_UNITS[unitIndex]}`;
}

/**
 * Форматирует длительность в секундах.
 *
 * @param seconds - длительность в секундах
 * @returns строка вида «12 с» или «1 мин 5 с»
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} с`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);

  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
}

/**
 * Форматирует момент времени для показа пользователю.
 *
 * @param isoDate - момент в формате ISO 8601
 * @returns время в виде «14:05» или null, если дата не разобралась
 */
export function formatClockTime(isoDate: string): string | null {
  const timestamp = Date.parse(isoDate);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return TIME_FORMATTER.format(timestamp);
}

/**
 * Определяет формат файла по его расширению.
 *
 * Проверка нужна только для раннего сообщения пользователю: настоящую
 * проверку содержимого делает сервер по сигнатурам файлов.
 *
 * @param fileName - имя файла
 * @returns формат в нижнем регистре или null, если формат не поддерживается
 */
export function detectInputFormat(fileName: string): InputFormat | null {
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex === -1 || dotIndex === fileName.length - 1) {
    return null;
  }

  const extension = fileName.slice(dotIndex + 1).toLowerCase();

  return isInputFormat(extension) ? extension : null;
}

/**
 * Убирает расширение из имени файла.
 *
 * @param fileName - имя файла
 * @returns имя без последнего расширения
 */
export function stripExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');

  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

/**
 * Склоняет существительное по числу.
 *
 * @param count - количество
 * @param forms - формы: [один, два, много]
 * @returns подходящая форма
 */
export function pluralize(count: number, forms: [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return forms[1];
  }

  return forms[2];
}
