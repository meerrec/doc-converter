# doc-converter

Сервис конвертации документов с HTTP API, совместимым с **Р7-Офис** (`POST /ConvertService.ashx`).

Конвертация выполняется **исключительно через WASM-сборку LibreOffice**
(`@matbee/libreoffice-converter`) — нативного LibreOffice в образе нет и добавлять его не следует.

- ESM, Node.js ≥ 20
- Два независимых пути выполнения: синхронный (fork-пул) и асинхронный (BullMQ)
- Состояние — в Valkey/Redis, результаты — в файловом хранилище
- Веб-интерфейс в `web/` (Vite + React + TypeScript), раздаётся отдельным контейнером nginx
- Все комментарии, JSDoc и сообщения в коде — на русском языке

## Возможности

| | |
|---|---|
| **Синхронный режим** | `async: false` — конвертация в рамках HTTP-запроса, ответ содержит готовый `fileUrl` |
| **Асинхронный режим** | `async: true` — задача ставится в очередь BullMQ, ответ `202` с `taskId` |
| **Идемпотентность** | Поле `key` резервируется в Valkey через `SET NX EX`; повторный запрос с тем же ключом не запускает вторую конвертацию |
| **Два источника** | `url` (файл скачивается сервисом, только публичный http/https-хост) или `data` (base64 в теле запроса) — ровно одно из двух. В конфигурации compose внешняя сеть закрыта, поэтому там работает только `data` |
| **Опции Р7-Офис** | `codePage`, `delimiter`, `region`, `documentLayout`, `spreadsheetLayout`, `documentRenderer`, `password` |
| **Защита** | rate limit, SSRF-guard, проверка сигнатур файлов, zip-guard, изоляция выполнения |

## Быстрый старт

```bash
docker compose up --build
curl http://localhost:3000/health    # API
open http://localhost:8080           # веб-интерфейс
```

Поднимаются `web` (nginx с интерфейсом), `api`, `worker` и `valkey`.
Наружу открыты порты `8080` (интерфейс) и `3000` (API).

Для локального запуска без Docker понадобится доступный Valkey/Redis:

```bash
pnpm install
npm run build:contract   # контракт — рантайм-зависимость сервера
npm run build:server     # dist/ — сервер запускается только из сборки
npm run dev              # api + worker через concurrently
npm run health           # curl http://localhost:3000/health | jq
```

## Веб-интерфейс

В каталоге `web/` — SPA на Vite + React + TypeScript: выбор файлов перетаскиванием,
параметры конвертации, очередь задач с прогрессом и скачиванием результата.
Интерфейс работает через асинхронный режим API (`async: true`) и опрашивает
`GET /status` одной пачкой на все активные задачи.

Интерфейс входит в общий pnpm-workspace, поэтому ставится и запускается из корня:

```bash
pnpm install
pnpm --filter doc-converter-web dev   # http://localhost:5173, прокси Vite
```

В production статику раздаёт отдельный контейнер nginx (см. `web/nginx.conf`),
который проксирует API на сервис `api` — фронтенд и API оказываются на одном origin,
поэтому CORS не нужен.

```bash
pnpm --filter @doc-converter/contract build   # контракт — до сборки интерфейса
pnpm --filter doc-converter-web typecheck     # tsc --noEmit
pnpm --filter doc-converter-web build         # tsc --noEmit + vite build → web/dist
```

## Контракт API

`packages/contract` — zod-схемы и выведенные из них типы, общие для сервера
и веб-интерфейса: формы запросов и ответов, списки форматов, кодировки,
разделители и коды ошибок. Из одной схемы получаются и тип для TypeScript,
и рантайм-проверка, поэтому серверная и клиентская стороны не могут разойтись.

## Пример использования

Синхронная конвертация DOCX в PDF:

```bash
curl -X POST http://localhost:3000/ConvertService.ashx \
  -H 'Content-Type: application/json' \
  -d '{
        "async": false,
        "filetype": "docx",
        "outputtype": "pdf",
        "url": "http://storage.internal/files/report.docx",
        "key": "task-123"
      }'
```

```json
{
  "status": "success",
  "fileUrl": "/storage/results/task-123.pdf",
  "fileType": "pdf",
  "taskId": "task-123"
}
```

Асинхронная конвертация и опрос статуса:

