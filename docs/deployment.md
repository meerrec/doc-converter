# Развёртывание и эксплуатация

## Быстрый старт

```bash
docker compose up --build
curl http://localhost:3000/health    # API
open http://localhost:8080           # веб-интерфейс
```

Поднимаются четыре сервиса: `web` (nginx с интерфейсом), `api`, `worker`, `valkey`.
Наружу открыты порт интерфейса (8080) и порт API (3000).

## Сервисы

| Сервис | Контейнер | Роль | Порты | Ресурсы |
|---|---|---|---|---|
| `web` | `doc-converter-web` | Веб-интерфейс: nginx раздаёт SPA и проксирует API | `8080:80` | `mem_limit 128m`, `cpus 0.25`, `pids_limit 64` |
| `api` | `doc-converter-api` | HTTP API: приём запросов, валидация, синхронная конвертация через fork-пул | `3000:3000` | `mem_limit 3g` (swap выключен), `cpus 1.0`, `pids_limit 256` |
| `worker` | `doc-converter-worker` | BullMQ-воркер: асинхронные задачи через fork-пул | нет | `mem_limit 3g`, `cpus 2.0`, `pids_limit 512` |
| `valkey` | `doc-converter-valkey` | Очередь, идемпотентность, статусы задач | нет | `mem_limit 512m`, `cpus 0.5`, `pids_limit 100` |

Интерфейс доступен на `http://localhost:8080`. Порт `3000` публикуется отдельно —
он остаётся точкой входа для интеграций, которые обращаются к API напрямую.

### Как устроена раздача интерфейса

Контейнер `web` — это nginx с собранной статикой (`web/Dockerfile`, стадия сборки Vite +
`nginx:alpine`). Конфигурация `web/nginx.conf`:

- отдаёт статику из `/usr/share/nginx/html` со SPA-fallback на `index.html`;
- проксирует `/(ConvertService.ashx|status|health|results|storage)` на `api:3000`;
- `client_max_body_size 50m` — лимит интерфейса; у API потолок выше
  (`BODY_LIMIT_BYTES = MAX_BODY_BYTES` = 100 МиБ), поэтому через веб документ крупнее
  50 МБ не загрузить, хотя напрямую в API он пройдёт;
- `proxy_read_timeout 60s` — больше `SYNC_TIMEOUT_MS` (30 с);
- ассеты с хешем в имени кешируются на год, `index.html` — без кеша.

Фронтенд и API оказываются на одном origin, поэтому CORS (который у сервиса включается
только при `NODE_ENV=development`) не требуется, а CSP из `src/nest/common/http-defaults.ts`
не мешает загрузке.

Оба сервиса приложения собираются из одного `Dockerfile`; `worker` переопределяет команду
на `node /app/dist/worker/index.js` (`docker-compose.yml`) и получает `SYNC_ENABLED=false` —
синхронный режим обслуживает только `api`.

Порядок запуска задан через `depends_on: condition: service_healthy`: `api` и `worker`
стартуют после того, как `valkey` начнёт отвечать на `PING`.

## Образ

`Dockerfile` — двухстадийная сборка на `node:24-bookworm-slim`:

1. **builder** — установка шрифтов (`fonts-dejavu-core`, `fonts-liberation`, `fonts-noto-cjk`,
   `fonts-noto-core`), создание непривилегированного пользователя `conv`, установка
   зависимостей через `pnpm ci --filter doc-converter...`, сборка контракта
   (`pnpm --filter @doc-converter/contract build`) и сервера (`npm run build:server`).
   Инструменты сборки нативных модулей (`python3`, `make`, `g++`) не нужны: нативных
   зависимостей нет.
2. **финал** — перенос `/app` целиком вместе с `node_modules` и собранным `dist`,
   создание каталогов `/data/storage`, `/var/log/converter`, `/tmp` с правами `750`
   и владельцем `conv:conv`.

> **Сборка обязательна.** `.dockerignore` исключает `dist`, а сервер импортирует контракт
> и стартует с `dist/nest/main.js`. Без шагов сборки в builder образ соберётся,
> но упадёт на старте — проверять именно `docker compose build`, а не локальный `npm test`.

Контейнер работает от пользователя `conv` (`USER conv`, продублировано в compose),
слушает `3000`.

