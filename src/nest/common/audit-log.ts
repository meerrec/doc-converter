/**
 * Аудит-логгер.
 *
 * Пока это реэкспорт модуля из Express-слоя: сам логгер (отдельный инстанс
 * pino, пишущий в `AUDIT_LOG_PATH`) фреймворк-агностичен и переносится
 * на этапе 4 вместе с удалением `src/api/`. Обёртка нужна, чтобы у NestJS-кода
 * была одна точка импорта, и чтобы при переносе поменялся только её адрес.
 *
 * Функции принимают объект с полями события — форму, которую поддерживает
 * `logRejection` для вызовов вне обработчика Express.
 */

export {
  logRejection,
  logSuccess,
  logConversionError,
  logSsrfAttempt,
  logZipBomb,
  logXmlAttack,
} from '../../api/middleware/auditLog.js';
