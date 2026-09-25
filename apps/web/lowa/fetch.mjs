#!/usr/bin/env node
/**
 * Получение готовой сборки LibreOffice для браузера (LOWA) и фиксация её состава.
 *
 * Сборка не собирается нами: она берётся готовой у вендора (ZetaOffice) и
 * раздаётся со своего nginx. Что это меняет по сравнению с раздачей прямо
 * с чужого CDN:
 *
 *   - версия перестаёт быть плавающей. У вендора доступен единственный путь
 *     `zetaoffice_latest`, то есть «сегодня одно, завтра другое». Контрольные
 *     суммы, записанные здесь, превращают его в пин: сборка образа сверяет
 *     файлы с этими хэшами и падает, если вендор обновил сборку;
 *   - раздача работает в закрытом контуре, где внешний CDN недоступен.
 *
 * **Почему скрипт на Node, а не на shell с curl.** CDN отдаёт файлы сжатыми
 * brotli (`content-encoding: br`) и делает это независимо от заголовка
 * `Accept-Encoding` — проверить можно запросом с `identity`, ответ всё равно
 * `br`. Curl не распаковывает brotli (в том числе системный curl в macOS),
 * поэтому скачанное им — не wasm и не образ ФС, а сжатые потоки под их
 * именами. Это уже случалось: файлы легли в репозиторий в сжатом виде
 * (36 МБ вместо 161 МБ), сборка в браузере падала на компиляции модуля,
 * и заметно это было только по magic-байтам. `fetch` в Node распаковывает
 * brotli сам, а сигнатуры ниже не дают ошибке повториться молча.
 *
 * Обновление сборки — осознанное действие: запустить этот скрипт, посмотреть,
 * что изменилось, и закоммитить новый файл сумм. Автоматического «подтянуть
 * последнюю» нет намеренно.
 *
 * ВНИМАНИЕ: вопрос о праве на самостоятельную раздачу этих файлов открыт —
 * условия вендор не публикует, на сайте сказано «Both options are possible»
 * с отсылкой к контактам. До получения ответа файлы используются для проверки
 * гипотезы, а не для поставки. См. docs/local-wasm.md.
 *
 * Использование: node fetch.mjs [каталог]
 *   каталог — куда скачать (по умолчанию apps/web/lowa/assets)
 *
 * Все комментарии на русском языке.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = process.argv[2] ?? path.join(SCRIPT_DIR, 'assets');

// Адрес можно переопределить: в закрытом контуре это будет внутреннее зеркало,
// куда файлы положены один раз.
const SOURCE_URL = process.env.LOWA_SOURCE_URL ?? 'https://cdn.zetaoffice.net/zetaoffice_latest/';

/**
 * Состав сборки и признаки, по которым проверяется, что файл получен целиком
 * и распакован.
 *
 * `soffice.data.js.metadata` — не мелочь: в нём описан образ файловой системы,
 * и без него загрузчик не сможет его смонтировать. У него и `soffice.js`
 * сигнатуры нет — оба текстовые, и проверять у них нечего.
 */
const FILES = [
  { name: 'soffice.js' },
  { name: 'soffice.wasm', signature: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
  { name: 'soffice.data', signature: Buffer.from('PK\x03\x04', 'latin1') },
  { name: 'soffice.data.js.metadata' },
];

/**
 * Файлы, для которых дополнительно кладётся gzip-копия.
 *
 * Их отдаёт nginx через `gzip_static`, не тратя время на сжатие при каждом
 * запросе: 161 МБ wasm по сети превращаются в 36 МБ. Мелкие файлы не сжимаются
 * заранее — им хватает обычного gzip.
 */
const COMPRESSED = new Set(['soffice.wasm', 'soffice.data']);

/**
 * Скачивает файл сборки.
 *
 * @param name - имя файла в сборке
 * @returns содержимое файла
 */
async function download(name) {
  const url = new URL(name, SOURCE_URL).toString();
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${name}: сервер ответил ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Проверяет, что файл — то, чем себя объявляет.
 *
 * Проверка не формальность: сжатый поток внешне неотличим от файла, и без неё
 * ошибка раздачи проявляется только в браузере и только как отказ сборки.
 *
 * @param name - имя файла
 * @param data - содержимое
 * @param signature - ожидаемое начало файла (если есть)
 */
function verify(name, data, signature) {
  if (data.length === 0) {
    throw new Error(`${name}: файл пуст`);
  }

  if (signature !== undefined && !data.subarray(0, signature.length).equals(signature)) {
    const found = data.subarray(0, 8).toString('hex');

    throw new Error(
      `${name}: не совпала сигнатура (получено ${found}). ` +
        'Похоже, файл не распакован или вендор сменил формат сборки'
    );
  }
}

/**
 * Считает sha256 файла.
 *
 * @param data - содержимое
 * @returns хэш в шестнадцатеричном виде
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

mkdirSync(TARGET_DIR, { recursive: true });

console.log(`[lowa] Источник: ${SOURCE_URL}`);
console.log(`[lowa] Каталог:  ${TARGET_DIR}`);

const manifest = [
  '# Состав сборки LibreOffice для браузера (LOWA).',
  `# Источник: ${SOURCE_URL}`,
  `# Получено: ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`,
  '# Обновление: apps/web/lowa/fetch.mjs, затем проверить diff и закоммитить.',
  '# Хэши — от распакованных файлов: то, что раздаётся браузеру.',
];

for (const { name, signature } of FILES) {
  console.log(`[lowa] Скачивание ${name}`);

  const data = await download(name);

  verify(name, data, signature);
  writeFileSync(path.join(TARGET_DIR, name), data);

  if (COMPRESSED.has(name)) {
    // Копия пересоздаётся всегда: при обновлении сборки старая осталась бы
    // рядом с новым файлом и раздавалась бы вместо него
    console.log(`[lowa] Сжатие ${name}`);
    writeFileSync(path.join(TARGET_DIR, `${name}.gz`), gzipSync(data, { level: 9 }));
  }

  console.log(`[lowa] ${name}: ${(data.length / 1024 / 1024).toFixed(1)} МиБ`);
  manifest.push(`${sha256(data)}  ${name}`);
}

const manifestPath = path.join(SCRIPT_DIR, 'assets.sha256');

writeFileSync(manifestPath, `${manifest.join('\n')}\n`);

console.log(`[lowa] Записано: ${manifestPath}`);
console.log('[lowa] Проверка выполняется командой: sha256sum -c assets.sha256');
