/**
 * Заголовки страницы браузерной конвертации в конфигурации nginx.
 *
 * Проверок здесь две, и обе про ошибки, которые не видно глазами.
 *
 * **Заголовки изоляции нужны только странице `/local`.** Без
 * `Cross-Origin-Opener-Policy` и `Cross-Origin-Embedder-Policy` браузер
 * не выдаёт `SharedArrayBuffer`, и сборка LibreOffice не стартует вовсе.
 * Но у интерфейса сервиса те же заголовки ломают другое: вместе с изоляцией
 * перестают открываться ссылки на результаты в MinIO — они ведут на другой
 * origin. Поэтому проверяется и наличие заголовков у страницы, и их отсутствие
 * у интерфейса.
 *
 * **`add_header` в дочерней локации отменяет унаследованные заголовки**,
 * а не дополняет их. Забыть в локации `X-Content-Type-Options` — значит
 * молча отдать её содержимое без `nosniff`: браузер начнёт угадывать тип
 * по содержимому. Это уже случалось в этом конфиге, поэтому проверяется
 * машиной.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = readFileSync(`${ROOT}apps/web/nginx.conf`, 'utf8');

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

const HEADERS = {
  coop: 'Cross-Origin-Opener-Policy',
  coep: 'Cross-Origin-Embedder-Policy',
  nosniff: 'X-Content-Type-Options',
};

describe('заголовки изоляции страницы /local', () => {
  it('страница объявляет изоляцию', () => {
    const page = bodyOf('/local/');

    expect(page).toContain(HEADERS.coop);
    expect(page).toContain(HEADERS.coep);
  });

  it('интерфейс сервиса остаётся без изоляции', () => {
    // Локация SPA отдаёт index.html интерфейса. С изоляцией перестали бы
    // открываться presigned-ссылки на результаты — они ведут на MinIO
    for (const path of ['/assets/', '/index.html', '/']) {
      const body = bodyOf(path);

      expect(body, `${path}: изоляция у интерфейса`).not.toContain(HEADERS.coop);
      expect(body, `${path}: изоляция у интерфейса`).not.toContain(HEADERS.coep);
    }
  });

  it('ассеты страницы не объявляют изоляцию', () => {
    // Заголовок принадлежит документу, а не его ресурсам: на скриптах
    // и стилях он бесполезен и лишь добавляет работы браузеру
    const assets = bodyOf('/local/assets/');

    expect(assets).not.toContain(HEADERS.coop);
    expect(assets).not.toContain(HEADERS.coep);
  });

  it('неизвестный файл сборки даёт 404, а не оболочку', () => {
    // SPA-fallback здесь означал бы, что пропавший wasm отдаётся как HTML:
    // сборка получит страницу вместо модуля и упадёт с невнятной ошибкой
    for (const path of ['/local/lowa/', '/local/assets/', '/local/']) {
      expect(bodyOf(path), path).not.toContain('try_files $uri $uri/ /index.html');
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
