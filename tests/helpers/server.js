/**
 * Выбор реализации сервера для тестов.
 *
 * Во время переезда на NestJS в репозитории живут две реализации: Express
 * (`src/api/server.js`) и NestJS (`dist/nest/bootstrap.js`). Обе
 * экспортируют `createServer()` с одинаковой сигнатурой, поэтому один и тот
 * же набор тестов прогоняется против любой из них — переключается только
 * эта прослойка, тексты и ожидания тестов не меняются.
 *
 * Реализация выбирается переменной окружения `SERVER_IMPL`:
 *   (не задана)  — Express, текущая рабочая
 *   nest         — NestJS, требует собранного `dist`
 *
 * Импорт динамический, а не статический: тесты выставляют переменные
 * окружения (STORAGE_PATH, RATE_*) до обращения к серверу, а `config/index.js`
 * читает их при импорте модуля.
 */

/** Выбранная реализация. */
export const implementation = process.env.SERVER_IMPL === 'nest' ? 'nest' : 'express';

/**
 * Создаёт и запускает сервер выбранной реализации.
 *
 * @returns объект с приложением и слушающим сервером
 */
export async function createServer() {
  // Порт 0 — «любой свободный». Так наборы тестов, идущие параллельно
  // в разных воркерах Jest, не конфликтуют за 3000: раньше второй набор
  // получал EADDRINUSE и прогон вёл себя неустойчиво.
  // Если тест задал порт явно, значение не трогаем.
  process.env.API_PORT ??= '0';
  process.env.PORT ??= '0';

  if (implementation === 'nest') {
    const { createServer: createNestServer } = await import('../../dist/nest/bootstrap.js');

    return createNestServer();
  }

  const { createServer: createExpressServer } = await import('../../src/api/server.js');

  return createExpressServer();
}
