/**
 * Заголовки страницы конвертера в конфигурации nginx.
 *
 * Проверок три, и все про ошибки, которые не видно глазами.
 *
 * **Заголовки изоляции нужны документу.** Без `Cross-Origin-Opener-Policy`
 * и `Cross-Origin-Embedder-Policy` браузер не выдаёт `SharedArrayBuffer`,
 * и сборка LibreOffice не стартует вовсе — но лишь в проде: в dev-режиме
 * заголовки выдаёт Vite, и расхождение с nginx обнаружилось бы только
 * на живом стенде. Поэтому проверяется и наличие заголовков у документа,
 * и их отсутствие у подресурсов (там они бесполезны).
 *
 * **Изоляция не мешает скачивать результат.** Ссылка на PDF ведёт в MinIO,
 * то есть на другой origin, и `COEP: require-corp` ограничивает загрузку
 * кросс-доменных подресурсов и **вложенные** навигации. Переход верхнего
 * уровня под проверку не попадает, поэтому скачивание работает; а вот
 * встроить такую ссылку в `<iframe>` уже нельзя. Настоящее ограничение
 * изоляции — не грузить и не встраивать чужое, и его проверяет второй блок:
 * страница не должна ссылаться на внешние адреса.
 *
 * **`add_header` в дочерней локации отменяет унаследованные заголовки**,
 * а не дополняет их. Забыть в локации `X-Content-Type-Options` — значит
 * молча отдать её содержимое без `nosniff`: браузер начнёт угадывать тип
 * по содержимому. Это уже случалось в этом конфиге, поэтому проверяется
 * машиной.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = path.join(ROOT, 'apps', 'web');
const CONFIG = readFileSync(path.join(WEB, 'nginx.conf'), 'utf8');

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

/**
 * Собирает пути файлов с указанными расширениями под каталогом.
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

const HEADERS = {
  coop: 'Cross-Origin-Opener-Policy',
  coep: 'Cross-Origin-Embedder-Policy',
  nosniff: 'X-Content-Type-Options',
};

/** Локации, отдающие подресурсы: изоляция им не нужна. */
const SUBRESOURCE_LOCATIONS = ['/assets/', '/bridge.js', '/uno/runtime.js', '/lowa/'];

describe('изоляция документа страницы', () => {
  it('документ объявляет изоляцию', () => {
    const page = bodyOf('/index.html');

    expect(page).toContain(HEADERS.coop);
    expect(page).toContain(HEADERS.coep);
  });

  it('SPA-fallback ведёт на документ, а не отдаёт файл сам', () => {
    // `try_files` с последним аргументом-путём делает внутренний редирект,
    // и локация выбирается заново — то есть заголовки документа достаются
    // и адресам вида /любой/путь. Если fallback заменить на `= /index.html`
    // без редиректа или отдавать файл из `location /`, изоляции у них
    // не будет, и офис молча не стартует в проде, работая в dev-режиме
    expect(bodyOf('/')).toContain('try_files $uri $uri/ /index.html');
  });

  it('подресурсы не объявляют изоляцию', () => {
    // Заголовок принадлежит документу, а не его ресурсам: на скриптах
    // и стилях он бесполезен и лишь добавляет работы браузеру
    for (const path of SUBRESOURCE_LOCATIONS) {
      const body = bodyOf(path);

      expect(body, `${path}: изоляция у подресурса`).not.toContain(HEADERS.coop);
      expect(body, `${path}: изоляция у подресурса`).not.toContain(HEADERS.coep);
    }
  });

  it('неизвестный файл сборки даёт 404, а не оболочку', () => {
    // SPA-fallback здесь означал бы, что пропавший wasm отдаётся как HTML:
    // сборка получит страницу вместо модуля и упадёт с невнятной ошибкой
    for (const path of ['/lowa/', '/assets/']) {
      expect(bodyOf(path), path).not.toContain('try_files $uri $uri/ /index.html');
    }
  });
});

describe('документ не грузит чужое', () => {
  /**
   * Адреса внешних подресурсов в файле.
   *
   * Ищутся ровно те места, где браузер идёт в сеть за ресурсом: атрибут `src`,
   * правило `url(...)`, импорт стилей и `@import`. Ссылки в тексте и в `href`
   * сюда не попадают: переход по ссылке — навигация, и `COEP` её не трогает.
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
        `${relative}: изоляция требует, чтобы у каждого подресурса был свой источник — чужой адрес не загрузится, а сломается молча`
      ).toEqual([]);
    }
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
      ).toContain(HEADERS.nosniff);
    }
  });
});
