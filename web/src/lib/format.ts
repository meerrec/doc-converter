/**
 * Вспомогательные функции форматирования и разбора имён файлов.
 */

import { INPUT_FORMATS } from '@doc-converter/contract';

/** Единицы измерения размера файла. */
const SIZE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ'] as const;

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
 * Определяет формат файла по его расширению.
 *
 * Проверка нужна только для раннего сообщения пользователю: настоящую
 * проверку содержимого делает сервер по сигнатурам файлов.
 *
 * @param fileName - имя файла
 * @returns расширение в нижнем регистре или null, если формат не поддерживается
 */
export function detectInputFormat(fileName: string): string | null {
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex === -1 || dotIndex === fileName.length - 1) {
    return null;
  }

  const extension = fileName.slice(dotIndex + 1).toLowerCase();

  return (INPUT_FORMATS as readonly string[]).includes(extension) ? extension : null;
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
