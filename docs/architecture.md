# Архитектура

## Структура репозитория

Монорепозиторий на pnpm-workspace:

| Каталог | Роль |
|---|---|
| `src/` | Сервер: API (NestJS) и воркер очереди. Корневой пакет `doc-converter` |
| `packages/contract/` | **Контракт API**: zod-схемы и выведенные из них типы. Общий для сервера и веба |
| `web/` | Интерфейс: Vite + React + TypeScript |
| `tests/` | Тесты сервера (Jest + supertest) |

`packages/contract` — единственный источник правды по формам запросов и ответов,
спискам форматов, кодировкам и кодам ошибок. Схемы написаны на zod, поэтому из одной
схемы выводятся и тип для TypeScript, и рантайм-проверка: разойтись между сервером
и клиентом они не могут. Контракт потребляют и веб, и сервер.

Порядок сборки: контракт собирается **до** сервера и веба
(`pnpm --filter @doc-converter/contract build`) — он подключается как workspace-пакет
и резолвится в собранный `dist`.

## Пути выполнения

Сервис собран из двух **независимых путей выполнения**, и это главное, что нужно понять
перед правкой кода.

| | Синхронный путь (`async: false`) | Асинхронный путь (`async: true`) |
|---|---|---|
| Где выполняется | Процесс API | Отдельный процесс `worker` |
| Роль | Немедленный ответ с результатом | Очередь, устойчивость к пикам нагрузки |
| Изоляция | `child_process.fork` (изоляция ОС) | та же: `child_process.fork` |
| Ограничение параллелизма | Семафор `MAX_CONCURRENT` + пул `FORK_POOL_SIZE` | `concurrency: MAX_CONCURRENT` в BullMQ + свой семафор воркера |
| Точка входа | `nest/http/convert.controller.ts` → `worker/sandbox.ts` | `queue/conversionQueue.ts` → `worker/index.ts` → `worker/processor.ts` → `worker/sandbox.ts` |
| Движок | `worker/fork-worker.ts` → `@matbee/libreoffice-converter` | тот же |

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
  → nest/http/convert.controller.ts  схема, SSRF, magic bytes, zip guard, запись результата
  → worker/sandbox.ts                семафор MAX_CONCURRENT + таймаут SYNC_QUEUE_WAIT_MS
  → worker/fork-pool.ts              пул child_process.fork
  → worker/fork-worker.ts            конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

### Пошагово

1. **Семафор** (`sandbox.ts`, класс `Semaphore`). Синглтон `Semaphore(MAX_CONCURRENT)` = 4 слота.
   Синхронный запрос ждёт слот не дольше `SYNC_QUEUE_WAIT_MS` (5 с).
2. **Пул** (`fork-pool.ts`). `runTask()` берёт свободный процесс из пула, при
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
6. **Общий бюджет.** Параллельно в контроллере тикает таймер `SYNC_TIMEOUT_MS` (30 с), по которому
   клиент получает `504 sync_timeout`.

Обмен идёт через `process.send` / `process.on('message')` — это `child_process.fork`,
а не `worker_threads`, поэтому `parentPort` здесь не применяется.

### Что важно знать про этот путь

- Дочерний процесс вызывает библиотеку **напрямую** (`fork-worker.ts`), минуя
  `worker/converter.ts` и `worker/optionsMapper.ts`. Значит здесь нет ни проверки совместимости
  форматов, ни маппинга опций Р7 — из `options` используется только `password`.
- Ошибки пересекают границу процесса **строкой**: `errorCode` и `statusCode` теряются,
  поэтому наружу почти всегда уходит `500` с кодом `internal` или `conversion_failed`.

## Асинхронный путь

