/**
 *Centralized configuration for doc-converter service.
 * All timeouts, limits, and environment variables are defined here.
 * 
 * NOTE: All comments in Russian as per project requirements.
 */

import { createRequire } from 'node:module';

// Версия берётся из package.json — см. обоснование у CONVERTER_VERSION ниже
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

// ============================================================================
// ВРЕМЕННЫЕ ЛИМИТЫ (таймауты) — внешний бюджет на этапы обработки
// ============================================================================

/**
 * Таймаут на приём тела запроса.
 * Обоснование: балансировщик (nginx) обычно имеет proxy_read_timeout 60с.
 * Мы ставим 15с, чтобы гарантированно уложиться и вернуть клиенту 408,
 * а не оборванное соединение.
 */
export const REQUEST_BODY_TIMEOUT_MS = Number(process.env.REQUEST_BODY_TIMEOUT_MS || 15000);

/**
 * Таймаут на fetch удалённого файла.
 * Обоснование: 30с — разумный лимит для загрузки файла из внутреннего storage.
 * При превышении возвращаем 504 Gateway Timeout.
 */
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

/**
 * Таймаут на валидацию содержимого (zip/xml guard).
 * Обоснование: проверка metadata не должна занимать больше 10с даже для больших архивов.
 * При превышении возвращаем 422 с error: "validation_timeout".
 */
export const VALIDATION_TIMEOUT_MS = Number(process.env.VALIDATION_TIMEOUT_MS || 10000);

/**
 * Таймаут на ожидание слота в семафоре для синхронного пути.
 * Обоснование: если все 4 воркера заняты, клиент получает 503 с Retry-After: 2.
 */
export const SYNC_QUEUE_WAIT_MS = Number(process.env.SYNC_QUEUE_WAIT_MS || 5000);

/**
 * Таймаут на конвертацию одного документа (WASM).
 * Обоснование: 60с — эмпирический лимит для больших документов.
 * При превышении fork-процесс убивается SIGKILL, задача получает статус failed.
 */
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);

/**
 * Общий бюджет для синхронного пути.
 * Обоснование: должен быть меньше таймаута балансировщика.
 * При превышении любого этапа возвращаем 504.
 */
export const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 30000);

/**
 * Таймаут на запись результата в storage.
 * Обоснование: 5с достаточно для записи файла на локальный volume.
 */
export const STORAGE_WRITE_TIMEOUT_MS = Number(process.env.STORE_WRITE_TIMEOUT_MS || 5000);

// ============================================================================
// ЛИМИТЫ РАЗМЕРОВ — защита от DoS через большие файлы
// ============================================================================

/**
 * Максимальный размер тела запроса в байтах (100 MiB).
 * Обоснование: отраслевой стандарт для документ-конвертеров.
 */
export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 104857600); // 100 MiB

/**
 * Максимальный размер входного файла в байтах (100 MiB).
 * Обоснование: совпадает с MAX_BODY_BYTES для консистентности.
 */
export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 104857600); // 100 MiB

/**
 * Минимальный размер выходного PDF в байтах.
 * Обоснование: PDF должен содержать хотя бы заголовок (%PDF-...) и минимальную структуру.
 */
export const MIN_OUTPUT_BYTES = Number(process.env.MIN_OUTPUT_BYTES || 32);

// ============================================================================
// ЛИМИТЫ КОНКУРЕНТНОСТИ — защита от перегрузки
// ============================================================================

/**
 * Максимальное количество одновременных задач конвертации на один процесс воркера.
 * Обоснование: 4 — эмпирически оптимально для Node.js с WASM (~240 МБ на задачу).
 */
export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);

/**
 * Размер пула fork-процессов.
 * Обоснование: совпадает с MAX_CONCURRENT для оптимального переиспользования.
 */
export const FORK_POOL_SIZE = Number(process.env.FORK_POOL_SIZE || 4);

// ============================================================================
// ЛИМИТЫ ПАМЯТИ WASM
// ============================================================================

/**
 * NODE_OPTIONS для отключения wasm trap handler.
 * Обоснование: без этого WASM не запустится при ulimit -v ниже ~10 ГБ.
 * --max-old-space-size=1536 — reservation для WASM + Node.js heap.
 *
 * Границы памяти задаются извне: контейнером (mem_limit в docker-compose)
 * и fork-pool.js, который передаёт каждому форку свой --max-old-space-size.
 */
