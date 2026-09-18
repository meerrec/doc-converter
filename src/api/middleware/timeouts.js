/**
 *Middleware для обработки таймаутов на разных этапах.
 *
 * Устанавливает таймауты для:
 * - Приёма тела запроса (REQUEST_BODY_TIMEOUT_MS)
 * - Общего времени обработки запроса (SYNC_TIMEOUT_MS для синхронного пути)
 *
 * Все комментарии на русском языке.
 */

import {
  REQUEST_BODY_TIMEOUT_MS,
  SYNC_TIMEOUT_MS
} from '../../config/index.js';

/**
 * Создаёт timeout promise, который отклоняется через заданное время.
 *
 * @param {number} ms - время в миллисекундах
 * @param {string} errorCode - код ошибки для отклонения
 * @returns {Promise} - promise, который отклоняется через ms
 */
function createTimeoutPromise(ms, errorCode) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(errorCode));
    }, ms);
  });
}

/**
 * Middleware для таймаута на приём тела запроса.
 * Использует express.json() с limit и timeout.
 *
 * @returns {Function} - Express middleware
 */
export function bodyTimeoutMiddleware() {
  return (req, res, next) => {
    // Express json middleware уже обрабатывает body, но мы добавляем свой timeout
    let timeoutId;
    let isCompleted = false;

    // next() обязан вызываться ровно один раз: для GET-запроса срабатывает
    // ранний выход ниже, а следом приходит событие 'end' — повторный вызов
    // продолжает цепочку middleware заново и упирается в обработчик 404,
    // который пытается ответить поверх уже отправленного ответа
    // (ERR_HTTP_HEADERS_SENT).
    let isNextCalled = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const callNext = () => {
      if (isNextCalled) {
        return;
      }

      isNextCalled = true;
      next();
    };

    // Устанавливаем таймер
    timeoutId = setTimeout(() => {
      if (!isCompleted) {
        isCompleted = true;
        req.destroy(); // Прерываем чтение тела
        res.status(408).json({
          error: 'body_timeout',
          message: 'Request body timeout'
        });
      }
    }, REQUEST_BODY_TIMEOUT_MS);

    // Очищаем таймер при завершении запроса
    req.on('end', () => {
      isCompleted = true;
      cleanup();
      callNext();
    });

    req.on('close', () => {
      isCompleted = true;
      cleanup();
    });

    req.on('error', () => {
      isCompleted = true;
      cleanup();
    });

    // Если тело уже прочитано (для GET запросов), сразу вызываем next
    if (req.body || req.method === 'GET' || req.method === 'HEAD') {
      isCompleted = true;
      cleanup();
      callNext();
    }
  };
}

/**
 * Middleware для общего таймаута обработки запроса.
 * Используется для синхронного пути.
 *
 * @param {number} [timeoutMs=SYNC_TIMEOUT_MS] - таймаут в миллисекундах
 * @returns {Function} - Express middleware
 */
export function requestTimeoutMiddleware(timeoutMs = SYNC_TIMEOUT_MS) {
  return (req, res, next) => {
    let timeoutId;
    let isCompleted = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    // Устанавливаем таймер
    timeoutId = setTimeout(() => {
      if (!isCompleted) {
        isCompleted = true;
        res.status(504).json({
          error: 'sync_timeout',
          message: 'Request processing timeout'
        });
      }
    }, timeoutMs);

    // Очищаем таймер при завершении ответа
    res.on('finish', () => {
      isCompleted = true;
      cleanup();
    });

    res.on('close', () => {
      isCompleted = true;
      cleanup();
    });

    res.on('error', () => {
      isCompleted = true;
      cleanup();
    });

    next();
  };
}

/**
 * Создаёт race между операцией и таймаутом.
 * Если операция не завершается за timeoutMs, обещание отклоняется.
 *
 * @param {Promise} promise - обещание операции
 * @param {number} timeoutMs - таймаут в миллисекундах
 * @param {string} errorCode - код ошибки для отклонения
 * @returns {Promise} - обещание с таймаутом
 */
export function withTimeout(promise, timeoutMs, errorCode) {
  return Promise.race([
    promise,
    createTimeoutPromise(timeoutMs, errorCode)
  ]);
}

/**
 * Аналог setTimeout, который можно отменить.
 *
 * @param {Function} callback - функция обраного вызова
 * @param {number} ms - время в миллисекундах
 * @returns {Object} - объект с методом cancel
 */
export function createCancellableTimeout(callback, ms) {
  const timeoutId = setTimeout(callback, ms);
  
  return {
    cancel: () => {
      clearTimeout(timeoutId);
    }
  };
}

/**
 * Настраивает обработчик обрыва соединения с клиентом.
 * Возвращает функцию, которая устанавливает обработчики на req.on('close').
 * 
 * @returns {Function} - функция настройки
 */
export function setupClientDisconnectHandler() {
  return (req, res, next) => {
    // Обработчик обрыва соединения
    const disconnectHandler = () => {
      if (!res.writableEnded) {
        // Отменяем fetch если он идёт
        if (req.fetchController) {
          req.fetchController.abort();
        }
        
        // Убиваем fork-процесс если он работает
        if (req.activeFork) {
          try {
            req.activeFork.kill('SIGKILL');
          } catch {
            // Игнорируем
          }
        }
        
        // стандартные действия
        req.clientDisconnected = true;
      }
    };
    
    // Устанавливаем обработчик
    req.on('close', disconnectHandler);
    
    // Очищаем при завершении
    res.on('finish', () => {
      req.off('close', disconnectHandler);
    });
    
    next();
  };
}

export default {
  bodyTimeoutMiddleware,
  requestTimeoutMiddleware,
  withTimeout,
  createCancellableTimeout,
  setupClientDisconnectHandler
};
