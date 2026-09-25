/**
 * Согласованность файла контрольных сумм сборки LibreOffice для браузера.
 *
 * Сборка скачивается вручную (`apps/web/lowa/fetch.mjs`) и в репозитории
 * не хранится: файлы весят сотни мегабайт и лежат в `.gitignore`. Единственное,
 * что остаётся в git, — `assets.sha256`, по которому сборка образа проверяет
 * скачанное. Значит манифест — тот самый пин версии, и разойтись с ним
 * нечему: имена в нём и в скрипте обязаны совпадать, иначе проверка
 * в образе пройдёт не по всем файлам.
 *
 * Отдельно проверяются сигнатуры — но только если файлы скачаны локально.
 * Причина в том, что сжатый поток внешне неотличим от файла: CDN отдаёт
 * сборку с brotli-сжатием, и скачанный без распаковки `soffice.wasm`
 * выглядит правдоподобно (36 МБ вместо 161 МБ). Ошибка проявляется только
 * в браузере, отказом компиляции модуля. В CI файлов нет, поэтому проверка
 * условная: разработчик, скачавший сборку, узнаёт о проблеме сразу,
 * а не через отладку в браузере.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOWA_DIR = path.join(ROOT, 'apps/web/lowa');
const ASSETS_DIR = path.join(LOWA_DIR, 'assets');
const MANIFEST = path.join(LOWA_DIR, 'assets.sha256');
const FETCH_SCRIPT = path.join(LOWA_DIR, 'fetch.mjs');

/**
 * Разбирает файл контрольных сумм.
 *
 * Формат — `sha256sum -c`: хэш, два пробела, имя файла. Строки с решётки
 * допустимы и несут происхождение сборки.
 *
 * @returns карта «имя файла — хэш»
 */
function readManifest() {
  const entries = new Map();

  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);

    expect(match, `строка манифеста не разобрана: ${line}`).not.toBeNull();
    entries.set(match[2], match[1]);
  }

  return entries;
}

/**
 * Извлекает имена файлов, которые скачивает скрипт.
 *
 * @returns список имён
 */
function scriptFileNames() {
  const source = readFileSync(FETCH_SCRIPT, 'utf8');
  const names = [];

  for (const match of source.matchAll(/\{ name: '([^']+)'/g)) {
    names.push(match[1]);
  }

  return names;
}

/** Сигнатуры файлов: чем файл обязан начинаться. */
const SIGNATURES = {
  'soffice.wasm': '0061736d',
  'soffice.data': '504b0304',
};

describe('манифест сборки LOWA', () => {
  it('перечисляет те же файлы, что скачивает скрипт', () => {
    expect([...readManifest().keys()].sort()).toEqual(scriptFileNames().sort());
  });

  it('содержит хэши sha256 и происхождение сборки', () => {
    const source = readFileSync(MANIFEST, 'utf8');

    expect(source).toMatch(/^# Источник: https?:\/\//m);
    expect(readManifest().size).toBeGreaterThan(0);
  });

  it('файлы сборки, если скачаны, совпадают с манифестом', () => {
    const entries = readManifest();
    const missing = [...entries.keys()].filter((name) => !existsSync(path.join(ASSETS_DIR, name)));

    if (missing.length > 0) {
      // Сборка не скачана — проверять нечего. Это обычное состояние CI.
      expect(missing.length).toBe(entries.size);

      return;
    }

    for (const [name, hash] of entries) {
      const data = readFileSync(path.join(ASSETS_DIR, name));

      expect(createHash('sha256').update(data).digest('hex'), name).toBe(hash);

      const signature = SIGNATURES[name];

      if (signature !== undefined) {
        expect(data.subarray(0, 4).toString('hex'), `${name}: сигнатура`).toBe(signature);
      }
    }
  });

  it('для крупных файлов есть сжатые копии', () => {
    const large = [...readManifest().keys()].filter((name) => SIGNATURES[name] !== undefined);
    const downloaded = large.every((name) => existsSync(path.join(ASSETS_DIR, name)));

    if (!downloaded) {
      expect(downloaded).toBe(false);

      return;
    }

    // nginx отдаёт их через gzip_static: 154 МБ wasm по сети превращаются
    // в 51 МБ, а сжатие на каждый запрос стоило бы процессорного времени
    for (const name of large) {
      const gzip = path.join(ASSETS_DIR, `${name}.gz`);
      const data = readFileSync(gzip);

      expect(data.subarray(0, 2).toString('hex'), `${name}.gz: сигнатура gzip`).toBe('1f8b');
    }
  });
});
