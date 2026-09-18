# Архитектура

## Структура репозитория

Монорепозиторий на pnpm-workspace:

| Каталог | Роль |
|---|---|
| `src/` | Сервер: API (Express) и воркер очереди. Корневой пакет `doc-converter` |
| `packages/contract/` | **Контракт API**: zod-схемы и выведенные из них типы. Общий для сервера и веба |
| `web/` | Интерфейс: Vite + React + TypeScript |
| `tests/` | Тесты сервера (Jest + supertest) |

`packages/contract` — единственный источник правды по формам запросов и ответов,
спискам форматов, кодировкам и кодам ошибок. Схемы написаны на zod, поэтому из одной
схемы выводятся и тип для TypeScript, и рантайм-проверка: разойтись между сервером
и клиентом они не могут. Веб уже потребляет контракт целиком; сервер переходит
на него по мере переноса на NestJS.

Порядок сборки: контракт собирается **до** веба (`pnpm --filter @doc-converter/contract build`).

## Пути выполнения

Сервис собран из двух **независимых путей выполнения**, и это главное, что нужно понять
перед правкой кода.

| | Синхронный путь (`async: false`) | Асинхронный путь (`async: true`) |
|---|---|---|
| Где выполняется | Процесс API | Отдельный процесс `worker` |
| Роль | Немедленный ответ с результатом | Очередь, устойчивость к пикам нагрузки |
| Изоляция | `child_process.fork` (изоляция ОС) | та же: `child_process.fork` |
| Ограничение параллелизма | Семафор `MAX_CONCURRENT` + пул `FORK_POOL_SIZE` | `concurrency: MAX_CONCURRENT` в BullMQ + свой семафор воркера |
| Точка входа | `api/routes/convert.js` → `worker/sandbox.js` | `queue/conversionQueue.js` → `worker/index.js` → `worker/processor.js` → `worker/sandbox.js` |
| Движок | `worker/fork-worker.js` → `@matbee/libreoffice-converter` | тот же |

**Конвертация в обоих режимах идёт через один и тот же fork-пул.** Разница только в том,
кто её запускает: синхронный путь — прямо из обработчика запроса, асинхронный — из
обработчика задачи BullMQ. Это даёт одинаковую изоляцию (отдельный процесс на документ,
`SIGKILL` по таймауту) и одинаковое поведение конвертера в обоих режимах.

Ранее асинхронный путь использовал `isolated-vm` (`worker/wasm-isolate.js`). От этого
механизма отказались: WASM-память не изолируется в пределах потока (о чём предупреждает
и загрузчик самой библиотеки, `wasm/loader-isolated.cjs`), а вызов конвертера через
границу изолята падает с ошибкой клонирования. Модуль и зависимость `isolated-vm` удалены.

## Синхронный путь

