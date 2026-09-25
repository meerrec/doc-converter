/**
 * Dev-режим: раздача файлов офиса и заголовки документа.
 *
 * В проде всё, что нужно браузерной конвертации, даёт инфраструктура: nginx
 * раздаёт сборку LibreOffice и собранный мост, он же выдаёт заголовки изоляции.
 * В dev-режиме этого нет, и замену делает наш код (`apps/web/dev`), а ошибка
 * в нём видна только в браузере — причём не сразу: мост, собранный модулем
 * вместо IIFE, сборка не загрузит молча, а снаружи это выглядит как «офис
 * не запустился за 120 секунд». Поэтому проверяется то, что иначе проверяется
 * глазами и не с первого раза.
 *
 * Здесь **импорт, а не разбор текста**. Причина в том, что проверяются
 * значения: разбор конфигурации регулярками завёл бы в тесте вторую запись
 * тех же строк, и подтверждал бы он тогда сам себя. Импорт конфигурации
 * и модулей даёт те же значения, что исполняются.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LOWA_PATH,
  MISSING_BUILD_HINT,
  contentTypeFor,
  resolveLowaAsset,
} from '../apps/web/dev/lowa-assets.js';
import { BRIDGE_FILE_NAME } from '../apps/web/dev/office-dev.js';
import config from '../apps/web/vite.config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = path.join(ROOT, 'apps', 'web');
const NGINX = readFileSync(path.join(WEB, 'nginx.conf'), 'utf8');

/**
 * Базовый путь страницы.
 *
 * В конфигурации он не задан — страница живёт в корне, — а значение
 * по умолчанию у Vite это `/`.
 */
const BASE = config.base ?? '/';

/**
 * Адреса файлов офиса, которые просит страница.
 *
 * Читаются из кода, а не перечисляются здесь: это единственная связь между
 * тем, что страница запрашивает, и тем, что раздаётся. Разойдясь, они дали бы
 * страницу, которая работает в проде (адреса задаёт nginx) и молча отказывает
 * в dev-режиме — и наоборот.
 *
 * @returns список адресов
 */
