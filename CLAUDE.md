# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

Сервис конвертации **XLSX → PDF**. Конвертация выполняется нативным
LibreOffice Calc, которым управляет Python-скрипт через **UNO API**
(`docker/uno/uno_convert.py`, `import uno`).

- **Никаких CLI-обёрток**: `soffice --convert-to` и `unoconv` не используются —
  они не дают ни доступа к страничному стилю (подгонка под одну страницу),
  ни полного набора FilterData.
- **Один soffice = один воркер**, `concurrency: 1`. UNO не потокобезопасен;
  параллелизм — только репликами.
- **Все комментарии, JSDoc и сообщения — на русском языке.** Сквозное
  требование проекта.
- **Обоснование каждого числового лимита** документировано рядом с константой
  в `packages/config/src/index.ts` — при изменении лимита обновляй и обоснование.

История: сервис начинался как конвертер на WASM-сборке LibreOffice
(`@matbee/libreoffice-converter` в fork-процессах) с Р7-совместимым API.
От WASM отказались: библиотека 2.x держала ~1.16 ГБ RSS на процесс,
не освобождала память между задачами, и контейнер упирался в `mem_limit`
(в логах — `Conversion failed: No process`). Вместе с ней ушли fork-пул,
Р7-эндпоинты и поддержка остальных форматов. **Не возвращай их.**

## Команды

```bash
pnpm install                       # версия pnpm — из package.json (corepack)
npm run build                      # pnpm -r build: пакеты, затем приложения
npm run typecheck                  # сборка + проверка типов во всех пакетах

pnpm --filter @doc-converter/api build          # одно приложение (с зависимостями)
pnpm --filter @doc-converter/contract build     # одна библиотека

npm run start:api                  # node apps/api/dist/main.js
npm run start:worker               # WORKER_QUEUE=light node apps/worker/dist/index.js
npm run start:autoscaler           # node apps/autoscaler/dist/index.js
npm run dev                        # api + воркер через concurrently

npm test                           # весь набор
NODE_ENV=test npx vitest run tests/complexity.test.js   # один файл
```

Приложения запускаются только из `dist/`: декораторам NestJS нужен
`emitDecoratorMetadata`, с которым нативное стирание типов Node несовместимо.
Тесты же читают **исходники** на TypeScript — сборка перед прогоном не нужна,
за это отвечает `resolve.alias` в `vitest.config.ts`.

Локально ставить зависимости нужно **без фильтра** (`pnpm install`).
Команды `pnpm ci --filter …` из Dockerfile'ов делают `clean` перед установкой
и оставляют только выбранное приложение с зависимостями — остальные теряют
свои `node_modules`, и их проверка типов падает. Фильтр уместен только внутри
образа, где нужен ровно один сервис.

В образах приложений установок **две**, и это не дублирование: `builder`
ставит всё вместе с devDependencies (они нужны сборке), а стадия `prod-deps`
ставит `--prod` в пустой каталог, и из неё собирается runtime. Добавить
`--prod` в установку `builder`'а нельзя — шаг отработает и не изменит ничего
(подробности в `apps/api/Dockerfile`). Список проектов, попадающих в образ,
задан в двух местах: фильтрами `--filter` и списком артефактов в стадии
сборки; правя один, проверьте второй.

Полный стек:

```bash
docker compose up --build      # api, web, три воркера, autoscaler, minio, valkey
docker compose --profile build-only build uno-worker-light   # только образ воркера
```

## Архитектура

### Состав workspace

Репозиторий разделён на запускаемые приложения и переиспользуемые библиотеки.
Границы видны по манифестам: воркер не зависит от `@nestjs/*`, автоскейлер —
от `minio`, а корневой `package.json` перестал быть пакетом-приложением
и держит только инструменты разработки.

```
apps/api          NestJS: приём файлов, статусы, /health
apps/worker       BullMQ-воркер: soffice через UNO
apps/autoscaler   масштабирование реплик в compose
apps/web          интерфейс на Vite + React
packages/contract      zod-схемы и типы — общие для сервера и веба
packages/config        таймауты, лимиты, профили масштабирования
packages/observability логгер pino и аудит-лог
packages/queue         Valkey, очереди BullMQ, состояние задач
packages/storage       MinIO/S3
```

Библиотеки собираются в свой `dist/` раньше приложений: `pnpm -r build` обходит
пакеты топологически, по графу зависимостей. Отдельный порядок в скриптах
поддерживать не нужно.

