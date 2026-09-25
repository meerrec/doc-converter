/**
 * Правила импортов в браузерном пути.
 *
 * Два правила, и оба уже нарушались — поэтому и проверяются машиной, а не
 * вниманием на ревью.
 *
 * **Значения из контракта — только подпутями.** Корень пакета
 * (`@doc-converter/contract`) реэкспортирует `schemas.ts` вместе с zod,
 * а сборщик не может доказать, что `z.object({...})` на верхнем уровне модуля
 * не имеет побочных эффектов: импорт любой константы из корня тащит валидатор
 * в бандл. Типы стираются при сборке, поэтому `import type` из корня
 * безопасен — и только он.
 *
 * **Браузерный путь не попадает в основной бандл.** Страница `/local`
 * собирается отдельным конфигом (`vite.local.config.ts`), и импорт из `local`
 * в код интерфейса вернул бы её в общую сборку вместе с canvas, сборкой LOWA
 * и всем остальным. Потолок размера бандла в CI такую ошибку поймает,
 * но скажет только «бандл вырос».
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_SRC = path.join(ROOT, 'apps/web/src');
const LOCAL_SRC = path.join(WEB_SRC, 'local');

/**
 * Собирает пути всех файлов с указанным расширением под каталогом.
 *
 * @param dir - каталог
 * @param extension - расширение файлов (с точкой)
 * @returns список абсолютных путей
 */
function filesUnder(dir, extension) {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...filesUnder(full, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }

  return found;
}

/**
 * Извлекает модули, импортируемые файлом.
 *
 * Разбираются и `import`, и `export ... from`: реэкспорт тянет модуль
 * в бандл ровно так же, как импорт.
 *
 * @param source - содержимое файла
 * @returns список пар «модуль — были ли это только типы»
 */
function importedModules(source) {
  const found = [];

  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)from\s+'([^']+)'/gm)) {
    found.push({ isTypeOnly: match[2] !== undefined, module: match[4] });
  }

  return found;
}

describe('импорты контракта в браузерном пути', () => {
  const files = filesUnder(LOCAL_SRC, '.ts');

  it('файлы найдены', () => {
    // Проверка самого теста: пустой список означал бы, что правило
    // соблюдается только потому, что проверять нечего
    expect(files.length).toBeGreaterThan(0);
  });

  it('значения берутся подпутями, а не из корня пакета', () => {
    for (const file of files) {
      const relative = path.relative(ROOT, file);

      for (const { isTypeOnly, module } of importedModules(readFileSync(file, 'utf8'))) {
        if (module !== '@doc-converter/contract') {
          continue;
        }

        expect(
          isTypeOnly,
          `${relative}: импорт значения из корня контракта тянет zod — берите подпуть`
        ).toBe(true);
      }
    }
  });
});

describe('изоляция браузерного пути', () => {
  it('интерфейс не импортирует код страницы /local', () => {
    const files = filesUnder(WEB_SRC, '.ts')
      .concat(filesUnder(WEB_SRC, '.tsx'))
      .filter((file) => !file.startsWith(LOCAL_SRC));

    for (const file of files) {
      const relative = path.relative(ROOT, file);

      for (const { module } of importedModules(readFileSync(file, 'utf8'))) {
        const targetsLocal = module.includes('local/') || module.endsWith('/local');

        expect(
          targetsLocal,
          `${relative}: импорт из local вернул бы браузерную конвертацию в основной бандл (${module})`
        ).toBe(false);
      }
    }
  });
});
