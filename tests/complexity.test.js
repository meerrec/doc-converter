/**
 * Проверки оценки сложности задачи.
 *
 * Оценка определяет очередь, в которую попадёт файл, поэтому проверяются
 * обе границы — по размеру и по объёму документа: книга маленькая по весу,
 * но с сотней листов должна уйти в тяжёлую очередь, а не в лёгкую,
 * и то же верно для документа с сотней страниц.
 */

import { describe, it, expect } from 'vitest';
import { buildXlsx, buildDocx } from './helpers/ooxmlFixtures.js';

const { estimateComplexity } = await import('../apps/api/src/conversion/complexity.js');

describe('Оценка сложности: число листов', () => {
  it('считает листы книги', async () => {
    const buffer = await buildXlsx({ sheets: 4 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.sheets).toBe(4);
  });

  it('одна книга с тремя листами остаётся лёгкой', async () => {
    const buffer = await buildXlsx({ sheets: 3 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.tier).toBe('light');
  });

  it('пять листов переводят задачу в среднюю очередь', async () => {
    // Размер книги при этом остаётся маленьким: уровень берётся
    // по старшему из двух признаков
    const buffer = await buildXlsx({ sheets: 5 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.tier).toBe('medium');
  });

  it('больше двадцати листов — тяжёлая очередь', async () => {
    const buffer = await buildXlsx({ sheets: 21 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.tier).toBe('heavy');
  });

  it('число страниц у книги не определяется', async () => {
    const buffer = await buildXlsx({ sheets: 1 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.pages).toBeNull();
  });
});

describe('Оценка сложности: число страниц документа', () => {
  it('считает страницы по свойствам документа', async () => {
    const buffer = await buildDocx({ pages: 12 });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.pages).toBe(12);
  });

  it('короткий документ остаётся лёгким', async () => {
    const buffer = await buildDocx({ pages: 3 });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.tier).toBe('light');
  });

  it('десять страниц переводят задачу в среднюю очередь', async () => {
    const buffer = await buildDocx({ pages: 10 });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.tier).toBe('medium');
  });

  it('сорок страниц — тяжёлая очередь', async () => {
    const buffer = await buildDocx({ pages: 40 });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.tier).toBe('heavy');
  });

  it('документ без свойств классифицируется по размеру', async () => {
    // `docProps/app.xml` пишет приложение-автор, и его может не быть вовсе:
    // отказывать из-за этого нельзя, но и объём тогда неизвестен
    const buffer = await buildDocx({ withAppXml: false });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.pages).toBeNull();
    expect(result.tier).toBe('light');
  });

  it('листов у документа Word не бывает', async () => {
    const buffer = await buildDocx({ pages: 3 });

    const result = await estimateComplexity(buffer, 'docx');

    expect(result.sheets).toBeNull();
  });
});

describe('Оценка сложности: устойчивость к мусору', () => {
  it('не-zip файл классифицируется по размеру, листы не считаются', async () => {
    // OLE-контейнер (бывший входной формат .xls): это не zip, листов
    // не посчитать. Формат больше не принимается, но оценка обязана
    // оставаться устойчивой к любому буферу
    const buffer = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(1024, 0x00),
    ]);

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.sheets).toBeNull();
    expect(result.tier).toBe('light');
  });

  it('пустой буфер не роняет оценку', async () => {
    const result = await estimateComplexity(Buffer.alloc(0), 'xlsx');

    expect(result.sheets).toBeNull();
    expect(result.sizeBytes).toBe(0);
  });

  it('zip без workbook.xml не считается книгой', async () => {
    const buffer = await buildXlsx({ sheets: 1 });
    // Портим центральный каталог: содержимое перестаёт читаться
    const broken = Buffer.from(buffer);
    broken.writeUInt32LE(0, broken.length - 22);

    const result = await estimateComplexity(broken, 'xlsx');

    expect(result.sheets).toBeNull();
  });
});

describe('Оценка сложности: размеры', () => {
  it('размер файла попадает в результат как есть', async () => {
    const buffer = await buildXlsx({ sheets: 1 });

    const result = await estimateComplexity(buffer, 'xlsx');

    expect(result.sizeBytes).toBe(buffer.length);
  });
});