**Куда класть новый код.** Запускается отдельным процессом — `apps/`;
импортируется больше чем одним приложением — `packages/`. Модуль, нужный
ровно одному приложению, остаётся внутри него (`apps/api/src/security` —
пример: проверка входных файлов нужна только приёмнику).

### Путь одной задачи

```
POST /convert/xlsx-to-pdf  (multipart)
  → apps/api/src/xlsx/xlsx.controller.ts   FileInterceptor, разбор параметров
  → apps/api/src/xlsx/xlsx.service.ts      сигнатура, zip-гард, оценка сложности
  → packages/storage/src/s3.ts             вход в MinIO: incoming/{jobId}.xlsx
  → packages/queue/src/jobStatus.ts        запись состояния: job:{jobId}
  → packages/queue/src/queues.ts           задача в очередь xlsx2pdf.{tier}
                                        ↓
  → apps/worker/src/index.ts               BullMQ Worker, concurrency: 1
  → apps/worker/src/processor.ts           скачать вход → конвертировать → загрузить PDF
  → apps/worker/src/uno-converter.ts       spawn python3 с таймаутом
  → docker/uno/uno_convert.py              UNO → soffice → PDF
```

### Три очереди по сложности

`light` / `medium` / `heavy` — по старшему из двух признаков: размер файла
и число листов (`apps/api/src/xlsx/complexity.ts`, листы читаются из
`xl/workbook.xml` внутри zip через yauzl, без запуска LibreOffice).

Разделение обязательно: одна конвертация занимает воркер целиком, и в общей
очереди крупная книга задерживала бы мелкие файлы.

### Где живёт состояние

- **Valkey/Redis** — очередь BullMQ (`bull:xlsx2pdf.<tier>:*`) и записи
  о задачах `job:{jobId}` (хэш с TTL). Запись переживает задачу в очереди:
  BullMQ удаляет завершённые (`removeOnComplete: true`), а статус должен
  отвечать клиенту ещё сутки.
- **MinIO/S3** — входные файлы и результаты. Общего тома для файлов больше
  нет: воркеры могут жить на разных хостах, поэтому «общий каталог» перестал
  быть общим. Результат отдаётся **presigned-ссылкой**, а не через API.
- Соединения с Redis разделены: у приложения свой клиент
  (`getRedisClient`, `enableOfflineQueue: false`), у очереди — свой
  (`createQueueRedisClient`, опции BullMQ). Разбор причин — в
  `packages/queue/src/connection.ts`.

### UNO-бридж

`docker/uno/worker-entrypoint.sh` запускает `soffice --headless` с
`--accept="socket,host=127.0.0.1,port=2002;urp;"` и **дожидается готовности
подключением по UNO** (`uno_convert.py --ping`), а не проверкой порта: сокет
принимает соединения раньше, чем зарегистрирован сервис-менеджер. Профиль
LibreOffice лежит в `/tmp` — корневая ФС контейнера read-only.

Порт слушает только loopback: у UNO нет аутентификации, и выставленный наружу
порт означал бы возможность выполнить произвольный макрос в чужом процессе.

### Слои проверки запроса

`rateLimit` → `multipart (multer)` → `схема параметров (zod)` →
`сигнатура файла` → `zip-гард` → очередь. Всё, что можно отсеять
до обращения к хранилищу, отсекается до него — это проверяется в
`tests/api.test.js` на наборе без Redis и MinIO.

## Конфигурация

Все таймауты и лимиты — в **`packages/config/src/index.ts`**, с обоснованием рядом
с каждой константой. Не хардкодь числа в модулях.

Два исключения:

- `apps/api/src/security/limits.ts` — лимиты zip-гарда и сигнатур (дополняют config,
  а не дублируют).
