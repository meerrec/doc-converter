# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

Сервис конвертации документов с HTTP API, совместимым с Р7-Офис (`POST /ConvertService.ashx`).
Конвертация выполняется **исключительно через WASM-сборку LibreOffice** (`@matbee/libreoffice-converter`) —
нативного LibreOffice в образе нет и добавлять его не следует.

- **Все комментарии, JSDoc и сообщения — на русском языке.** Это сквозное требование проекта
  (зафиксировано в шапке почти каждого файла). Новый код комментировать по-русски.
- Обоснование каждого числового лимита задокументировано комментарием рядом с константой — при изменении
  лимита обновляй и обоснование.

## Команды

Скрипты запуска — в `package.json` (`dev`, `dev:api`, `dev:worker`, `start`, `health`).
Неочевидное: `dev*` выставляют `NODE_ENV=development`, что включает CORS-заголовки в `api/server.js`.

Локальный запуск требует доступного Valkey/Redis (`REDIS_HOST`/`REDIS_PORT`); для полного стека —
`docker compose up --build` (api + worker + valkey).

### Тесты

```bash
npm test                     # весь набор
npm run test:e2e             # то же с E2E=1

# Один файл / один тест
NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit tests/security.test.js
NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit -t "should reject ZIP bomb"
```

`NODE_OPTIONS=--experimental-vm-modules` обязателен — Jest запускается на ESM без транспиляции
(`transform: {}` в `jest.config.js`). Без него Jest падает на `import`.

`--forceExit` в тест-скрипте нужен, потому что Jest иначе виснет на открытых хендлах: Express-сервер,
поднятый в тестах через `createServer()`, `setInterval` в rateLimit, пул fork-процессов. Код возврата
при этом остаётся корректным — при падении тестов Jest отдаёт 1.

`lint` — заглушка (`echo 'Linter not configured yet'`); линтер в проекте не настроен.

### Веб-интерфейс (`web/`)

Отдельный пакет: Vite + React + TypeScript, свой `package.json` и `node_modules`
(в pnpm-workspace не включён намеренно — чтобы не смешивать store с нативным `isolated-vm`).

```bash
cd web
npm install
npm run dev          # http://localhost:5173, запросы к API — через прокси Vite
npm run typecheck    # tsc --noEmit (он же входит в build)
npm run build        # → web/dist
```

Интерфейс работает только через асинхронный режим (`async: true`): синхронный путь
не сохраняет файл результата, поэтому скачать его было бы нельзя. Статусы опрашиваются
одной пачкой через `GET /status?taskIds=…`, отправка идёт через ограничитель
параллелизма (`web/src/lib/limiter.ts`) — на маршруте конвертации rate limit
навешан дважды, один POST стоит две единицы бюджета.

В production статику раздаёт nginx (`web/nginx.conf`, сервис `web` в compose) и он же
проксирует API на `api:3000` — фронт и API на одном origin, поэтому CORS не нужен.

Фикстуры-атаки не лежат в `tests/fixtures/` (пуст) — они генерируются кодом в
`tests/helpers/attackFixtures.js` (через `yazl`): zip-бомбы, path traversal, XML-бомбы, валидные DOCX/PDF.

## Архитектура

Сервис собран из двух **независимых путей выполнения**, и это главное, что нужно понять.

### Синхронный путь (`async: false`) — fork-пул

```
POST /ConvertService.ashx
  → api/routes/convert.js          валидация схемы, SSRF, magic bytes, zip guard
  → worker/sandbox.js              семафор MAX_CONCURRENT + таймаут SYNC_QUEUE_WAIT_MS
  → worker/fork-pool.js            пул child_process.fork
  → worker/fork-worker.js          конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

Изоляция — на уровне ОС: дочерний процесс не имеет доступа к сокетам API, очереди и Valkey.
При таймауте процесс убивается `SIGKILL` (`Promise.race` недостаточен — WASM продолжил бы работу в фоне).

Обмен с дочерним процессом идёт через `process.send` / `process.on('message')` — это `child_process.fork`,
а не worker_threads, поэтому `parentPort` здесь не применяется.

### Асинхронный путь (`async: true`) — BullMQ

```
POST /ConvertService.ashx → 202 + задача в очереди 'conversion'
  → queue/conversionQueue.js       BullMQ (грузится лениво через await import)
  → worker/index.js                BullMQ Worker
  → worker/processor.js            подготовка, валидация, сохранение результата
  → worker/sandbox.js              тот же fork-пул, что и в sync
  → worker/fork-worker.js          конвертация в дочернем процессе