function requested() {
  const source = readFileSync(path.join(WEB, 'src', 'office.ts'), 'utf8');

  return [...new Set([...source.matchAll(/'(\/[^']*)'/g)].map((match) => match[1]))];
}

describe('раздача сборки LibreOffice в dev-режиме', () => {
  const ASSETS = path.join('/tmp', 'lowa-assets');

  it('находит файл сборки по имени', () => {
    expect(resolveLowaAsset(ASSETS, 'soffice.wasm')).toEqual({
      name: 'soffice.wasm',
      filePath: path.join(ASSETS, 'soffice.wasm'),
      contentType: 'application/wasm',
    });
  });

  it('отбрасывает всё, что ведёт за каталог сборки', () => {
    // Имя приходит из адреса запроса, то есть от кого угодно, и проверяется
    // до декодирования и после: `%2e%2e%2f` — это `../`, и разбирать его
    // как имя файла значило бы отдать содержимое каталога выше
    const attempts = [
      '../package.json',
      '%2e%2e%2fpackage.json',
      '..%2Fpackage.json',
      '..',
      '.',
      '',
      'sub/soffice.wasm',
      'sub\\soffice.wasm',
      '/etc/passwd',
      'soffice.wasm%00',
      '%zz',
    ];

    for (const attempt of attempts) {
      expect(resolveLowaAsset(ASSETS, attempt), attempt).toBeNull();
    }
  });

  it('отбрасывает строку параметров и якорь', () => {
    // Сборка запрашивает файлы по чистому имени, но отладчик или кеш-хак
    // может добавить к адресу своё — это не имя файла
    expect(resolveLowaAsset(ASSETS, 'soffice.js?v=2')?.name).toBe('soffice.js');
    expect(resolveLowaAsset(ASSETS, 'soffice.js#top')?.name).toBe('soffice.js');
  });

  it('подбирает тип содержимого по имени файла', () => {
    // Типы проверяются не ради формальности. С чужим типом `.wasm` сборка
    // компилируется медленнее — Emscripten отказывается от потоковой
    // компиляции и сообщает об этом только предупреждением в консоли;
    // а `.js` при `nosniff` не загружается вовсе, и это отказ
    expect(contentTypeFor('soffice.wasm')).toBe('application/wasm');
    expect(contentTypeFor('soffice.js')).toContain('javascript');
    expect(contentTypeFor('bridge.js')).toContain('javascript');
    expect(contentTypeFor('soffice.data')).toBe('application/octet-stream');
    expect(contentTypeFor('soffice.data.js.metadata')).toBe('application/octet-stream');
    expect(contentTypeFor('soffice.wasm.gz')).toBe('application/gzip');
  });

  it('сообщение об отсутствии сборки называет команду', () => {
    // 404 под этим префиксом — ошибка окружения, а не адреса: сборка
    // в репозитории не хранится. Без имени команды сообщение не подсказывает,
    // что с этим делать
    expect(MISSING_BUILD_HINT).toContain('fetch.mjs');
  });
});

describe('изоляция страницы в dev-режиме', () => {
  /**
   * Читает значения заголовка из локации документа в nginx.
   *
   * Наличие изоляции у документа проверяет `tests/web-headers.test.js`.
   * Здесь важно другое: значения обязаны совпадать, потому что расхождение
   * не видно ни сборке, ни проверке типов, ни тестам страницы — она просто
   * не запустит офис в одном из двух режимов.
   *
   * @param name - имя заголовка
   * @returns значения из `nginx.conf` в порядке появления
   */
  function nginxHeaderValues(name) {
    const pattern = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"`, 'g');

    return [...NGINX.matchAll(pattern)].map((match) => match[1]);
  }

  it('заголовки dev-сервера совпадают с прод-раздачей', () => {
    for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
      expect(nginxHeaderValues(name), name).toEqual([config.server.headers[name]]);
    }
  });
});

describe('адреса страницы и dev-раздача', () => {
  it('страница просит то, что dev-сервер обслуживает', () => {
    // Адреса в странице абсолютные и записаны в коде: относительные считались
    // бы от адреса документа, а документ лежит в подкаталоге. Раздача обязана
    // отвечать по тем же адресам — иначе dev-режим отдаёт 404 там, где прод
    // работает, и узнаётся это только в браузере
    expect(new Set(requested())).toEqual(
      new Set([
        `${BASE}${LOWA_PATH}`,
        `${BASE}uno/runtime.js`,
        `${BASE}${BRIDGE_FILE_NAME}`,
      ])
    );
  });

  it('обвязка UNO лежит там, откуда её отдаёт Vite', () => {
    // Обвязка — перенесённый код, и раздаёт её не наш middleware, а сам Vite:
    // `publicDir` (по умолчанию `<root>/public`) отдаётся по `base` страницы.
    // Связь адреса в странице с файлом на диске ничем, кроме этого теста,
    // не проверяется
    const runtime = requested().find((address) => address.endsWith('uno/runtime.js'));

    expect(runtime, 'страница не просит обвязку UNO').toBeDefined();

    const onDisk = path.join(WEB, 'public', runtime.slice(BASE.length));

    expect(existsSync(onDisk), onDisk).toBe(true);
  });
});

describe('мост в dev-режиме', () => {
  /**
   * Убирает комментарии из исходника.
   *
   * Проверяется код, а не то, что о нём написано: без этого тест ловил бы
   * собственное объяснение — «пути берутся не из `process.cwd()`» — и требовал
   * бы убрать из комментария ровно то, о чём он предупреждает.
   *
   * @param source - исходник
   * @returns исходник без комментариев
   */
  function withoutComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  const DEV_SOURCE = withoutComments(
    readFileSync(path.join(WEB, 'dev', 'office-dev.ts'), 'utf8')
  );
  const BRIDGE_CONFIG = readFileSync(path.join(WEB, 'vite.bridge.config.ts'), 'utf8');

  it('настройки моста берутся из его конфигурации, а не задаются заново', () => {
    // Формат сборки (IIFE, а не модуль), имя файла и минификация — свойства
    // моста, и записаны они в одном месте. Вторая копия в плагине разошлась бы
    // с первой молча: мост, собранный модулем, воркер офиса не загрузит,
    // а `importScripts` об этом не сообщит
    expect(DEV_SOURCE).toContain('configFile: BRIDGE_CONFIG');
    expect(DEV_SOURCE).toContain('write: false');
    expect(DEV_SOURCE).not.toMatch(/\bformats:|lib:\s*\{/);

    expect(BRIDGE_CONFIG).toContain("formats: ['iife']");
    expect(BRIDGE_CONFIG).toContain(`'${BRIDGE_FILE_NAME}'`);
  });

  it('пути в dev-режиме не зависят от рабочего каталога', () => {
    // И Vite, и вложенная сборка моста отсчитывают относительные пути
    // от рабочего каталога процесса, а он зависит от того, откуда запущен
    // сервер: абсолютные пути из `import.meta.url` — единственный способ
    // не зависеть от этого
    for (const file of ['office-dev.ts', 'lowa-assets.ts']) {
      const source = withoutComments(readFileSync(path.join(WEB, 'dev', file), 'utf8'));

      expect(source, file).not.toContain('process.cwd');
    }
  });
});