```
POST /ConvertService.ashx → 202 + задача в очереди 'conversion'
  → queue/conversionQueue.ts       BullMQ (грузится лениво через await import)
  → worker/index.ts                BullMQ Worker
  → worker/processor.ts            подготовка, валидация, сохранение результата
  → worker/sandbox.ts              семафор + бюджет времени
  → worker/fork-pool.ts            пул child_process.fork (тот же, что в sync)
  → worker/fork-worker.ts          конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

### Пошагово

1. **Постановка в очередь** (`nest/http/convert.controller.ts`). `addConversionJob` кладёт
   `{ taskId, inputBuffer (base64), inputFormat, outputFormat, options, requestId }`
   с `jobId = taskId`. Ответ клиенту — `202` с `taskId`.
2. **Воркер** (`worker/index.ts`). `new Worker('conversion', processJob, { concurrency: MAX_CONCURRENT, lockDuration: BULLMQ_LOCK_DURATION, stalledInterval: BULLMQ_STALLED_INTERVAL })`.
3. **Обработка** (`worker/processor.ts`): проверка `job.data` → декодирование base64 →
   `checkMagicBytes` → `validateZip` для офисных форматов → маппинг опций →
   `convertWithLimits` (fork-пул) → `saveFile` → запись статуса и результата в Valkey.
   Прогресс пишется через `job.updateProgress(10 / 20 / 30 / 90 / 100)`.
4. **Конвертация** — та же, что в синхронном пути: `sandbox.convertWithLimits` берёт слот
   семафора, отдаёт задачу в `fork-pool`, а тот запускает `fork-worker`. По истечении
   `JOB_TIMEOUT_MS` процесс получает `SIGKILL`.

### Что важно знать про этот путь

- `async: true` в docker-compose обслуживает отдельный контейнер `worker`
  (у него `SYNC_ENABLED=false`).
- Очередь называется `conversion`; имя продублировано константой в `worker/index.ts`.
- `bullmq` загружается ленивым `await import()`: его CJS-сборка тянет ESM-only `msgpackr`,
  и статический импорт сломал бы запуск API-сервера.
- **Прогресс нельзя обновлять в обработчике `completed`.** Задача к этому моменту уже
  удалена из очереди (`removeOnComplete: true`), и вызов `job.updateProgress` падает
  с «Missing key for job», роняя процесс воркера. Итоговый прогресс пишется в `processor.js`.
- **Опции Р7 поддерживаются частично.** Библиотека принимает `outputFormat`, `inputFormat`,
  `password`, `pdf` и `image` — всё остальное (`CharSet`, `FieldDelimiter`, `PageSize`,
  `Margins` и прочее, что формирует `optionsMapper.ts`) она игнорирует. Практический эффект
  сейчас даёт только пароль документа.

## Состояние

### Valkey/Redis

Клиент — `ioredis` (`queue/connection.ts`), префикс ключей — `task:`.

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

`storage/fileStorage.ts` пишет результат атомарно: `.tmp` → `rename` → `chmod 0o444`.
Запись идёт в `STORAGE_PATH`. Автоматической очистки нет: механизм удалён вместе с
мёртвой `cleanupStorage()`, TTL у файлов отсутствует.

## Форматы и опции

### Совместимость форматов

Матрицы попарной совместимости нет. Проверяются только allowlist'ы из контракта
(`packages/contract`): входной формат — по `INPUT_FORMATS`, выходной — по `OUTPUT_FORMATS`;
применяет их `nest/http/validation.pipe.ts`. Всё, что прошло allowlist, передаётся WASM-библиотеке;
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
| `src/config/index.ts` | Все таймауты и лимиты с обоснованиями |
| `src/nest/main.ts` | Точка входа API (`node dist/nest/main.js`) |
| `src/nest/bootstrap.ts` | Сборка приложения: логгер, заголовки, обработчик тела, слушающий сокет |
| `src/nest/app.module.ts` | Корневой модуль: разбор окружения, контроллеры, глобальный ограничитель |
| `src/nest/http/convert.controller.ts` | `POST /ConvertService.ashx`: валидация, идемпотентность, выбор режима |
| `src/nest/http/status.controller.ts` | `GET /status/:taskId` и пакетный `GET /status` |
| `src/nest/http/results.controller.ts` | `GET /results/:fileName` — отдача готовых файлов (смонтирован также на `/storage/results`) |
| `src/nest/http/validation.pipe.ts` | Схема запроса из контракта, allowlist форматов и полей |
| `src/nest/conversion/conversion.service.ts` | Конвейер: источник → проверка содержимого → fork-пул → результат |
| `src/nest/conversion/content-validator.ts` | Сигнатуры формата и проверка ZIP-контейнеров |
| `src/nest/conversion/url-source.ts` | Загрузка файла по ссылке (SSRF, Content-Type, лимит размера) |
| `src/nest/common/rate-limit.guard.ts` | Ведро с токенами на IP (in-memory) |
| `src/nest/common/audit-log.ts` | Аудит-логгер на pino |
| `src/nest/common/r7-exception.filter.ts` | Формат ошибок контракта Р7 |
| `src/nest/common/http-defaults.ts` | Заголовки безопасности, CORS, лимит тела |
| `src/nest/config/env.ts` | Разбор переменных окружения NestJS-слоя |
| `src/security/limits.ts` | Лимиты zip/xml/url — дополняют config |
| `src/security/magicBytes.ts` | Сигнатуры форматов |
| `src/security/zipGuard.ts` | Проверка архивов без распаковки |
| `src/security/xmlGuard.ts` | Эвристики против XXE и XML-бомб |
| `src/security/urlGuard.ts` | SSRF-защита |
| `src/queue/connection.ts` | Подключение к Valkey |
| `src/queue/conversionQueue.ts` | Очередь BullMQ |
| `src/queue/idempotency.ts` | Ключи, статусы, прогресс, результаты в Valkey |
| `src/storage/fileStorage.ts` | Атомарная запись результатов |
| `src/worker/sandbox.ts` | Семафор и бюджет времени синхронного пути |
| `src/worker/fork-pool.ts` | Пул fork-процессов |
| `src/worker/fork-worker.ts` | Дочерний процесс: вызов WASM |
| `src/worker/index.ts` | BullMQ Worker |
| `src/worker/processor.ts` | Обработчик задачи очереди |
| `src/worker/converter.ts` | Справочник форматов: расширения файлов, контекст задачи |
| `src/worker/optionsMapper.ts` | Маппинг опций Р7 → LibreOffice |

`src/index.ts` и вложенные `index.ts` — плоские реэкспорты; точками входа они не являются.
`default`-экспорты через `export *` не реэкспортируются.

Домен (`config/`, `security/`, `queue/`, `storage/`, `worker/`) не зависит от NestJS:
`worker/sandbox.ts` вызывается и из HTTP-слоя, и из воркера очереди, а
`nest/common/audit-log.ts` — единственное место, куда домен импортирует из `nest/`.

## Как добавить новый формат

Формат добавляется **в три места** (это сквозное соглашение проекта):

1. `packages/contract/src/formats.ts` — в `INPUT_FORMATS` и/или `OUTPUT_FORMATS`
   (и в `FILE_EXTENSIONS`, если расширение файла не совпадает с именем формата).
   Отсюда список берут и сервер, и веб.
2. `security/magicBytes.ts` — сигнатура в таблице `SIGNATURES` (если формат бинарный):
   в контракте сигнатур нет, это серверный справочник.
3. `web/src/config.ts` — в `OUTPUT_FORMAT_LABELS`, если нужно человекочитаемое имя.

Если формат — ZIP-контейнер, добавьте его в `ZIP_CONTAINER_FORMATS` контракта
(это нужно HTTP-пути: `nest/conversion/content-validator.ts` берёт набор оттуда)
**и** в захардкоженный список в `worker/processor.ts` — асинхронный путь до контракта
ещё не переведён (см. «Известные расхождения»).
Если у формата есть специфичные опции — в `mapFormatSpecificOptions` (`optionsMapper.ts`).

## Известные расхождения и мёртвый код

Список для тех, кто правит код: это места, где поведение отличается от комментариев
или где код недостижим.

**Функциональные:**

1. `validateXml` не вызывается ни одним модулем сервиса (только тестами): XML-проверки
   в конвейере не участвуют.
2. `validateZip` в асинхронном пути (`worker/processor.ts`) вызывается **без проверки
   результата** — обработчик реагирует только на исключение, поэтому нарушения-лимиты
   (число записей, коэффициент сжатия, глубина вложенности) там не отсекаются.
   HTTP-путь разбирает результат и отклоняет запрос с 422
   (`nest/conversion/content-validator.ts`).
3. Таймаут тела запроса (`408 body_timeout`) не реализован: код ошибки есть в контракте
   и в фильтре (`nest/common/r7-exception.filter.ts`), но приём тела ограничен только
   размером (`BODY_LIMIT_BYTES`). Middleware таймаутов удалён вместе с Express-слоем.
4. `GET /health` всегда отдаёт `wasm: true` — готовность движка не проверяется
   (`nest/health/health.controller.ts`); её роль играет docker healthcheck.
5. Отказы по схеме, сигнатурам и архиву не попадают в аудит-лог: они бросаются как
   `AppError` и обрабатываются фильтром, который в аудит не пишет. Подробности и способ
   восстановить паритет — в [security.md](security.md#известные-ограничения).

**Гонки и дефекты:**

6. В `fork-pool.ts` на таймауте сначала вызывается `cleanup()`, который помечает процесс
   свободным, и только потом `kill('SIGKILL')` — убитый процесс возвращается в пул,
   и следующая задача упадёт на `child.send`.
7. `checkKeyConflict` (`queue/idempotency.ts`) в ветке без метаданных возвращает
   `{ conflict: false }` в обоих случаях, а вычисленный статус не используется.
8. `MAX_TASK_ID_LENGTH = 64` в `reserveTaskId`, тогда как схема допускает `key` до 128 символов:
   ключ длиной 65–128 проходит валидацию, но роняет `reserveTaskId` обычным `Error` → `500`.
9. `ZipGuardError` несёт поле `code`, а не `errorCode`/`statusCode`, поэтому повреждённый
   архив отдаётся наружу как 500 `internal`, а не 422.

**Несоответствия имён и значений:**

10. `STORAGE_WRITE_TIMEOUT_MS` в `.env.example` против `STORE_WRITE_TIMEOUT_MS` в коде.
11. `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_CONNECTION_STRING` объявлены, но не используются —
    подключение идёт без авторизации и всегда в БД 0.
12. TTL статуса задачи различается: 30 с из API (`SYNC_TIMEOUT_MS / 1000`) против 3600 с
    из воркера (`IDEMPOTENCY_TTL_SEC`).
13. `getFileExtension` в `worker/converter.ts` дословно повторяет `FILE_EXTENSIONS`
    из контракта — две копии одной карты форматов.
14. Экспортируются, но не используются вне своего модуля (часть — только внутри него):
    `getSandboxStats`, `executeInSandbox`, `convertWithWasmSandbox`, `getTaskSemaphore`,
    `resetTaskSemaphore` (`sandbox.ts`); `createDefaultOptions`, `mergeOptionsWithDefaults`
    (`optionsMapper.ts`); `listResults`, `getResultSize` (`fileStorage.ts`).

**Устранено при расчистке мёртвого кода:**

Удалены `worker/wasm-isolate.js` вместе с зависимостью `isolated-vm` и константами
`ISOLATE_MEMORY_MB`/`WORKER_MEMORY_MB`, `worker/fork-runner.js` (вторая реализация пула),
несмонтированный роутер `api/routes/health.js`, заглушка `convertDocumentAsync`,
а также неиспользуемые `resetPool`, `createTaskTimer`, `createCancellableTask`,
`cleanupStorage`, `UnsupportedOptionError`, `validateR7Options`, `cleanupCompletedJobs`
и `cleanupStalledJobs`. Вместе с `isolated-vm` из образа ушёл toolchain `python3/make/g++`.

При удалении Express-слоя (`src/api/`, этап 4) ушли: `validateBodyMiddleware`,
`rateLimit` (sliding window), `requestId` и `timeouts` как Express-middleware,
роутеры `convert.js`/`status.js`/`results.js` и сборка приложения в `server.js`.
Заодно устранены два расхождения, которые там жили: `RATE_PER_SEC` не ограничивал
ничего (burst-ветка перекрывала его всегда), а `fileUrl` синхронного пути отличался
от асинхронного — теперь результат синхронного запроса пишется тем же `writeResult`.

## Тесты

`npm test` — четыре набора: `tests/security.test.js` (основной, 76 тестов),
`tests/nest.test.js`, `tests/results.test.js`, `tests/status.test.js`. Фикстуры-атаки
генерируются кодом (`tests/helpers/attackFixtures.js`). Покрыты сигнатуры файлов, SSRF,
ZIP- и XML-атаки, схема запроса, отдача результатов и сквозные HTTP-проверки через
supertest. Не покрыты ограничитель частоты (в тестах лимиты подняты) и изоляция
отдельной задачи.

Тесты работают с собранным `dist/` — и сервер, и домен: Jest не читает TypeScript без
транспиляции. Сборку перед прогоном делает `pretest`; прямой вызов `npx jest` её
не выполняет и может прогнать набор против устаревшего `dist/`.

`E2E=1` (`npm run test:e2e`) не переключает ничего: переменная `E2E` не читается ни одним
модулем — запускается тот же набор.