```
POST /ConvertService.ashx
  → api/routes/convert.js          валидация схемы, SSRF, magic bytes, zip guard
  → worker/sandbox.js              семафор MAX_CONCURRENT + таймаут SYNC_QUEUE_WAIT_MS
  → worker/fork-pool.js            пул child_process.fork
  → worker/fork-worker.js          конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

### Пошагово

1. **Семафор** (`sandbox.js:176`). Синглтон `Semaphore(MAX_CONCURRENT)` = 4 слота.
   Синхронный запрос ждёт слот не дольше `SYNC_QUEUE_WAIT_MS` (5 с).
2. **Пул** (`fork-pool.js:120`). `runTask()` берёт свободный процесс из пула, при
   необходимости лениво форкает новые (до `FORK_POOL_SIZE`).
   Процессы создаются с `execArgv: ['--disable-wasm-trap-handler', '--max-old-space-size=1536']`
   и `serialization: 'advanced'` — последнее важно, иначе `Buffer` поехал бы JSON-массивом.
3. **Протокол обмена.** Родитель шлёт `{ type: 'convert', inputBuffer, inputFormat, outputFormat, options }`,
   потомок при старте отправляет `{ type: 'ready' }`, а по завершении — `{ result: [...] }`
   или `{ error: '<строка>' }`.
4. **Таймаут.** По истечении `JOB_TIMEOUT_MS` (60 с) процесс убивается **`SIGKILL`**.
   Это принципиально: `Promise.race` не останавливает уже запущенный WASM, а `SIGTERM`
   перехватывается воркером.
5. **Обрыв клиента.** Обработчик висит на `res.on('close')` и срабатывает только тогда,
   когда ответ ещё не отправлен (`res.writableFinished === false`): он отменяет `fetch`
   и убивает активный форк, иначе работа продолжалась бы «в пустоту».
   Слушать `req.on('close')` нельзя — у запроса это событие приходит и при штатном
   завершении (тело получено), из-за чего сервер считал клиента ушедшим и не отдавал
   готовый результат.
6. **Общий бюджет.** Параллельно в роутере тикает таймер `SYNC_TIMEOUT_MS` (30 с), по которому
   клиент получает `504 sync_timeout`.

Обмен идёт через `process.send` / `process.on('message')` — это `child_process.fork`,
а не `worker_threads`, поэтому `parentPort` здесь не применяется.

### Что важно знать про этот путь

- Дочерний процесс вызывает библиотеку **напрямую** (`fork-worker.js:119`), минуя
  `worker/converter.js` и `worker/optionsMapper.js`. Значит здесь нет ни проверки совместимости
  форматов, ни маппинга опций Р7 — из `options` используется только `password`.
- Ошибки пересекают границу процесса **строкой**: `errorCode` и `statusCode` теряются,
  поэтому наружу почти всегда уходит `500` с кодом `internal` или `conversion_failed`.
- `runTask` либо резолвится `{ success: true, result }`, либо реджектится. Ветки
  `if (!result.success)` в `sandbox.js:287` и `convert.js:296` недостижимы.

## Асинхронный путь

```
POST /ConvertService.ashx → 202 + задача в очереди 'conversion'
  → queue/conversionQueue.js       BullMQ (грузится лениво через await import)
  → worker/index.js                BullMQ Worker
  → worker/processor.js            подготовка, валидация, сохранение результата
  → worker/sandbox.js              семафор + бюджет времени
  → worker/fork-pool.js            пул child_process.fork (тот же, что в sync)
  → worker/fork-worker.js          конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

### Пошагово

1. **Постановка в очередь** (`api/routes/convert.js:234`). `addConversionJob` кладёт
   `{ taskId, inputBuffer (base64), inputFormat, outputFormat, options, requestId }`
   с `jobId = taskId`. Ответ клиенту — `202` с `taskId`.
2. **Воркер** (`worker/index.js:68`). `new Worker('conversion', processJob, { concurrency: MAX_CONCURRENT, lockDuration: BULLMQ_LOCK_DURATION, stalledInterval: BULLMQ_STALLED_INTERVAL })`.
3. **Обработка** (`worker/processor.js:87`): проверка `job.data` → декодирование base64 →
   `checkMagicBytes` → `validateZip` для офисных форматов → маппинг опций →
   `convertWithLimits` (fork-пул) → `saveFile` → запись статуса и результата в Valkey.
   Прогресс пишется через `job.updateProgress(10 / 20 / 30 / 90 / 100)`.
4. **Конвертация** — та же, что в синхронном пути: `sandbox.convertWithLimits` берёт слот
   семафора, отдаёт задачу в `fork-pool`, а тот запускает `fork-worker`. По истечении
   `JOB_TIMEOUT_MS` процесс получает `SIGKILL`.

### Что важно знать про этот путь

- `async: true` в docker-compose обслуживает отдельный контейнер `worker`
  (у него `SYNC_ENABLED=false`).
- Очередь называется `conversion`; имя продублировано константой в `worker/index.js:42`.
- `bullmq` загружается ленивым `await import()`: его CJS-сборка тянет ESM-only `msgpackr`,
  и статический импорт сломал бы запуск API-сервера.
- **Прогресс нельзя обновлять в обработчике `completed`.** Задача к этому моменту уже
  удалена из очереди (`removeOnComplete: true`), и вызов `job.updateProgress` падает
  с «Missing key for job», роняя процесс воркера. Итоговый прогресс пишется в `processor.js`.