```bash
curl -X POST http://localhost:3000/ConvertService.ashx \
  -H 'Content-Type: application/json' \
  -d '{"async": true, "filetype": "xlsx", "outputtype": "pdf", "data": "<base64>", "key": "task-456"}'

curl http://localhost:3000/status/task-456
```

Полное описание полей, ответов и кодов ошибок — в [docs/api.md](docs/api.md).

## Форматы

**Вход:** `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`,
`html`, `htm`, `csv`, `pdf`, `epub`

**Выход:** `pdf`, `pdfa`, `docx`, `xlsx`, `csv`, `txt`, `html`, `png`, `jpg`, `jpeg`,
`svg`, `odt`, `ods`, `odp`, `rtf`, `epub`

Матрицы попарной совместимости нет: проверяется, что входной формат есть в списке входных,
а выходной — в списке выходных. Подробности — в [docs/architecture.md](docs/architecture.md#форматы-и-опции).

## Документация

| Документ | О чём |
|---|---|
| [docs/api.md](docs/api.md) | Справочник API: эндпоинты, схема запроса, форматы ответов, коды ошибок |
| [docs/architecture.md](docs/architecture.md) | Внутреннее устройство: два пути выполнения, поток данных, где что менять |
| [docs/security.md](docs/security.md) | Слои защиты: SSRF, сигнатуры файлов, zip-guard, изоляция, аудит-лог |
| [docs/configuration.md](docs/configuration.md) | Все переменные окружения и лимиты с обоснованиями |
| [docs/deployment.md](docs/deployment.md) | Docker, compose, ресурсы, healthcheck, диагностика |

`CLAUDE.md` — краткая инструкция для работы с репозиторием (команды, соглашения, архитектурные акценты).

## Архитектура в двух словах

```
POST /ConvertService.ashx
  → nest/http/convert.controller.ts  схема, SSRF, magic bytes, zip guard, запись результата
  → worker/sandbox.ts                семафор MAX_CONCURRENT + таймаут SYNC_QUEUE_WAIT_MS
  → worker/fork-pool.ts              пул child_process.fork
  → worker/fork-worker.ts            конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

Асинхронный путь — та же конвертация, но запускаемая из очереди:

```
POST /ConvertService.ashx → 202 + задача в очереди 'conversion'
  → queue/conversionQueue.ts  BullMQ
  → worker/index.ts           BullMQ Worker
  → worker/processor.ts       подготовка, валидация, сохранение результата
  → worker/sandbox.ts         тот же fork-пул
  → worker/fork-worker.ts     конвертация в дочернем процессе
```

Оба режима используют один механизм конвертации — fork-пул с изоляцией на уровне ОС
и принудительным завершением процесса по таймауту. Разница только в том, кто её
запускает: обработчик HTTP-запроса или обработчик задачи очереди.

## Команды

```bash
pnpm install                 # Dockerfile ставит зависимости через pnpm ci

npm run build:contract       # контракт: обязателен до сборки сервера и веба
npm run build:server         # tsc → dist/ (сервер запускается только из сборки)

npm run dev                  # API + worker вместе (NODE_ENV=development, включает CORS)
npm run dev:api              # только API
npm run dev:worker           # только BullMQ worker

npm run start                # то же, но NODE_ENV=production
npm run health               # curl http://localhost:3000/health | jq
```

## Тесты

```bash
npm test                     # весь набор
npm run test:e2e             # то же с E2E=1

# Один файл / один тест
NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit tests/security.test.js
NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit -t "should reject ZIP bomb"
```

`NODE_OPTIONS=--experimental-vm-modules` обязателен: Jest запускается на ESM без транспиляции
(`transform: {}` в `jest.config.js`) и без него падает на `import`.

`--forceExit` нужен потому, что Jest иначе виснет на открытых хендлах — HTTP-сервер,
поднятый в тестах через `createServer()`, `setInterval` в rate limit и пул fork-процессов.

Фикстур-атаки не лежат в `tests/fixtures/` — они генерируются кодом в
`tests/helpers/attackFixtures.js` (zip-бомбы, path traversal, XML-бомбы, валидные DOCX/PDF).

## Требования

- Node.js ≥ 20
- Доступный Valkey или Redis (`REDIS_HOST`/`REDIS_PORT`)
- Для полного стека — Docker и Docker Compose

`SYNC_TIMEOUT_MS` обязан быть меньше таймаута балансировщика (nginx `proxy_read_timeout`),
иначе клиент получит оборванное соединение вместо 504.

## Лицензия

MIT — см. [LICENSE](LICENSE).
