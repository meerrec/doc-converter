/**
 * Сборка `FilterData` для экспорта PDF в браузерном пути.
 *
 * Модуль намеренно чистый: он ничего не знает ни про UNO, ни про LOWA,
 * и возвращает обычные пары «имя — значение». Причина в том, что серверный
 * путь задаёт те же параметры в `docker/uno/uno_convert.py`, и два списка
 * обязаны совпадать. Разойдясь, они дадут разный результат для одного и того
 * же документа — а заметить это можно только сравнением готовых PDF. Поэтому
 * сборка параметров вынесена в чистую функцию, а за согласованность
 * с серверным списком следит `tests/lowa-filterdata.test.js`: он разбирает
 * ключи прямо из Python-скрипта.
 *
 * Числовые коды версии PDF берутся из контракта (`PDF_VERSION_CODES`):
 * в API версия называется так, как её видит пользователь («1.7», «pdfa-2b»),
 * а экспортёр принимает числа. Второй карты соответствия быть не должно.
 *
 * Все комментарии на русском языке.
 */

// Значение импортируется подпутём, а не из корня пакета: корень
// реэкспортирует `schemas.ts` вместе с zod, и импорт константы притащил бы
// валидатор в бандл браузерного пути. Тип стирается при сборке, поэтому
// ему корень не вредит.
import { PDF_VERSION_CODES } from '@doc-converter/contract/conversion';
import type { ConversionOptions } from '@doc-converter/contract';

/** Один элемент FilterData: то, что экспортёр принимает парой имя-значение. */
export interface FilterDataEntry {
  /** Имя свойства экспортёра. */
  readonly name: string;
  /** Значение свойства. */
  readonly value: string | number | boolean;
}

/**
 * Битовые флаги прав в зашифрованном PDF.
 *
 * Значения заданы числами, потому что так их понимает экспортёр: 4 —
 * разрешение печати, 8 — разрешение изменять содержимое. Сумма флагов
 * не используется: права задаются независимо, и нуль означает запрет.
 */
const PRINTING_ALLOWED = 4;
const CHANGES_ALLOWED = 8;

/**
 * Собирает FilterData экспортёра PDF по параметрам конвертации.
 *
 * Порядок ключей повторяет серверный (`uno_convert.py`), а не произвольный:
 * списки сверяются построчно, и расхождение в порядке читалось бы как
 * расхождение в составе.
 *
 * @param options - параметры конвертации из интерфейса
 * @returns список свойств для FilterData
 */
export function buildFilterData(options: ConversionOptions): FilterDataEntry[] {
  const data: FilterDataEntry[] = [
    // Сжатие без потерь выключено: иначе качество JPEG не влияет ни на что,
    // и параметр «качество» в интерфейсе был бы обманом
    { name: 'UseLosslessCompression', value: false },
    { name: 'Quality', value: options.quality },
    { name: 'ReduceImageResolution', value: options.reduceImageResolution },
    { name: 'MaxImageResolution', value: options.maxImageResolution },
    { name: 'SelectPdfVersion', value: PDF_VERSION_CODES[options.pdfVersion] },
    { name: 'UseTaggedPDF', value: options.taggedPdf },
    { name: 'ExportBookmarks', value: options.exportBookmarks },
    // Заметки и вложения не экспортируются: в PDF они попадают отдельными
    // объектами, а сервис конвертирует документ, а не переносит его служебные
    // части
    { name: 'ExportNotes', value: false },
    { name: 'IsAddStream', value: false },
  ];

  const watermark = (options.watermark ?? '').trim();

  if (watermark !== '') {
    // Мозаичный знак задаётся отдельным ключом: экспортёр либо повторяет
    // текст по странице, либо ставит один по центру
    data.push({
      name: options.watermarkMode === 'tiled' ? 'TiledWatermark' : 'Watermark',
      value: watermark,
    });
  }

  // Отдельного флага шифрования в контракте нет: шифрование включается
  // паролем. Требовать для этого ещё и галочку значило бы разрешить
  // состояние «пароль задан, но не действует».
  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword ?? '';

  if (userPassword !== '' || ownerPassword !== '') {
    const restrict = options.restrictPermissions;

    data.push(
      { name: 'EncryptFile', value: true },
      { name: 'DocumentOpenPassword', value: userPassword },
      { name: 'PermissionPassword', value: ownerPassword },
      { name: 'RestrictPermissions', value: restrict },
      {
        name: 'Printing',
        value: !restrict || options.allowPrinting ? PRINTING_ALLOWED : 0,
      },
      {
        name: 'Change',
        value: !restrict || options.allowChanges ? CHANGES_ALLOWED : 0,
      }
    );
  }

  return data;
}