- **Опции Р7 поддерживаются частично.** Библиотека принимает `outputFormat`, `inputFormat`,
  `password`, `pdf` и `image` — всё остальное (`CharSet`, `FieldDelimiter`, `PageSize`,
  `Margins` и прочее, что формирует `optionsMapper.js`) она игнорирует. Практический эффект
  сейчас даёт только пароль документа.

## Состояние

### Valkey/Redis

Клиент — `ioredis` (`queue/connection.js`), префикс ключей — `task:`.

| Ключ | Тип | TTL | Назначение |
|---|---|---|---|
| `task:{id}:owner` | string `"reserved"` | 3600 с | Резервирование `key` через `SET NX EX` — основа идемпотентности |
| `task:{id}` | string | 3600 с (из API — 30 с) | Статус задачи |
| `task:{id}:progress` | hash `{percent, message}` | 3600 с | Прогресс |
| `task:{id}:result` | string (JSON) | 3600 с | Результат: `fileUrl`, `fileType`, `size` |
| `task:{id}:error` | hash `{code, message}` | 3600 с | Ошибка |
| `task:{id}:metadata` | string (JSON) | 3600 с | `filetype`, `outputtype`, `url`, `timestamp` — для проверки конфликта ключей |

Статусы жизненного цикла: `processing` → `queued` → `completed` | `failed`; значение
`unknown` возвращается, когда ключа нет. Из API статус пишется с TTL `SYNC_TIMEOUT_MS / 1000`
(30 с), из воркера — с `IDEMPOTENCY_TTL_SEC` (3600 с).

### Файловое хранилище

`storage/fileStorage.js` пишет результат атомарно: `.tmp` → `rename` → `chmod 0o444`.
Запись идёт в `STORAGE_PATH`. Автоматической очистки нет: механизм удалён вместе с
мёртвой `cleanupStorage()`, TTL у файлов отсутствует.

## Форматы и опции

### Совместимость форматов

Матрицы попарной совместимости нет. Проверяются только allowlist'ы из
`api/middleware/validate.js`: входной формат — по `ALLOWED_INPUT_FORMATS`, выходной —
по `ALLOWED_OUTPUT_FORMATS`. Всё, что прошло allowlist, передаётся WASM-библиотеке;
поддерживает ли она конкретную пару, заранее не проверяется — неподдерживаемая пара
приводит к ошибке конвертации.

- **Вход:** `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`, `html`, `htm`, `csv`, `pdf`, `epub`
- **Выход:** `pdf`, `pdfa`, `docx`, `xlsx`, `csv`, `txt`, `html`, `png`, `jpg`, `jpeg`, `svg`, `odt`, `ods`, `odp`, `rtf`, `epub`

Следствия: `doc`/`xls`/`ppt` — только на вход; `png`/`jpg`/`svg`/`pdfa` — только на выход;
`htm` — только на вход.

Ранее в `worker/converter.js` жил отдельный список совместимости (`isConversionSupported`)
со своей матрицей форматов, но вызывался он только из неиспользуемого кода и удалён.

### Маппинг опций Р7 → LibreOffice

`worker/optionsMapper.js:287 mapR7OptionsToLibreOffice()`:

| Опция Р7 | Ключ конвертера | Примечание |
|---|---|---|
| `codePage` | `CharSet` | `65001→UTF-8`, `1251→windows-1251`, `1252→windows-1252`, `866→IBM866`, `20866→KOI8-R`, `28595→ISO-8859-5` |
| `delimiter` | `FieldDelimiter` | `1→Tab`, `2→;`, `3→пробел`, `4→,` |
| `region` | `Locale` | `ru→ru-RU`, `en→en-US`, `de→de-DE` и т. д.; строка вида `xx-YY` проходит как есть |
| `documentLayout` | `DrawPlaceholders`, `DrawFormHighlight` | `isPrint` не используется |
| `spreadsheetLayout` | `PageSize`, `Margins`, `FitToWidth`, `FitToHeight`, `Orientation` | Дефолты — A4 и поля 2 см |
| `documentRenderer` | `TextAssociation` | |
| `password` | `Password` | |
| `thumbnail` | — | Не читается |

Плюс формат-специфичные настройки (`mapFormatSpecificOptions`, не экспортируется):
`xlsx → pdf` включает `SinglePageSheets`; `docx → pdf` — экспорт закладок; `pptx → pdf` —
заметки; для текстовых входов с заданным `codePage` добавляется `InputCharSet`.

