/**
 * Низкоуровневый сборщик PDF: объекты, ссылки, таблица xref.
 *
 * Задача модуля одна — превратить последовательность добавляемых объектов
 * в файл, который откроет просмотрщик. Ничего о документах он не знает:
 * ни страниц, ни шрифтов, ни картинок — это дело слоёв выше.
 *
 * Почему свой сборщик, а не библиотека: текст рисуется глифами движка
 * по их идентификаторам в исходном шрифте, а библиотеки субсеттят шрифт
 * своей перенумерацией глифов (у `pdf-lib` это ломало Carlito и Liberation —
 * вместо «Абзац» выводилось «63»). Отсюда же `CIDToGIDMap /Identity`:
 * идентификатор глифа в потоке — это и есть его номер в шрифте.
 *
 * Все комментарии на русском языке.
 */

import { zlibSync } from 'fflate';

/**
 * Сжимает данные для потока PDF.
 *
 * Взят `fflate`, а не `CompressionStream`: тот асинхронен, и одно это
 * сделало бы асинхронной всю сборку файла — включая те места, где порядок
 * объектов и есть разметка. `fflate` к тому же уже есть в дереве
 * как зависимость `fast-png` (им распаковываются PNG), а в отличие
 * от `node:zlib` работает и в браузере, и в Node — поэтому экспортёр
 * проверяется обычным тестом, без браузера.
 *
 * Имя функции здесь не косметика: `/FlateDecode` — это формат **zlib**
 * (RFC 1950), и у `fflate` ему отвечает `zlibSync`. Соседний `deflateSync`
 * отдаёт «сырой» DEFLATE без заголовка и контрольной суммы, и просмотрщик,
 * который его не прощает, читает поток как пустой: страница выходит белой,
 * а файл при этом выглядит целым. Поэтому сжатие идёт только через `zlibSync`.
 *
 * @param data - несжатые данные
 * @returns поток zlib: его и ждёт `/FlateDecode`
 */
function deflate(data: Uint8Array): Uint8Array {
  return zlibSync(data);
}

/** Байты в UTF-16BE — так PDF записывает строки в CMap и метаданных. */
export function utf16Be(text: string): string {
  let hex = '';

  for (const char of text) {
    // Сурогатные пары и так приходят двумя единицами: `codePointAt` вернул бы
    // одно число больше 0xFFFF, и оно не влезло бы в четырёхзначный код
    for (let index = 0; index < char.length; index += 1) {
      hex += char.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase();
    }
  }

  return hex;
}

/** Кодирует строку в байты Latin-1: синтаксис PDF однобайтовый. */
export function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }

  return bytes;
}

/** Склеивает части в один массив байтов. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;

  for (const chunk of chunks) {
    total += chunk.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

/** Экранирует строку для литерала PDF: `(`, `)`, `\` внутри него особые. */
export function pdfLiteral(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`);
}

/**
 * Собирает объекты PDF и расставляет ссылки.
 *
 * Номер объекта — его позиция в списке, начиная с единицы: ссылка `n 0 R`
 * в PDF адресует объект по номеру, и отдельная таблица соответствий
 * не нужна.
 */
export class PdfBuilder {
  /** Тела объектов; номер объекта — индекс плюс один. */
  private readonly objects: Uint8Array[] = [];

  /**
   * Добавляет объект.
   *
   * @param body - тело объекта без `n 0 obj` и `endobj`
   * @returns номер объекта для ссылок
   */
  add(body: string | Uint8Array): number {
    this.objects.push(typeof body === 'string' ? latin1(body) : body);

    return this.objects.length;
  }

  /**
   * Заменяет объект, номер которого уже разошёлся по ссылкам.
   *
   * Нужно ровно для дерева страниц: его номер (`/Parent` каждой страницы)
   * обязан быть известен до того, как собраны сами страницы, а содержимое —
   * только после.
   *
   * @param ref - номер объекта
   * @param body - новое тело
   */
  replace(ref: number, body: string | Uint8Array): void {
    this.objects[ref - 1] = typeof body === 'string' ? latin1(body) : body;
  }

  /**
   * Добавляет поток: словарь, сжатые данные и `/Length`.
   *
   * `/Length` дописывается здесь, а не передаётся: он обязан совпадать
   * с длиной сжатых данных, и словарь, собранный вызывающим, этого знать
   * не может. Ошибка в нём не диагностируется — просмотрщик читает поток
   * как пустой, и страница выходит белой.
   *
   * @param dict - словарь потока без `/Length`, вида `<< /Filter /FlateDecode >>`
   * @param data - несжатые данные
   * @returns номер объекта
   */
  addStream(dict: string, data: Uint8Array): number {
    const packed = deflate(data);

    return this.add(
      concat([
        latin1(`${dict.replace(/\s*>>\s*$/, '')} /Length ${packed.byteLength} >>\nstream\n`),
        packed,
        latin1('\nendstream\n'),
      ])
    );
  }

  /**
   * Собирает файл: заголовок, объекты, таблица xref, трейлер.
   *
   * @param rootRef - номер объекта-каталога
   * @returns байты PDF
   */
  build(rootRef: number): Uint8Array {
    const chunks: Uint8Array[] = [latin1('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
    let offset = chunks[0]?.byteLength ?? 0;

    /** Смещение каждого объекта от начала файла: его требует xref. */
    const offsets: number[] = [];

    for (const [index, body] of this.objects.entries()) {
      offsets.push(offset);
      const head = latin1(`${index + 1} 0 obj\n`);
      const tail = latin1('\nendobj\n');
      chunks.push(head, body, tail);
      offset += head.byteLength + body.byteLength + tail.byteLength;
    }

    const xrefStart = offset;
    let xref = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;

    for (const item of offsets) {
      xref += `${String(item).padStart(10, '0')} 00000 n \n`;
    }

    xref += `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootRef} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(latin1(xref));

    return concat(chunks);
  }
}
