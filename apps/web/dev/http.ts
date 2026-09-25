/**
 * Текстовый ответ для dev-сервера страницы `/local`.
 *
 * Хелпер общий у раздачи сборки и у моста, и дело здесь не в экономии строк:
 * ответ обязан быть **не HTML**. Vite отдаёт несуществующие пути документом —
 * `htmlFallbackMiddleware` переписывает адрес в `/index.html`, а тот отвечает
 * кодом 200, — поэтому страница, получившая страницу вместо файла, не увидит
 * ошибки: отказ всплывёт позже и в другом месте (компиляция модуля в браузере)
 * либо не всплывёт вовсе (мост, который воркер офиса молча не загрузит).
 *
 * Все комментарии на русском языке.
 */

import type { ServerResponse } from 'node:http';

/**
 * Отправляет текстовый ответ.
 *
 * @param res - ответ
 * @param status - код состояния
 * @param message - сообщение (выводится одной строкой)
 */
export function respondText(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');

  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
