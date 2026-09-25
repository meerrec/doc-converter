/**
 * Ограничение ожидания по времени.
 *
 * Нужно в двух местах: при инициализации сборки (модуль может не подняться)
 * и при каждой операции (офис может не ответить). Оба случая — зависание
 * без ответа, и без таймаута страница ждала бы его бесконечно, не имея
 * способа отличить «работает» от «упало».
 *
 * Таймер снимается при завершении: иначе он держал бы цикл событий
 * и откладывал освобождение памяти после операции.
 *
 * Все комментарии на русском языке.
 */

/**
 * Ждёт промис не дольше указанного времени.
 *
 * @param promise - ожидаемый промис
 * @param ms - предельное время ожидания в миллисекундах
 * @param message - сообщение об ошибке по истечении времени
 * @returns результат промиса
 * @throws Error, если время истекло
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
