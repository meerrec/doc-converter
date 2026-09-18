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
Неочевидное: `dev*` выставляют `NODE_ENV=development`, что включает CORS-заголовки
(`src/nest/common/http-defaults.ts`). Скрипты запускают **собранный** код из `dist/`,
поэтому перед первым `npm run dev` нужна сборка (`npm run build:contract && npm run build:server`).

Локальный запуск требует доступного Valkey/Redis (`REDIS_HOST`/`REDIS_PORT`); для полного стека —
`docker compose up --build` (api + worker + valkey).

### Сервер на NestJS (`src/nest/`)

Сервер работает на NestJS; Express-слоя в репозитории больше нет. Пакет `express`
остался только как HTTP-адаптер Nest (`@nestjs/platform-express`) — своих
middleware и роутеров на нём нет.

```bash
npm run build:server         # tsc → dist/ (NestJS требует декораторов, сборка обязательна)
npm run typecheck:server     # tsc --noEmit
npm run start:api            # node dist/nest/main.js
```

NestJS компилируется, а не запускается напрямую: декораторам нужен
`emitDecoratorMetadata`, с которым нативное стирание типов Node 24 несовместимо.
Домен (`config/`, `security/`, `queue/`, `storage/`, `worker/`) — тоже TypeScript,
в `dist/` попадает целиком; `allowJs` из `tsconfig.json` снят.

`src/config/index.ts` остаётся единственным источником таймаутов и лимитов: его
читают и домен, и Nest-слой. Nest дополнительно разбирает своё подмножество
переменных через `src/nest/config/env.ts` (`NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`,
`RATE_*`) — не при импорте модуля, а при создании приложения.

Ограничитель частоты (`src/nest/common/rate-limit.guard.ts`) реализует ведро
с токенами: ёмкость `RATE_BURST`, пополнение `RATE_PER_SEC`. Прежняя реализация
(Express) проверяла `count < RATE_PER_SEC || count <= RATE_BURST`, и вторая ветка
всегда перекрывала первую — `RATE_PER_SEC` не влиял ни на что. Вместе с переездом
убрано и двойное навешивание ограничителя на маршрут конвертации: раньше один POST
списывал две единицы бюджета.

Аудит-логгер живёт в `src/nest/common/audit-log.ts`, хотя вызывается и из домена
(`worker/sandbox.ts`): логгер создаётся на уровне модуля и работает вне
Nest-контекста, поэтому DI здесь не подходит.

Логирование — `pino` и `pino-http` напрямую (`src/nest/common/logger.ts`).
`nestjs-pino` не подходит: пакет поставляет исходники на TypeScript и требует
сборщик. Оба пакета грузятся через `createRequire` — их объявления типов
не экспортируют вызываемую функцию.

Формат ошибок задаёт `src/nest/common/r7-exception.filter.ts`: Nest по умолчанию
отвечает `{ statusCode, message, error }`, что несовместимо с контрактом Р7.
Всё, что не `AppError`, отдаётся как 500 без подробностей — раньше в ответ
попадали `err.message` и системный `err.code` вроде `ENOENT`.

### Тесты

```bash
npm test                     # весь набор
npm run test:watch           # то же в режиме наблюдения
npm run test:e2e             # то же с E2E=1

# Один файл / один тест
NODE_ENV=test npx vitest run tests/security.test.js
NODE_ENV=test npx vitest run -t "should reject ZIP bomb"
```

Тесты читают **исходники** на TypeScript, а не собранный `dist/`: сборка перед прогоном
не нужна. Раньше её делал `pretest`, и он же страховал от прогона против устаревшего
`dist/` — вместе с переходом на Vitest этот риск ушёл.

Транспиляция идёт через SWC (`unplugin-swc` в `vitest.config.ts`) — не ради TypeScript,
его снимает Vite, а ради метаданных декораторов: NestJS разрешает зависимости конструктора
через `design:paramtypes`, а esbuild эту метаинформацию не порождает, и внедрение
зависимостей в тестах падало бы.