WASM-движок отдельно не устанавливается: он приходит как npm-зависимость
`@matbee/libreoffice-converter` (предсобранные `soffice.wasm.gz` и `soffice.data.gz` внутри пакета).
Шрифты нужны именно ему — от них зависит отрисовка текста в PDF.

`NODE_OPTIONS` в образе (`ENV NODE_OPTIONS` в `Dockerfile`):

```
--disable-wasm-trap-handler --max-old-space-size=1536 --unhandled-rejections=strict
```

`--disable-wasm-trap-handler` убирает 10-гигабайтный виртуальный резерв V8, иначе процесс
не укладывается в `mem_limit: 3g`.

## Ужесточение контейнера

Для `api` и `worker` задано:

```yaml
user: conv
read_only: true
tmpfs: /tmp:size=512m,mode=1777
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
ulimits: { nofile: { soft: 4096, hard: 8192 } }
```

Корневая файловая система только для чтения; запись идёт в тома (`/data/storage`,
`/var/log/converter`) и в `tmpfs` `/tmp` — там `fork-worker` держит профиль LibreOffice
(`/tmp/libreoffice-profile`).

`valkey` работает от root образа с `cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE]`
и `--appendonly yes` (AOF-персистентность в том `valkey-data`).

## Сеть и тома

Все сервисы — в одной bridge-сети `converter` с флагом `internal: true`.
Контейнеры видят друг друга по именам сервисов (`REDIS_HOST=valkey`), наружу открыт
только проброшенный порт API.

> **Важно.** `internal: true` отключает исходящий трафик во внешнюю сеть для **всех** сервисов
> сети, включая `api`, поэтому конвертация по внешнему `url` (`"url": "https://…"`)
> в такой конфигурации не работает — скачивание из интернета заблокировано.
>
> Внутренний адрес тоже не подойдёт: SSRF-защита (`urlGuard`) блокирует приватные
> диапазоны и имена с подстроками `localhost`/`local`/`internal`/`private`/`intranet`,
> так что соседний контейнер по `url` не забрать. Практический вывод: **в этой конфигурации
> источник передаётся полем `data`** (base64), а не ссылкой. Если `url` нужен, придётся
> снять `internal: true` (и ограничивать SSRF иначе) и использовать публичный хост.

Тома:

| Том | Точка монтирования | Содержимое |
|---|---|---|
| `doc-converter-storage-data` | `/data/storage` | Результаты конвертации (общий для `api` и `worker`) |
| `doc-converter-audit-log` | `/var/log/converter` | `audit.log` |
| `doc-converter-valkey-data` | `/data` (в контейнере valkey) | AOF-файлы Valkey |

## Healthcheck

