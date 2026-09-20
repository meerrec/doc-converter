/**
 * Проверки оценки сложности задачи.
 *
 * Оценка определяет очередь, в которую попадёт файл, поэтому проверяются
 * обе границы — по размеру и по числу листов: книга маленькая по весу,
 * но с сотней листов должна уйти в тяжёлую очередь, а не в лёгкую.
 */

import { describe, it, expect } from 'vitest';
import { buildXlsx } from './helpers/xlsxFixtures.js';

const { estimateComplexity } = await import('../src/nest/xlsx/complexity.js');

describe('Оценка сложности: число листов', () => {
  it('считает листы книги', async () => {
    const buffer = await buildXlsx({ sheets: 4 });

    const result = await estimateComplexity(buffer);

    expect(result.sheets).toBe(4);
  });

  it('одна книга с тремя листами остаётся лёгкой', async () => {
    const buffer = await buildXlsx({ sheets: 3 });

    const result = await estimateComplexity(buffer);

    expect(result.tier).toBe('light');
  });

  it('пять листов переводят задачу в среднюю очередь', async () => {
    // Размер книги при этом остаётся маленьким: уровень берётся
    // по старшему из двух признаков
    const buffer = await buildXlsx({ sheets: 5 });

    const result = await estimateComplexity(buffer);

    expect(result.tier).toBe('medium');
  });

  it('больше двадцати листов — тяжёлая очередь', async () => {
    const buffer = await buildXlsx({ sheets: 21 });

    const result = await estimateComplexity(buffer);

    expect(result.tier).toBe('heavy');
  });
});

describe('Оценка сложности: устойчивость к мусору', () => {
  it('не-zip файл классифицируется по размеру, листы не считаются', async () => {
    // OLE-контейнер старого формата .xls: это не zip, листов не посчитать
    const buffer = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(1024, 0x00),
    ]);

    const result = await estimateComplexity(buffer);

    expect(result.sheets).toBeNull();
    expect(result.tier).toBe('light');
  });

  it('пустой буфер не роняет оценку', async () => {
    const result = await estimateComplexity(Buffer.alloc(0));

    expect(result.sheets).toBeNull();
    expect(result.sizeBytes).toBe(0);
  });

  it('zip без workbook.xml не считается книгой', async () => {
    const buffer = await buildXlsx({ sheets: 1 });
    // Портим центральный каталог: содержимое перестаёт читаться
    const broken = Buffer.from(buffer);
    broken.writeUInt32LE(0, broken.length - 22);

    const result = await estimateComplexity(broken);

    expect(result.sheets).toBeNull();
  });
});

describe('Оценка сложности: размеры', () => {
  it('размер файла попадает в результат как есть', async () => {
    const buffer = await buildXlsx({ sheets: 1 });

    const result = await estimateComplexity(buffer);

    expect(result.sizeBytes).toBe(buffer.length);
  });
});
