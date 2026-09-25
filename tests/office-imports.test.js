/**
 * Границы пакета движка браузерной конвертации.
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
 * **Движок не знает о приложении.** Раньше независимость браузерного пути
 * удерживал запрет импорта `src/local` из интерфейса — теперь её удерживает
 * граница пакета: React, серверный API и код страницы сюда не импортируются,
 * и это видно по манифесту (`packages/office/package.json`). Проверка нужна
 * потому, что граница проходит по каталогу, а не по среде исполнения: движок
 * лежит в том же репозитории, и относительный путь до `apps/web` собирается
 * без единой ошибки.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OFFICE_SRC = path.join(ROOT, 'packages', 'office', 'src');

/** Пакеты, которые движку недоступны: он не знает ни о приложении, ни о сервере. */
const FORBIDDEN_PACKAGES = [
  'react',
  'react-dom',
  '@doc-converter/config',
  '@doc-converter/queue',
  '@doc-converter/storage',
  '@doc-converter/observability',
];

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

describe('импорты контракта в движке', () => {
  const files = filesUnder(OFFICE_SRC, '.ts');

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

describe('изоляция движка от приложения', () => {
  it('движок не импортирует React, серверные пакеты и код приложений', () => {
    for (const file of filesUnder(OFFICE_SRC, '.ts')) {
      const relative = path.relative(ROOT, file);

      for (const { module } of importedModules(readFileSync(file, 'utf8'))) {
        const forbidden =
          FORBIDDEN_PACKAGES.includes(module) ||
          module.startsWith('react/') ||
          module.includes('apps/') ||
          module.startsWith('../apps');

        expect(
          forbidden,
          `${relative}: движок обязан оставаться переносимым, а импорт «${module}» привязывает его к приложению`
        ).toBe(false);
      }
    }
  });
});