`LOG_LEVEL=silent` и `AUDIT_LOG_LEVEL=error` в тест-скрипте глушат логи: pino и аудит-логгер
пишут в stdout, и без этого вывод тестов не читается.

`lint` — заглушка (`echo 'Linter not configured yet'`); линтер в проекте не настроен.

### Веб-интерфейс (`web/`)

Отдельный пакет Vite + React + TypeScript, включён в pnpm-workspace наравне с
`packages/contract`. Раньше держался на отдельном npm-сторе из-за нативного
`isolated-vm` — после его удаления обособление потеряло смысл.

Ставится и собирается из корня:

```bash
pnpm install                                    # весь workspace
pnpm --filter doc-converter-web dev             # http://localhost:5173, прокси Vite
pnpm --filter doc-converter-web typecheck       # tsc --noEmit (он же входит в build)
pnpm --filter doc-converter-web build           # → web/dist
pnpm --filter @doc-converter/contract build     # контракт: обязателен до сборки web
```

Интерфейс работает только через асинхронный режим (`async: true`): пакетная отправка
не должна ждать конвертацию в HTTP-запросе, а результат забирается по `fileUrl` из статуса.
Статусы опрашиваются одной пачкой через `GET /status?taskIds=…`, отправка идёт через
ограничитель параллелизма (`web/src/lib/limiter.ts`), чтобы не упираться в `RATE_PER_SEC`.

В production статику раздаёт nginx (`web/nginx.conf`, сервис `web` в compose) и он же
проксирует API на `api:3000` — фронт и API на одном origin, поэтому CORS не нужен.

Фикстуры-атаки не лежат в `tests/fixtures/` (пуст) — они генерируются кодом в
`tests/helpers/attackFixtures.js` (через `yazl`): zip-бомбы, path traversal, XML-бомбы, валидные DOCX/PDF.

## Архитектура

Сервис собран из двух **независимых путей выполнения**, и это главное, что нужно понять.

### Синхронный путь (`async: false`) — fork-пул

```
POST /ConvertService.ashx
  → nest/http/convert.controller.ts  схема, SSRF, magic bytes, zip guard, запись результата
  → worker/sandbox.ts                семафор MAX_CONCURRENT + таймаут SYNC_QUEUE_WAIT_MS
  → worker/fork-pool.ts              пул child_process.fork
  → worker/fork-worker.ts            конвертация в дочернем процессе
  → @matbee/libreoffice-converter
```

Изоляция — на уровне ОС: дочерний процесс не имеет доступа к сокетам API, очереди и Valkey.
При таймауте процесс убивается `SIGKILL` (`Promise.race` недостаточен — WASM продолжил бы работу в фоне).

Обмен с дочерним процессом идёт через `process.send` / `process.on('message')` — это `child_process.fork`,
а не worker_threads, поэтому `parentPort` здесь не применяется.

### Асинхронный путь (`async: true`) — BullMQ

```
POST /ConvertService.ashx → 202 + задача в очереди 'conversion'
  → queue/conversionQueue.ts       BullMQ (грузится лениво через await import)
  → worker/index.ts                BullMQ Worker
  → worker/processor.ts            подготовка, валидация, сохранение результата
  → worker/sandbox.ts              тот же fork-пул, что и в sync
  → worker/fork-worker.ts          конвертация в дочернем процессе
```

**Конвертация в обоих режимах идёт через один fork-пул.** Разница только в инициаторе:
sync запускает её из обработчика запроса, async — из обработчика задачи BullMQ.

Ранее существовал третий путь — изолят на `isolated-vm` (`worker/wasm-isolate.js`).
От него отказались: WASM-память не изолируется в пределах потока, а вызов конвертера
через границу изолята падает с ошибкой клонирования. Модуль и зависимость `isolated-vm`
удалены — не возвращай их. Вместе с ними из образа ушёл toolchain `python3/make/g++`.