export const NODE_OPTIONS = process.env.NODE_OPTIONS ||
  '--disable-wasm-trap-handler --max-old-space-size=1536';

// ============================================================================
// ЛИМИТЫ RATE LIMIT — защита от DDoS
// ============================================================================

/**
 * Количество запросов в секунду на один IP.
 * Обоснование: 5 — разумный лимит для API конвертации.
 */
export const RATE_PER_SEC = Number(process.env.RATE_PER_SEC || 5);

/**
 * Максимальный всплеск запросов (burst).
 * Обоснование: 20 позволяет кратковременные всплески.
 */
export const RATE_BURST = Number(process.env.RATE_BURST || 20);

// ============================================================================
// ОПЦИИ ВКЛЮЧЕНИЯ СИНХРОННОГО РЕЖИМА
// ============================================================================

/**
 * Включение синхронного режима.
 * Обоснование: true по умолчанию для совместимости с Р7-Офис API.
 * При false API возвращает 501 Not Implemented на async: false.
 */
export const SYNC_ENABLED = process.env.SYNC_ENABLED !== 'false';

// ============================================================================
// ПУТИ И ПОРТЫ
// ============================================================================

/** Порт API сервера. */
export const API_PORT = Number(process.env.API_PORT || 3000);

/** Хост Valkey/Redis. */
export const REDIS_HOST = process.env.REDIS_HOST || 'localhost';

/** Порт Valkey/Redis. */
export const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

/** Путь к storage. */
export const STORAGE_PATH = process.env.STORAGE_PATH || '/data/storage/results';

// ============================================================================
// ИДЕМПОТЕНТНОСТЬ
// ============================================================================

/**
 * Время жизни записи идемпотентности в Valkey (в секундах).
 * Обоснование: совпадает с TASK_TTL_SECONDS — час достаточно для любой конвертации.
 */
export const IDEMPOTENCY_TTL_SEC = Number(
  process.env.IDEMPOTENCY_TTL_SEC || 3600
);

// ============================================================================
// ALLOWLIST ОПЦИЙ КОНВЕРТАЦИИ
// ============================================================================

/**
 * Разрешённые значения codePage.
 * Обоснование: набор кодировок, поддерживаемых LibreOffice для CSV/текста.
 */
export const SUPPORTED_CODE_PAGES = [
  65001, // UTF-8
  1251,  // Windows Cyrillic
  1252,  // Windows Latin-1
  866,   // DOS Cyrillic
  20866, // KOI8-R
  28595  // ISO-8859-5
];

/**
 * Разрешённые значения delimiter для CSV.
 * Обоснование: 1 — запятая, 2 — точка с запятой, 3 — двоеточие, 4 — табуляция
 * (нумерация Р7-Офис).
 */
export const SUPPORTED_DELIMITERS = [1, 2, 3, 4];

// ============================================================================
// НАСТРОЙКИ BULLMQ
// ============================================================================

/**
 * Время удержания блокировки задачи воркером.
 * Обоснование: два таймаута задачи — блокировка не должна истечь
 * раньше, чем задача будет принудительно остановлена.
 */
export const BULLMQ_LOCK_DURATION = Number(
  process.env.BULLMQ_LOCK_DURATION || JOB_TIMEOUT_MS * 2
);

/**
 * Интервал проверки зависших задач.
 * Обоснование: совпадает с таймаутом задачи — зависшая задача
 * обнаруживается не позже, чем через один её бюджет времени.
 */
export const BULLMQ_STALLED_INTERVAL = Number(
  process.env.BULLMQ_STALLED_INTERVAL || JOB_TIMEOUT_MS
);

// ============================================================================
// РАЗНОЕ
// ============================================================================

/**
 * Версия конвертера из package.json.
 *
 * Читается из файла, а не из `npm_package_version`: та переменная заполняется
 * только при запуске через npm/pnpm-скрипт, а при прямом `node src/api/server.js`
 * (так работает CMD в Dockerfile) в окружении может оказаться значение
 * от постороннего пакета — процесс унаследует его молча.
 */
export const CONVERTER_VERSION = packageJson.version;
