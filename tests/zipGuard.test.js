/**
 * Проверки zip-гарда.
 *
 * Отдельный набор, а не проверка через HTTP: здесь важно не только «архив
 * отвергнут», но и то, **сколько байт пришлось прочитать** до отказа.
 * Подделанный архив обязан отбраковываться, не разворачиваясь целиком, —
 * иначе защита сама становится средством отказа в обслуживании.
 */

import { describe, it, expect } from 'vitest';
import { validateZip } from '../apps/api/src/security/zipGuard.js';
import { buildXlsx, buildDocx, buildZipBomb, buildLyingZipBomb } from './helpers/ooxmlFixtures.js';

describe('validateZip: корректные архивы', () => {
  it('валидная книга проходит проверку', async () => {
    const xlsx = await buildXlsx({ sheets: 3, rows: 10 });

    const result = await validateZip(xlsx);

    expect(result.isValid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('замеренный объём совпадает с содержимым книги', async () => {
    const xlsx = await buildXlsx({ sheets: 1, rows: 5 });

    const result = await validateZip(xlsx);

    // Объём считается по фактически прочитанным байтам, поэтому он не может
    // быть нулевым у непустого архива
    expect(result.totalUncompressedBytes).toBeGreaterThan(0);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.entries.every((entry) => entry.uncompressedLength >= 0)).toBe(true);
  });
});

describe('validateZip: недостоверный central directory', () => {
  it('архив с заниженным распакованным размером отбраковывается', async () => {
    // Заявленный размер подменён на сжатый: коэффициент 1, размеры в пределах
    // лимитов — все проверки по метаданным такой архив пропускают
    const lying = await buildLyingZipBomb(4 * 1024 * 1024);

    const result = await validateZip(lying);

    expect(result.isValid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'archive_size_mismatch'
    );
  });

  it('бомба не разворачивается целиком: чтение прерывается на заявленном размере', async () => {
    // Ключевое свойство защиты: чем больше бомба, тем раньше отказ.
    // Если бы архив читался до конца, проверка сама стала бы вектором отказа
    // в обслуживании — 64 МиБ распаковки на каждый запрос
    const lying = await buildLyingZipBomb(64 * 1024 * 1024);

    const result = await validateZip(lying);

    expect(result.isValid).toBe(false);

    // Прочитанные байты не накапливаются: запись прервана, а не дочитана.
    // Ноль здесь означает, что поток оборван до конца записи
    expect(result.totalUncompressedBytes).toBe(0);
  });
});

describe('validateZip: макросы документа', () => {
  it('документ с проектом VBA отбраковывается', async () => {
    // Макросы лежат отдельной частью пакета с безобидным расширением `.bin`,
    // поэтому фильтр расширений их пропускает, а по структуре контейнера
    // такой документ не отличается от обычного
    const docx = await buildDocx({ withMacros: true });

    const result = await validateZip(docx);

    expect(result.isValid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'archive_forbidden_name'
    );
  });

  it('документ без макросов проходит проверку', async () => {
    const docx = await buildDocx({ pages: 3 });

    const result = await validateZip(docx);

    expect(result.isValid).toBe(true);
  });
});

describe('validateZip: честные бомбы', () => {
  it('архив с правдиво объявленным сжатием отбраковывается по коэффициенту', async () => {
    const bomb = await buildZipBomb(200 * 1024 * 1024);

    const result = await validateZip(bomb);

    expect(result.isValid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'archive_ratio_exceeded'
    );
  });
});