```

**Конвертация в обоих режимах идёт через один fork-пул.** Разница только в инициаторе:
sync запускает её из обработчика запроса, async — из обработчика задачи BullMQ.

`worker/wasm-isolate.js` (изолят на `isolated-vm`) в конвейере **не участвует** — от него
отказались: WASM-память не изолируется в пределах потока, а вызов конвертера через границу
изолята падает с ошибкой клонирования. Файл оставлен, но не подключён; зависимость
`isolated-vm` при этом требует Node ≥ 24 и toolchain при сборке образа.

Опции Р7 библиотека понимает частично: работают `outputFormat`, `inputFormat`, `password`,
`pdf`, `image`; остальное (`CharSet`, `FieldDelimiter`, `PageSize` и пр. из `optionsMapper.js`)
игнорируется.

### Слои безопасности (в порядке прохождения)

`rateLimit` → `validate` (схема + allowlist форматов/полей) → `urlGuard` (SSRF) → `magicBytes` →
`zipGuard` / `xmlGuard` → sandbox/изоляция. Все они покрыты `tests/security.test.js`.
`urlGuard` работает fail-safe: если DNS не резолвится, хост считается приватным и блокируется.

### Отдача результатов

`api/routes/results.js` (`GET /results/:fileName`) — единственное место, откуда клиент
получает готовый файл. Имя разбирается на taskId и расширение, путь собирается от
`STORAGE_PATH` (файлы лежат плоско), расширение сверяется с allowlist выходных форматов.
Роутер смонтирован дважды — на `/results` и `/storage/results`, потому что синхронный
и асинхронный пути формируют разные `fileUrl`.

### Состояние

- **Valkey/Redis** (ioredis) — идемпотентность по `key` (`task:{id}:owner` через `SET NX EX`), статусы,
  прогресс, результаты, метаданные. Всё в `queue/idempotency.js`.
- **Файловая система** — результаты конвертации в `STORAGE_PATH`, атомарная запись
  (`.tmp` → `rename` → `chmod 0o444`). `storage/fileStorage.js`.

## Конфигурация

Все таймауты и лимиты — в **`src/config/index.js`**. Не хардкодь числа в модулях — добавляй константу
в config вместе с комментарием-обоснованием.

Два исключения, о которых легко забыть:

- `src/security/limits.js` — отдельный набор лимитов для zip/xml/url (не дублирует config, а дополняет).
- Прямые чтения `process.env` вне config: `api/middleware/auditLog.js` (`AUDIT_LOG_PATH`,
  `AUDIT_LOG_LEVEL`), `api/server.js` (`NODE_ENV`, `MAX_BODY_BYTES`).

`.env.example` — источник истины по переменным окружения, включая те, что пока не читаются кодом.

`SYNC_TIMEOUT_MS` обязан быть меньше таймаута балансировщика (nginx `proxy_read_timeout`), иначе клиент
получит оборванное соединение вместо 504.

## Соглашения

- Формат ошибок API — единый: `{ error: <код>, message, taskId? }`, где код — snake_case
  (`magic_mismatch`, `url_private_ip`, `field_type_mismatch`, …). Исключения несут `statusCode`
  и `errorCode` как свойства — обработчик ошибок в `server.js` маппит их в HTTP-ответ.
- Новые форматы добавляются в трёх местах: allowlist в `api/middleware/validate.js`, сигнатуры в
  `security/magicBytes.js`, списки совместимости в `worker/converter.js`.
- `isolated-vm` — нативный модуль, импортируется лениво. Если он не собран под текущий Node,
  API-сервер всё равно должен стартовать: не переноси его в статический импорт.
  В конвейере конвертации модуль не используется (см. выше), но остаётся в зависимостях.
- `vm2` не использовать никогда (прямо запрещено комментарием в `wasm-isolate.js`).
- Библиотеке конвертера нужен **явный `wasmLoader`**: подпуть `…/wasm/loader.cjs` не объявлен
  в `exports` пакета, поэтому импортируется по абсолютному пути через `pathToFileURL`.
  Без загрузчика инициализация падает с `WASM_NOT_INITIALIZED`.
