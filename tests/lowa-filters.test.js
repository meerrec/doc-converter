/**
 * Согласованность имён фильтров экспорта: браузерный путь против серверного.
 *
 * Фильтр экспорта — не параметр, а имя: `calc_pdf_Export` для книги,
 * `writer_pdf_Export` для текстового документа. Ошибка в имени проявится
 * отказом экспорта, и в браузере это будет выглядеть как «PDF не сохранился»
 * без внятной причины — искать пришлось бы долго.
 *
 * Имена разбираются прямо из серверного скрипта, а не переписываются в тест:
 * переписанный список сверялся бы сам с собой. Заодно проверяется, что
 * браузерный путь принимает ровно те форматы, для которых у сервера есть
 * фильтр: лишний формат означал бы обещание, которого нет.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXPORT_FILTERS, LOCAL_FORMATS, exportFilterFor } from '../apps/web/src/local/lowa/filters.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UNO_SCRIPT = `${ROOT}docker/uno/uno_convert.py`;

/**
 * Извлекает имена фильтров из серверного скрипта.
 *
 * @returns карта «формат — фильтр»
 */
function serverFilters() {
  const source = readFileSync(UNO_SCRIPT, 'utf8');
  const start = source.indexOf('EXPORT_FILTERS');
  const end = source.indexOf('}', start);

  expect(start, 'в uno_convert.py не найден список фильтров').toBeGreaterThan(-1);
  expect(end, 'в uno_convert.py не найден конец списка фильтров').toBeGreaterThan(start);

  const body = source.slice(start, end);
  const filters = new Map();

  for (const match of body.matchAll(/"([a-z0-9]+)":\s*"([^"]+)"/g)) {
    filters.set(match[1], match[2]);
  }

  return filters;
}

describe('фильтры экспорта PDF', () => {
  it('совпадают с серверными', () => {
    const server = serverFilters();

    expect(server.size).toBeGreaterThan(0);
    expect(Object.keys(EXPORT_FILTERS).sort()).toEqual([...server.keys()].sort());

    for (const [format, filter] of server) {
      expect(EXPORT_FILTERS[format], `фильтр для ${format}`).toBe(filter);
    }
  });

  it('определяются по расширению файла', () => {
    expect(exportFilterFor('книга.xlsx')).toBe(EXPORT_FILTERS['xlsx']);
    expect(exportFilterFor('документ.DOCX')).toBe(EXPORT_FILTERS['docx']);
  });

  it('отвергают чужие и отсутствующие расширения', () => {
    // Расширения, которые сервис не принимает вовсе: старая книга Excel,
    // старый документ Word, документ ODF и файл без расширения
    for (const name of ['книга.xls', 'документ.doc', 'текст.odt', 'без-расширения', '']) {
      expect(exportFilterFor(name), name).toBeNull();
    }
  });

  it('принимают ровно те форматы, для которых есть фильтр', () => {
    expect([...LOCAL_FORMATS].sort()).toEqual(Object.keys(EXPORT_FILTERS).sort());
  });
});