> **Ловушка.** Комментарий к `SUPPORTED_DELIMITERS` в `config/index.js:230` описывает
> нумерацию как «1 — запятая, 2 — точка с запятой, 3 — двоеточие, 4 — табуляция»,
> а `mapDelimiter` (`optionsMapper.js:111`) реализует `1→Tab, 2→';', 3→' ', 4→','`.
> Ориентироваться нужно на реализацию.

## Слои безопасности

Порядок прохождения запроса:

```
rateLimit → validate (схема + allowlist) → urlGuard (SSRF) → magicBytes → zipGuard → sandbox/изоляция
```

`urlGuard` работает fail-safe: если DNS не резолвится, хост считается приватным и блокируется.
Подробности и полная таблица кодов — в [security.md](security.md).

## Карта модулей

| Файл | Роль |
|---|---|
| `src/config/index.js` | Все таймауты и лимиты с обоснованиями |
| `src/api/server.js` | Сборка Express: middleware, маршруты, заголовки, обработчик ошибок |
| `src/api/routes/convert.js` | `POST /ConvertService.ashx`: валидация, идемпотентность, выбор режима |
| `src/api/routes/status.js` | `GET /status/:taskId` и пакетный `GET /status` |
| `src/api/routes/results.js` | `GET /results/:fileName` — отдача готовых файлов (смонтирован также на `/storage/results`) |
| `src/api/middleware/validate.js` | Схема запроса, allowlist форматов, проверка контента |
| `src/api/middleware/rateLimit.js` | Sliding window на IP (in-memory) |
| `src/api/middleware/auditLog.js` | Аудит-логгер на pino |
| `src/api/middleware/requestId.js` | `X-Request-Id` и `req.requestId` |
| `src/api/middleware/timeouts.js` | Таймауты тела и обработки (`bodyTimeoutMiddleware` не работает — см. ниже) |
| `src/security/limits.js` | Лимиты zip/xml/url — дополняют config |
| `src/security/magicBytes.js` | Сигнатуры форматов |
| `src/security/zipGuard.js` | Проверка архивов без распаковки |
| `src/security/xmlGuard.js` | Эвристики против XXE и XML-бомб |
| `src/security/urlGuard.js` | SSRF-защита |
| `src/queue/connection.js` | Подключение к Valkey |
| `src/queue/conversionQueue.js` | Очередь BullMQ |
| `src/queue/idempotency.js` | Ключи, статусы, прогресс, результаты в Valkey |
| `src/storage/fileStorage.js` | Атомарная запись результатов |
| `src/worker/sandbox.js` | Семафор и бюджет времени синхронного пути |
| `src/worker/fork-pool.js` | Пул fork-процессов |
| `src/worker/fork-worker.js` | Дочерний процесс: вызов WASM |
| `src/worker/index.js` | BullMQ Worker |
| `src/worker/processor.js` | Обработчик задачи очереди |
| `src/worker/converter.js` | Справочник форматов: расширения файлов, контекст задачи |
| `src/worker/optionsMapper.js` | Маппинг опций Р7 → LibreOffice |

`src/index.js` и вложенные `index.js` — плоские реэкспорты; точками входа они не являются.
`default`-экспорты через `export *` не реэкспортируются.

## Как добавить новый формат

Формат добавляется **в четырёх местах** (это сквозное соглашение проекта):

1. `api/middleware/validate.js` — в `ALLOWED_INPUT_FORMATS` и/или `ALLOWED_OUTPUT_FORMATS`.
2. `security/magicBytes.js` — сигнатура в таблице `SIGNATURES` (если формат бинарный).
3. `worker/converter.js` — расширение в карте `getFileExtension` (соответствие
   формата результата расширению файла).
4. `web/src/config.ts` — в `INPUT_FORMATS` / `OUTPUT_FORMATS` и, если нужно,
   в `OUTPUT_FORMAT_LABELS`.

Если формат — ZIP-контейнер, добавьте его в список `zipFormats` в
`api/middleware/validate.js:392` и `worker/processor.js:244`.
Если у формата есть специфичные опции — в `mapFormatSpecificOptions` (`optionsMapper.js:369`).

