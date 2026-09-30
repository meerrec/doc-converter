/**
 * Заголовки страницы конвертера в конфигурации nginx.
 *
 * Проверяются ошибки, которых не видно глазами: SPA-fallback не должен
 * подменять пропавшие ассеты страницей, локации с `add_header` обязаны
 * повторять базовые заголовки (дочерняя директива отменяет унаследованные,
 * а не дополняет их), а страница не должна ссылаться на внешние адреса.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = path.join(ROOT, 'apps', 'web');
const CONFIG = readFileSync(path.join(WEB, 'nginx.conf'), 'utf8');

/** Заголовок, который обязан пережить `add_header` в дочерних локациях. */
const NOSNIFF = 'X-Content-Type-Options';

/**
 * Разбирает конфигурацию на блоки `location`.
 *
 * Содержимое берётся по балансу фигурных скобок: у локаций бывают вложенные
 * блоки, и поиск до первой закрывающей скобки обрезал бы их.
 *
 * @returns список локаций с их содержимым
 */
function locations() {
  const found = [];
  const pattern = /location\s+(=|\^~)?\s*([^\s{]+)\s*\{/g;

  for (const match of CONFIG.matchAll(pattern)) {
    let depth = 1;
    let index = match.index + match[0].length;

    while (index < CONFIG.length && depth > 0) {
      if (CONFIG[index] === '{') {
        depth += 1;
      } else if (CONFIG[index] === '}') {
        depth -= 1;
      }

      index += 1;
    }

    found.push({
      modifier: match[1] ?? '',
      path: match[2],
      body: CONFIG.slice(match.index + match[0].length, index - 1),
    });
  }

  return found;
}

/**
 * Находит локацию по пути.
 *
 * @param path - путь локации
 * @returns содержимое локации
 */
function bodyOf(path) {
  const found = locations().find((location) => location.path === path);

  expect(found, `в nginx.conf нет локации ${path}`).toBeDefined();

  return found.body;
}

describe('статика и fallback', () => {
  it('SPA-fallback ведёт на документ через редирект, а не отдаёт файл сам', () => {
    expect(bodyOf('/')).toContain('try_files $uri $uri/ /index.html');
  });

  it('пропавший ассет даёт 404, а не оболочку страницы', () => {
    expect(bodyOf('/assets/')).not.toContain('try_files $uri $uri/ /index.html');
  });
});

describe('локации не теряют базовые заголовки', () => {
  it('каждая локация с add_header повторяет nosniff', () => {
    for (const location of locations()) {
      if (!location.body.includes('add_header')) {
        continue;
      }

      expect(
        location.body,
        `локация ${location.modifier} ${location.path}: add_header отменяет базовые заголовки, а nosniff не повторён`
      ).toContain(NOSNIFF);
    }
  });
});

describe('страница не грузит чужое', () => {
  /**
   * Собирает файлы исходников страницы.
   *
   * @param dir - каталог
   * @param extensions - расширения (с точкой)
   * @returns список абсолютных путей
   */
  function filesUnder(dir, extensions) {
    const found = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        found.push(...filesUnder(full, extensions));
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(full);
      }
    }

    return found;
  }

  /**
   * Адреса внешних подресурсов.
   *
   * @param source - содержимое файла
   * @returns найденные адреса
   */
  function externalSources(source) {
    const patterns = [
      /\bsrc\s*=\s*["'{]?\s*(?:https?:)?\/\//g,
      /url\(\s*["']?\s*(?:https?:)?\/\//g,
      /@import\b/g,
    ];

    return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[0]));
  }

  it('ни разметка, ни стили, ни код не ссылаются на внешние адреса', () => {
    const files = [path.join(WEB, 'index.html'), path.join(WEB, 'src', 'styles.css')].concat(
      filesUnder(path.join(WEB, 'src'), ['.ts', '.tsx'])
    );

    for (const file of files) {
      const relative = path.relative(ROOT, file);
      const found = externalSources(readFileSync(file, 'utf8'));

      expect(
        found,
        `${relative}: страница обязана обходиться своими подресурсами`
      ).toEqual([]);
    }
  });

  /**
   * Второго рендерера страниц в сборке быть не должно.
   *
   * Раньше предпросмотр собирал PDF и разбирал его pdf.js. Теперь страницы
   * рисует canvas-рендерер самого движка из той же вёрстки, и возврат pdf.js
   * означал бы второй рендерер, отдельный воркер и лишние сотни килобайт
   * в загрузке — при том, что предпросмотр и так рисуется движком.
   */
  it('предпросмотр не тянет pdf.js', () => {
    const manifest = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8'));

    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('pdfjs-dist');

    for (const file of filesUnder(path.join(WEB, 'src'), ['.ts', '.tsx'])) {
      const relative = path.relative(ROOT, file);

      expect(
        readFileSync(file, 'utf8').includes('pdfjs'),
        `${relative}: страницы предпросмотра рисует движок, а не pdf.js`
      ).toBe(false);
    }
  });
});