- NestJS-слой читает своё подмножество через `apps/api/src/env.ts`
  (`NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `RATE_*`, `TRUST_PROXY`) —
  не при импорте модуля, а при создании приложения (тесты правят окружение
  в `beforeAll`).

`.env.example` — источник истины по переменным окружения.

## Соглашения

- **Формат ошибок API** единый: `{ error: <код>, message, jobId?, requestId? }`,
  код — snake_case из `packages/contract/src/errors.ts`
  (`file_required`, `magic_mismatch`, `storage_unavailable`, …).
  Домен бросает `AppError` со статусом и кодом; в HTTP-ответ их маппит
  `apps/api/src/common/exception.filter.ts`. Всё, что не `AppError`, отдаётся
  как 500 без подробностей — иначе в ответ попадут `err.message` и системные
  коды вроде `ENOENT`.
- **Контракт API живёт в `packages/contract`**: zod-схемы и выведенные типы.
  Сервер берёт оттуда схемы запроса и коды ошибок, веб-интерфейс — типы.
  Своих копий списков у сторон нет.
- **Числовые коды FilterData — только в контракте** (`PDF_VERSION_CODES`):
  в API версия PDF называется так, как её видит пользователь («1.7»,
  «pdfa-2b»), а экспортёр LibreOffice принимает числа.
- **Версия зависимости, встречающейся больше чем в одном манифесте, живёт
  в каталоге** (`catalog:` в `pnpm-workspace.yaml`), а пакеты ссылаются на неё
  протоколом `catalog:`. Диапазон в манифесте не пишется: так `typescript`
  разошёлся на три разных версии, а `zod` — единственная зависимость, которую
  сервер и контракт исполняют совместно, — мог разойтись на две копии
  валидатора в одном процессе. Зависимости, объявленные ровно в одном
  манифесте, в каталог не выносятся.
- **Строгость проверок TypeScript — в `tsconfig.base.json`**, общем для всех
  пакетов; конфиг пакета добавляет только то, что относится к его среде
  (`module`, `lib`, `jsx`, `outDir`). Опция строгости, объявленная в одном
  конфиге и забытая в другом, означает, что один и тот же код принимается
  в одном пакете и отвергается в соседнем.
- Комментарии объясняют «почему», а не «что». Удалённый код не комментируется —
  история остаётся в git.

## Тесты

`tests/` — Vitest, наборы: `complexity` (оценка сложности),
`autoscaler` (правила масштабирования, чистые функции), `api` (маршруты,
отсев до инфраструктуры), `nest` (каркас, формат ошибок, ограничитель).
Фикстуры XLSX генерируются кодом (`tests/helpers/xlsxFixtures.js`), а не
хранятся в репозитории.

Тесты **не требуют** Redis, MinIO и LibreOffice: проверяется всё, что можно
проверить без них. Живая конвертация — предмет интеграционного прогона.

## Непрерывная интеграция

Два workflow'а в `.github/workflows/`, оба только читают репозиторий
(`permissions: contents: read`):

- `ci.yml` — `pnpm ci`, `pnpm -r build`, `pnpm -r typecheck`, `pnpm test`
  и проверка синтаксиса скриптов в `docker/` (`python3 -m py_compile`, `sh -n`).
  Ровно то, что разработчик делает перед коммитом; service-контейнеры
  не поднимаются, потому что набор тестов обходится без Redis и MinIO.
- `images.yml` — сборка трёх образов и разбор `docker-compose.yml`.
  Образы не публикуются: workflow отвечает за то, чтобы правка не сломала
  сборку, а не за доставку.

Версии инструментов workflow'ы не назначают: pnpm берётся из поля
`packageManager`, Node — 24, как в `engines.node` и в Dockerfile'ах. Второго
источника версий нет намеренно.

После сборки проверяется **состав** образа, а не факт сборки: точки входа,
`dist` автоскейлера в образе api (он запускается оттуда же, но зависимостью
api не является), отсутствие инструментов сборки и исходников. Ошибка
в стадиях Dockerfile'а даёт образ, который собирается, но падает в работе,
и без этой проверки проходит незамеченной. **Правя стадии в Dockerfile'ах,
правьте и проверки в `images.yml`** — они перечисляют ожидаемое содержимое
образа.

## Масштабирование

Правила и их обоснование — в README (раздел «Масштабирование»).
Кратко: одна реплика = одна конвертация, `listLength` 5/2/1 для
light/medium/heavy, `minReplicaCount` 0/1/1 (в KEDA), потолок ограничен
памятью узла.

- **Kubernetes** — `deploy/k8s/scaledobject-*.yaml`, масштабирование по длине
  списка BullMQ.
- **docker compose** — сервис `autoscaler`: создаёт и удаляет контейнеры через
  Docker API. Он никогда не трогает стартовые реплики compose (у них нет
  метки `doc-converter.managed`) — иначе `restart: unless-stopped` возвращал бы
  их обратно и autoscaler бесконечно боролся бы с compose.