Планируемый перевод на общий пакет контракта (`packages/contract`) сократит это
до одного места: allowlist, сигнатуры и расширения будут выводиться из одной схемы.

## Известные расхождения и мёртвый код

Список для тех, кто правит код: это места, где поведение отличается от комментариев
или где код недостижим.

**Функциональные:**

1. `xmlGuard` не подключён: `validateXml` импортирован в `processor.js:41`, но не вызывается.
2. `validateZip` в `convert.js:473` и `processor.js:245` вызывается **без проверки результата** —
   реагируют только на исключение, поэтому нарушения-лимиты там не отсекаются.
3. `bodyTimeoutMiddleware` не работает: он подключён после `express.json()`
   (`server.js:54-60`), когда тело уже разобрано, и сразу выходит по раннему условию.
4. `/health` объявлен прямо в `server.js:126` с `const wasmReady = true; // TODO` —
   проверка готовности WASM не выполняется, ответ всегда `ok`.

**Гонки и дефекты:**

5. В `fork-pool.js` на таймауте сначала вызывается `cleanup()`, который помечает процесс
   свободным, и только потом `kill('SIGKILL')` — убитый процесс возвращается в пул,
   и следующая задача упадёт на `child.send`.
6. `checkKeyConflict` (`idempotency.js:351`) в обеих ветках возвращает `{ conflict: false }`.
7. `MAX_TASK_ID_LENGTH = 64` в `reserveTaskId`, тогда как схема допускает `key` до 128 символов:
   ключ длиной 65–128 проходит валидацию, но роняет `reserveTaskId` обычным `Error` → `500`.

**Несоответствия имён и значений:**

8. `STORAGE_WRITE_TIMEOUT_MS` в `.env.example` против `STORE_WRITE_TIMEOUT_MS` в коде.
9. `PORT`/`HOST` из окружения не читаются: порт задаётся только через `API_PORT`.
10. `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_CONNECTION_STRING` объявлены, но не используются —
    подключение идёт без авторизации и всегда в БД 0.
11. TTL статуса задачи различается: 30 с из API против 3600 с из воркера.
12. Три формата `fileUrl`: `/results/{id}.{ext}` (`fileStorage.js`), `/storage/results/{file}`
    (`convert.js:331`) и примеры в JSDoc. Синхронный путь файл не сохраняет вообще.
13. `RATE_PER_SEC` фактически не ограничивает: `allowed` определяется burst-веткой (20 > 5),
    а счётчик инкрементируется после проверки.
14. Экспортируются, но не используются вне своего модуля (часть — только внутри него):
    `getSandboxStats`, `executeInSandbox`, `convertWithWasmSandbox`, `getTaskSemaphore`,
    `resetTaskSemaphore` (`sandbox.js`); `createDefaultOptions`, `mergeOptionsWithDefaults`
    (`optionsMapper.js`); `listResults`, `getResultSize` (`fileStorage.js`).

**Устранено при расчистке мёртвого кода:**

Удалены `worker/wasm-isolate.js` вместе с зависимостью `isolated-vm` и константами
`ISOLATE_MEMORY_MB`/`WORKER_MEMORY_MB`, `worker/fork-runner.js` (вторая реализация пула),
несмонтированный роутер `api/routes/health.js`, заглушка `convertDocumentAsync`,
а также неиспользуемые `resetPool`, `createTaskTimer`, `createCancellableTask`,
`cleanupStorage`, `UnsupportedOptionError`, `validateR7Options`, `cleanupCompletedJobs`
и `cleanupStalledJobs`. Вместе с `isolated-vm` из образа ушёл toolchain `python3/make/g++`.

## Тесты

`npm test` — 76 тестов в `tests/security.test.js`, все фикстуры генерируются кодом
(`tests/helpers/attackFixtures.js`). Покрыты сигнатуры файлов, SSRF, ZIP- и XML-атаки,
схема запроса и сквозные HTTP-проверки через supertest. Не покрыты rate limiting и
изоляция отдельной задачи.

`E2E=1` (`npm run test:e2e`) не переключает ничего: переменная `E2E` не читается ни одним
модулем — запускается тот же набор.
