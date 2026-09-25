/**
 * Лимиты браузерного пути и их соотношение с серверными.
 *
 * Лимиты у путей свои — на сервере это память реплики, в браузере память
 * вкладки, — и потому они не дублируют друг друга, а связаны. Связь эта
 * и проверяется: нарушив её, легко получить путь, который обещает больше,
 * чем может.
 *
 * Пакет `@doc-converter/config` для браузера недоступен: он читает
 * `process.env` на верхнем уровне модуля. Поэтому значения сравниваются
 * разбором текста — так же, как имена свойств FilterData.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_BYTES, MIN_OUTPUT_BYTES } from '../apps/web/src/local/lowa/constants.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Читает числовую константу из серверного конфига.
 *
 * @param name - имя константы
 * @returns значение
 */
function serverConstant(name) {
  const source = readFileSync(`${ROOT}packages/config/src/index.ts`, 'utf8');
  const match = new RegExp(`export const ${name} = Number\\(process\\.env\\.${name} \\|\\| ([^)]+)\\)`).exec(
    source
  );

  expect(match, `в packages/config не найдена константа ${name}`).not.toBeNull();

  // Значение записано выражением вроде `100 * 1024 * 1024` — считается оно,
  // а не разбирается: второй записи числа в тесте быть не должно
  return Number(eval(match[1]));
}

describe('лимиты браузерного пути', () => {
  it('потолок файла ниже серверного', () => {
    const server = serverConstant('MAX_FILE_BYTES');

    expect(MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(
      MAX_FILE_BYTES,
      'браузерный путь не может принимать файлы крупнее серверного: он ограничен памятью вкладки, а не реплики'
    ).toBeLessThan(server);
  });

  it('минимальный размер результата совпадает с серверным', () => {
    // Правило одно на оба пути: пустой файл от экспортёра — это отказ,
    // а не результат. Разойдясь, проверки начинали бы пропускать
    // или заворачивать одно и то же
    expect(MIN_OUTPUT_BYTES).toBe(serverConstant('MIN_OUTPUT_BYTES'));
  });
});
