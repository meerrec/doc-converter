/**
 * Пути исходных файлов в файловой системе сборки.
 *
 * Проверка про ошибку, которая уже случалась и стоит дорого: офис
 * переиспользует открытый документ **по пути**, поэтому два файла на одном
 * пути — это предпросмотр одной книги и экспорт другой, а точнее экспорт
 * того документа, который открылся первым. Файл при этом ещё и молча
 * перезаписывается под открытым документом.
 *
 * Второе: в путь не должно попадать ничего из имени файла. Имя приходит
 * от пользователя, и подставлять его в файловую систему сборки — значит
 * отдавать чужие символы (вплоть до `../`) туда, где их никто не проверяет.
 */

import { describe, it, expect } from 'vitest';
import { FS_TMP_DIR } from '@doc-converter/office';
import { nextSourcePath, OUTPUT_PATH } from '../packages/office/src/paths.js';

describe('пути задач офиса', () => {
  it('каждая задача получает свой путь', () => {
    const first = nextSourcePath('xlsx');
    const second = nextSourcePath('xlsx');
    const third = nextSourcePath('docx');

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('путь лежит во временном каталоге сборки и оканчивается форматом', () => {
    // Формат нужен офису: по расширению он выбирает импортёр
    expect(nextSourcePath('xlsx')).toMatch(
      new RegExp(`^${FS_TMP_DIR}/source-\\d+\\.xlsx$`)
    );
    expect(nextSourcePath('docx')).toMatch(
      new RegExp(`^${FS_TMP_DIR}/source-\\d+\\.docx$`)
    );
  });

  it('путь результата не пересекается с путями исходников', () => {
    // Экспорт пишет по фиксированному пути: совпади он с исходником —
    // результат затёр бы документ, который офис держит открытым
    for (let index = 0; index < 5; index += 1) {
      expect(nextSourcePath('xlsx')).not.toBe(OUTPUT_PATH);
    }
  });
});
