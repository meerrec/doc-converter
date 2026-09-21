/**
 * Проверки определения вида документа по содержимому контейнера.
 *
 * Сигнатура у книги Excel и документа Word одна и та же — оба являются
 * zip-архивами, — поэтому вид определяется по главной части пакета. Ошибка
 * здесь означала бы не отказ, а неверный фильтр экспорта: документ ушёл бы
 * в LibreOffice как книга и конвертировался бы в лучшем случае неправильно.
 */

import { describe, it, expect } from 'vitest';
import { detectOoxmlKind } from '../apps/api/src/security/ooxml.js';
import { buildXlsx, buildDocx, buildPlainZip } from './helpers/ooxmlFixtures.js';

describe('detectOoxmlKind', () => {
  it('опознаёт книгу Excel', async () => {
    const buffer = await buildXlsx({ sheets: 2 });

    expect(await detectOoxmlKind(buffer)).toBe('xlsx');
  });

  it('опознаёт документ Word', async () => {
    const buffer = await buildDocx({ pages: 2 });

    expect(await detectOoxmlKind(buffer)).toBe('docx');
  });

  it('документ без свойств остаётся документом', async () => {
    // Вид определяется по главной части пакета, а не по `docProps/app.xml`:
    // файл без свойств — по-прежнему документ Word
    const buffer = await buildDocx({ withAppXml: false });

    expect(await detectOoxmlKind(buffer)).toBe('docx');
  });

  it('посторонний zip не опознаётся', async () => {
    const buffer = await buildPlainZip();

    expect(await detectOoxmlKind(buffer)).toBeNull();
  });

  it('битый архив не опознаётся', async () => {
    const buffer = await buildXlsx({ sheets: 1 });
    // Портим конец центрального каталога: архив перестаёт читаться
    const broken = Buffer.from(buffer);
    broken.writeUInt32LE(0, broken.length - 22);

    expect(await detectOoxmlKind(broken)).toBeNull();
  });

  it('не-zip содержимое не опознаётся', async () => {
    expect(await detectOoxmlKind(Buffer.from('обычный текст'))).toBeNull();
  });

  it('пустой буфер не роняет определение', async () => {
    expect(await detectOoxmlKind(Buffer.alloc(0))).toBeNull();
  });
});