Опции Р7 библиотека понимает частично: работают `outputFormat`, `inputFormat`, `password`,
`pdf`, `image`; остальное (`CharSet`, `FieldDelimiter`, `PageSize` и пр. из `optionsMapper.ts`)
игнорируется.

### Слои безопасности (в порядке прохождения)

`rateLimit` → `validate` (схема + allowlist форматов/полей) → `urlGuard` (SSRF) → `magicBytes` →
`zipGuard` / `xmlGuard` → sandbox/изоляция. Все они покрыты `tests/security.test.js`.
`urlGuard` работает fail-safe: если DNS не резолвится, хост считается приватным и блокируется.

### Отдача результатов

`src/nest/http/results.controller.ts` (`GET /results/:fileName`) — единственное место,
откуда клиент получает готовый файл. Имя разбирается на taskId и расширение, путь
собирается от `STORAGE_PATH` (файлы лежат плоско), расширение сверяется с allowlist
выходных форматов. Контроллер смонтирован дважды — на `/results` и `/storage/results`:
оба пути формируют одинаковый `fileUrl` (`/results/{id}.{ext}`, `writeResult`), но
историческая форма ссылки обязана работать, потому что клиент использует её дословно.

### Состояние

- **Valkey/Redis** (ioredis) — идемпотентность по `key` (`task:{id}:owner` через `SET NX EX`), статусы,
  прогресс, результаты, метаданные. Всё в `queue/idempotency.ts`.
- **Файловая система** — результаты конвертации в `STORAGE_PATH`, атомарная запись
  (`.tmp` → `rename` → `chmod 0o444`). `storage/fileStorage.ts`.

## Конфигурация

Все таймауты и лимиты — в **`src/config/index.ts`**. Не хардкодь числа в модулях — добавляй константу
в config вместе с комментарием-обоснованием.

Два исключения, о которых легко забыть:

- `src/security/limits.ts` — отдельный набор лимитов для zip/xml/url (не дублирует config, а дополняет).
- Прямые чтения `process.env` вне config: `nest/common/audit-log.ts` (`AUDIT_LOG_PATH`,
  `AUDIT_LOG_LEVEL`), `worker/fork-worker.ts` (`LO_CONVERTER_VERBOSE`). NestJS-слой читает
  своё подмножество через `nest/config/env.ts`.

`.env.example` — источник истины по переменным окружения, включая те, что пока не читаются кодом.

`SYNC_TIMEOUT_MS` обязан быть меньше таймаута балансировщика (nginx `proxy_read_timeout`), иначе клиент
получит оборванное соединение вместо 504.

## Соглашения

- Формат ошибок API — единый: `{ error: <код>, message, taskId? }`, где код — snake_case
  (`magic_mismatch`, `url_private_ip`, `field_type_mismatch`, …). Домен бросает `AppError`
  с `statusCode` и кодом; в HTTP-ответ их маппит `nest/common/r7-exception.filter.ts`.
- Контракт API живёт в `packages/contract`: zod-схемы и выведенные из них типы.
  Списки форматов, кодировки, коды ошибок и схему запроса сервер берёт оттуда —
  своих копий у него больше нет. Остаются два серверных справочника, которые
  приходится править вместе с контрактом: сигнатуры в `security/magicBytes.ts`
  и карта расширений в `worker/converter.ts` (`getFileExtension`).
- `vm2` не использовать никогда.
- Нативных модулей в зависимостях нет — образ собирается без компилятора. Если появится
  новый, помни: он потребует toolchain в стадии builder `Dockerfile`.
- Библиотеке конвертера нужен **явный `wasmLoader`**: подпуть `…/wasm/loader.cjs` не объявлен
  в `exports` пакета, поэтому импортируется по абсолютному пути через `pathToFileURL`.
  Без загрузчика инициализация падает с `WASM_NOT_INITIALIZED`.