В образе и в compose задан один и тот же healthcheck:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node /app/dist/nest/health/health-check.js
```

Скрипт (`src/nest/health/health-check.ts`) проверяет доступность Valkey и наличие пакета
конвертера с WASM-ассетами. Полная инициализация движка в healthcheck не выполняется:
она требует загрузки ~48 МБ и слишком дорога для проверки, запускаемой каждые 30 секунд.
HTTP-эндпоинт `GET /health` (контроллер `src/nest/health/health.controller.ts`) возвращает:

```json
{ "status": "ok", "wasm": true, "version": "1.0.0" }
```

## Масштабирование

- **Синхронный путь** масштабируется репликами `api`. Каждая реплика держит собственный
  пул из `FORK_POOL_SIZE` fork-процессов и семафор на `MAX_CONCURRENT` задач.
- **Асинхронный путь** масштабируется репликами `worker`: BullMQ раздаёт задачи между
  воркерами, конкуренция внутри процесса — `MAX_CONCURRENT`.
- **Valkey** — общая точка состояния для идемпотентности и статусов; при нескольких
  репликах `api` именно она обеспечивает уникальность `taskId`.

Память — основной ограничитель. Ориентир из `docker-compose.yml`: каждый fork-процесс
получает `--max-old-space-size=1536`, четыре форка теоретически дают около 6 ГБ heap,
поэтому выход за `mem_limit` и срабатывание OOM-killer — осознанный предохранитель.
При увеличении `FORK_POOL_SIZE`/`MAX_CONCURRENT` пропорционально поднимайте `mem_limit`.

## Требования к reverse proxy

`SYNC_TIMEOUT_MS` (по умолчанию 30 с) **обязан быть меньше** таймаута балансировщика:

```nginx
proxy_read_timeout 60s;   # > SYNC_TIMEOUT_MS
```

Иначе вместо аккуратного `504 sync_timeout` клиент получит оборванное соединение.
Тот же принцип для `REQUEST_BODY_TIMEOUT_MS` (15 с) — приём тела запроса должен
завершаться раньше, чем балансировщик потеряет терпение.

## Логи

- Основной поток логов — stdout/stderr контейнера (события старта, ошибки Redis, конвертации).
- Аудит-лог пишется отдельным pino-инстансом в `AUDIT_LOG_PATH`
  (`/var/log/converter/audit.log`) и хранится в томе `doc-converter-audit-log`.
  Формат и события описаны в [security.md](security.md#аудит-лог).

## Запуск без Docker

```bash
pnpm install
npm run build:contract  # контракт — рантайм-зависимость сервера
npm run build:server    # dist/nest/main.js и dist/worker/index.js
export REDIS_HOST=localhost REDIS_PORT=6379
npm run dev             # api + worker через concurrently, NODE_ENV=development
```

Сервер запускается только из собранного `dist`: декораторам NestJS нужен
`emitDecoratorMetadata`, с которым нативное стирание типов Node 24 несовместимо.
Скрипты `dev`/`start` сборку не выполняют — её нужно сделать до запуска (тесты собирают
`dist` сами через `pretest`).

Для локального запуска нужен доступный Valkey/Redis. `NODE_ENV=development` включает CORS
со значением `*`.

## Известные особенности сборки

Это стоит знать до первого `docker compose up --build`:

| Наблюдение | Последствие |
|---|---|
| Нативных модулей в зависимостях нет | Стадия builder обходится без `python3`/`make`/`g++` — соответствующий слой из `Dockerfile` удалён |
| Зависимости ставятся без `--prod` | `jest`, `supertest`, `yazl`, `concurrently` остаются в production-образе (образ около 885 МБ) |
| В `Dockerfile` есть самоссылка `ln -sf …/dejavu …/dejavu` с `\|\| true` | Никакого эффекта не даёт, ошибка глушится |

Образ веб-интерфейса (`web/Dockerfile`) от этого не зависит и собирается отдельно:
`docker build -f web/Dockerfile -t doc-converter-web .` — стадия сборки Vite на Node,
финальная стадия на `nginx:alpine`, около 76 МБ.

### Требование к версии Node: не ниже 24

Базовый образ — `node:24-bookworm-slim`, в `package.json` стоит `engines.node: ">=24.0.0"`.

Исторически это требование задавала зависимость `isolated-vm` (совместимые версии 6.x/7.x
требуют Node 22+/24+, на Node 20 модуль падал с SIGSEGV при создании изолята).
Сейчас модуль удалён, и жёсткой причины оставаться на 24 нет — Node 24 сохраняется
как версия, на которой сервис разрабатывается и тестируется. Понижать её следует
с прогоном всего набора тестов.

Сборка образа больше не требует компилятора: нативных модулей в зависимостях нет.

## Диагностика

```bash
docker compose ps                       # статусы и health
docker compose logs -f api worker       # поток логов
curl -s localhost:3000/health | jq      # готовность API
docker compose exec valkey valkey-cli ping
```

Частые причины отказов:

| Симптом | Вероятная причина |
|---|---|
| `503`/`500` при синхронной конвертации | Все слоты семафора заняты: либо задачи идут дольше `JOB_TIMEOUT_MS`, либо упал fork-процесс |
| `504 sync_timeout` | Запрос не уложился в `SYNC_TIMEOUT_MS` — проверьте таймаут балансировщика и размер документа |
| Контейнер `unhealthy`, но API отвечает | Healthcheck проверяет не HTTP, а доступность Valkey и наличие пакета конвертера — смотрите его вывод (`docker inspect --format '{{json .State.Health}}' doc-converter-api`) |
| `Не удалось подключиться к Valkey/Redis` | `valkey` не поднялся или неверные `REDIS_HOST`/`REDIS_PORT` |
| Конвертация по `url` не работает | Сеть compose помечена `internal: true` |
