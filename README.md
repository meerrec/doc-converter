# doc-converter: XLSX и DOCX → PDF через LibreOffice + UNO

Сервис конвертации документов в PDF: книги Excel и текстовые документы Word.
Конвертация выполняется **нативным LibreOffice** — Calc для книг, Writer для
документов, — которым управляет Python-скрипт через **UNO API** — без
CLI-обёрток вида `soffice --convert-to` и без `unoconv`.

- NestJS + TypeScript для API и воркеров
- BullMQ + Valkey — очередь задач, три уровня сложности
- MinIO (S3) — входные файлы и результаты, отдаются presigned-ссылкой
- Docker Compose для локального запуска, KEDA — для Kubernetes
- Все комментарии, JSDoc и сообщения в коде — на русском языке

## Как это работает

```text
POST /convert/to-pdf (multipart: файл + параметры)
   │
   ├─ 1. ВАЛИДАЦИЯ
   │    ├─ расширение → сигнатура (PK\x03\x04) → разбор zip
   │    ├─ защита от zip-bomb: sum(uncompressed) / compressed < 100
   │    └─ тип по содержимому: xl/workbook.xml | word/document.xml
   │
   ├─ 2. ОЦЕНКА СЛОЖНОСТИ (tier selection)
   │    │
   │    ├─ media_mb      = Σ размеров xl/media, word/media, ppt/media
   │    ├─ page_count    = docProps/app.xml → <Pages>
   │    ├─ sheet_count   = xl/workbook.xml → count(<sheet>)
   │    ├─ xml_mb        = Σ uncompressed XML
   │    ├─ flags          = external_links? ole_objects? webservice?
   │    │
   │    └─ score = 1.0·(media_mb/10)
   │              + 0.5·(page_count/50)
   │              + 0.3·(sheet_count/10)
   │              + 0.2·(xml_mb/20)
   │              + 1.0·external_links
   │              + 0.5·ole_objects
   │
   │         score < 1.5   →  light
   │    1.5 ≤ score < 4     →  medium
   │         score ≥ 4     →  heavy
   │
   ├─ 3. ПОСТАНОВКА ЗАДАЧИ
   │    ├─ MinIO: incoming/{jobId}.{xlsx|docx}
   │    ├─ BullMQ job: { jobId, tier, score, filename }
   │    │
   │    └─ retry policy per tier:
   │         light:  attempts=3, backoff=exp(3s,  jitter=0.3)
   │         medium: attempts=2, backoff=exp(10s, jitter=0.2)
   │         heavy:  attempts=1, backoff=exp(30s, jitter=0.1)
   │
   └─ 202 { jobId, tier, queue }
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  uno-worker-<tier>   (BullMQ, concurrency: 1)                │
│                                                              │
│  ├─ cgroup v2 лимиты:                                        │
│  │    light:  memory.max=512M,  cpu.max=100% (1 ядро)        │
│  │    medium: memory.max=1.5G,  cpu.max=100%                 │
│  │    heavy:  memory.max=3G,   cpu.max=100%                 │
│  │                                                          │
│  ├─ таймаут на soffice (kill по таймеру):                    │
│  │    light: 120s   medium: 300s   heavy: 600s               │
│  │                                                          │
│  ├─ 4. ИЗОЛЯЦИЯ ПРОФИЛЯ                                      │
│  │    -env:UserInstallation=file:///tmp/lo-{jobId}           │
│  │    ├─ копия registrymodifications.xcu (таблица замен)     │
│  │    └─ --norestore --nolockcheck --nodefault --nologo      │
│  │       MacroSecurityLevel=3, без сети (--network=none)     │
│  │                                                          │
│  ├─ 5. КОНВЕРТАЦИЯ                                           │
│  │    python3 uno_convert.py ──UNO──> soffice --headless     │
│  │      │                                                    │
│  │      ├─ calc_pdf_Export   (для xlsx)                       │
│  │      └─ writer_pdf_Export (для docx)                       │
│  │                                                          │
│  │    ШРИФТЫ в образе:                                       │
│  │      fonts-liberation, fonts-dejavu, fonts-noto,          │
│  │      fonts-noto-cjk, fonts-noto-color-emoji,              │
│  │      fonts-crosextra-carlito  ← Calibri                   │
│  │      fonts-crosextra-caladea  ← Cambria                   │
│  │      + fc-cache -f -v после установки                     │
│  │      + таблица замен в registrymodifications.xcu          │
│  │                                                          │
│  └─ 6. РЕЗУЛЬТАТ / ОШИБКА                                    │
│       ├─ успех → MinIO: results/{jobId}.pdf                  │
│       │          job.status = completed                       │
│       │          job.result  = { url, size, pages }           │
│       │                                                       │
│       ├─ recoverable error (OOM-137, timeout, SIGSEGV,        │
│       │   MinIO-down)                                          │
│       │     ├─ attemptsMade < attempts ?                      │
│       │     │     → throw Error → BullMQ backoff retry        │
│       │     └─ attemptsMade == attempts                       │
│       │           → move to DLQ (removeOnFail: false)         │
│       │             + alert: dlq_depth > 0                    │
│       │                                                       │
│       └─ unrecoverable error (битый zip, unsupported format,  │
│           macro-blocked)                                       │
│             → throw UnrecoverableError                        │
│             → DLQ сразу, без ретраев                          │
│                                                              │
│  Логирование в job:                                          │
│    { jobId, tier, error.code, error.message,                 │
│      stderr[last 100 lines], attemptsMade, failedReason,     │
│      incoming_url }                                          │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
GET /convert/status/:id
   ├─ queued
   ├─ processing      (опц. progress 0..100)
   ├─ completed       → + presigned URL (короткий TTL)
   ├─ failed          → + error.code:
   │                     UNSUPPORTED_FORMAT
   │                     TOO_COMPLEX
   │                     CONVERSION_FAILED
   │                     OOM
   └─ expired / cancelled
```

Маршрут один на оба формата: расширение из имени файла — подсказка,
а не доказательство, и определять по нему способ конвертации значило бы
доверять клиенту там, где содержимое можно проверить. Сигнатура у XLSX
и DOCX одинаковая (оба — zip), поэтому вид документа определяется по
главной части пакета.

Одна реплика воркера — **один процесс soffice и одна конвертация
одновременно**. Это требование корректности, а не оптимизация: UNO
не потокобезопасен, и вторая параллельная конвертация в том же процессе
портит документ и роняет бридж. Параллелизм достигается только репликами.

## Быстрый старт

```bash
docker compose up --build
```

Поднимаются: `api`, `web` (интерфейс и реверс-прокси), `uno-worker-light`,
`uno-worker-medium`, `uno-worker-heavy`, `autoscaler`, `minio`, `valkey`.

Порты: `8080` — интерфейс, `3000` — API (только loopback), `9000` — MinIO.

Базовые образы берутся из двух реестров, Docker Hub не используется: UBI 9 —
с `registry.access.redhat.com` (анонимный pull), MinIO и Valkey — с `quay.io`.
LibreOffice в репозиториях UBI не публикуется, поэтому воркер ставит его
из AppStream AlmaLinux 9. Подробности — в `docs/deployment.md`.

### Проверка конвертации

```bash
# 1. Отправить файл и получить идентификатор задачи
curl -s -X POST http://localhost:3000/convert/to-pdf \
  -F "file=@report.xlsx" \
  -F "watermark=CONFIDENTIAL" \
  -F "watermarkMode=tiled" \
  -F "fitToOnePage=true" \
  -F "pdfVersion=default" \
  -F "quality=90" \
  -F "maxImageResolution=300" \
  | jq

# Ответ:
# {
#   "jobId": "9f1c2f5e-...",
#   "status": "queued",
#   "tier": "light",
#   "queue": "xlsx2pdf.light",
#   "inputFormat": "xlsx",
#   "sheets": 3,
#   "sizeBytes": 48211,
#   "createdAt": "2026-09-20T10:15:00.000Z"
# }

# Документ Word отправляется туда же: формат определяется по содержимому
curl -s -X POST http://localhost:3000/convert/to-pdf \
  -F "file=@document.docx" | jq
# { ..., "inputFormat": "docx", "sheets": null, ... }

# 2. Опросить состояние
curl -s http://localhost:3000/convert/status/<jobId> | jq

# Ответ при готовности:
# {
#   "jobId": "9f1c2f5e-...",
#   "status": "completed",
#   "tier": "light",
#   "createdAt": "...",
#   "startedAt": "...",
#   "finishedAt": "...",
#   "result": {
#     "url": "http://localhost:9000/conversions/results/9f1c2f5e-....pdf?X-Amz-...",
#     "expiresAt": "2026-09-20T11:15:00.000Z",
#     "sizeBytes": 152340
#   }
# }

# 3. Скачать PDF (ссылка живёт ограниченное время)
curl -s -o result.pdf "<url из ответа>"

# 4. Проверить результат
pdfinfo result.pdf | grep Pages    # таблица умещена на одну страницу
# Водяной знак записан глифами CID-шрифта, текстовым поиском он не находится —
# смотрите страницу визуально (или отрендерите в изображение)
```uml

### Параметры конвертации

Все параметры необязательны и передаются полями формы (строками).

| Параметр | Значения | По умолчанию | Что делает |
| --- | --- | --- | --- |
| `watermark` | текст до 200 символов | — | Водяной знак на каждой странице |
| `watermarkMode` | `single`, `tiled` | `single` | Один по центру или мозаикой |
| `fitToOnePage` | `true`, `false` | `true` | Уместить лист на одну страницу (`ScaleToPagesX/Y = 1`); только для книг XLSX |
| `pdfVersion` | `default`, `pdfa-1a`, `pdfa-2b`, `pdfa-3b` | `default` | Версия PDF (`SelectPdfVersion`) |
| `quality` | 1–100 | 90 | Качество JPEG-сжатия изображений |
| `reduceImageResolution` | `true`, `false` | `true` | Понижать разрешение изображений |
| `maxImageResolution` | 50–1200 | 300 | Предельное разрешение, DPI |
| `exportBookmarks` | `true`, `false` | `true` | Закладки: у книги — по листам, у документа — по заголовкам |
| `taggedPdf` | `true`, `false` | `false` | Теги структуры (нужны для PDF/A) |
| `userPassword` | строка | — | Пароль на открытие PDF |
| `ownerPassword` | строка | — | Пароль владельца |
| `restrictPermissions` | `true`, `false` | `false` | Включить ограничения прав |
| `allowPrinting` | `true`, `false` | `true` | Разрешить печать |
| `allowChanges` | `true`, `false` | `false` | Разрешить изменение |

Пример с шифрованием и PDF/A:

```bash
curl -s -X POST http://localhost:3000/convert/to-pdf \
  -F "file=@report.xlsx" \
  -F "pdfVersion=pdfa-2b" \
  -F "taggedPdf=true" \
  -F "userPassword=secret" \
  -F "ownerPassword=owner-secret" \
  -F "restrictPermissions=true" \
  -F "allowPrinting=true" \
  -F "allowChanges=false" | jq
```

### Прочие маршруты

```bash
curl -s http://localhost:3000/health | jq
# { "status": "ok", "storage": true, "version": "1.0.0" }
```

Некорректный запрос отвечает единообразно:

```bash
curl -s -X POST http://localhost:3000/convert/to-pdf | jq
# { "error": "file_required", "message": "В запросе нет файла в поле «file»" }
```

## Уровни сложности и очереди

Задача попадает в очередь по **старшему** из двух признаков — размеру файла
и объёму документа. Объём читается из служебных частей zip-контейнера, без
запуска LibreOffice: у книги это число листов (`xl/workbook.xml`), у документа
Word — число страниц (`docProps/app.xml`).

| Очередь | Условие | Почему так |
| --- | --- | --- |
| `light` | ≤ 2 МиБ **и** ≤ 3 листов **и** ≤ 5 страниц | Открытие документа занимает больше времени, чем сам экспорт |
| `medium` | ≤ 20 МиБ **и** ≤ 20 листов **и** ≤ 30 страниц | Десятки секунд на конвертацию |
| `heavy` | Всё остальное | Минуты; каждая задача занимает реплику целиком |

Число страниц записывает в документ приложение-автор, поэтому значение
оценочное; страхует от промаха вторая ось — размер файла.

Разделение нужно потому, что одна конвертация занимает воркер целиком:
в общей очереди крупный документ задерживал бы мелкие файлы, которые прошли бы
за секунды.

## Масштабирование

### Правила

Одна реплика = один soffice = одна конвертация, поэтому «задач на реплику» —
это не параллелизм, а допустимая длина очереди ожидания.

| Очередь | min | max | `listLength` | `cooldownPeriod` |
| --- | --- | --- | --- | --- |
| light | 0 (KEDA) / 1 (compose) | 10 | 5 | 120 с |
| medium | 1 | 6 | 2 | 300 с |
| heavy | 1 | 3 | 1 | 600 с |

Обоснование:

- **`listLength` растёт от тяжёлых к лёгким.** Лёгкая конвертация длится
  секунды: держать под каждую задачу отдельный LibreOffice дороже, чем
  подождать, поэтому пять задач на реплику. Тяжёлая занимает минуты, и две
  таких задачи в очереди означают, что вторая прождёт минуты, — значит,
  `listLength: 1`.
- **Активные задачи считаются вместе с ожидающими.** Реплика, занятая
  конвертацией, для очереди недоступна; если считать только `waiting`,
  масштабирование будет вечно догонять нагрузку.
- **`minReplicaCount`.** Для `light` в KEDA ноль: холодный старт (~3 с)
  незаметен на фоне ожидания, а в простое реплики не нужны. Для `medium`
  и `heavy` единица: поднимать LibreOffice «с нуля» дороже, чем держать
  прогретую реплику, а конвертация и так идёт десятки секунд.
  В compose `min` для всех уровней — единица, потому что стартовые реплики
  объявлены сервисами и существуют независимо от autoscaler'а.
- **`maxReplicaCount`** ограничен памятью узла: реплика с LibreOffice
  занимает 400–600 МБ в покое и заметно больше на пике конвертации
  большой книги. При 2 ГБ на реплику (см. `mem_limit` в compose) три
  тяжёлых реплики — это 6 ГБ.
- **`cooldownPeriod`** тем больше, чем дороже задача: погасить и снова
  поднять тяжёлую реплику дороже, чем подождать. 120 с для лёгких,
  300 с для средних, 600 с для тяжёлых.
- **`pollingInterval` 15 с** — компромисс между задержкой появления
  свободного воркера и нагрузкой на Redis и Docker API.
- **`activationListLength: 1`** — не поднимать реплику с нуля из-за
  единственной задачи в моменте (защита от дребезга).

### В Kubernetes — KEDA

Манифесты: `deploy/k8s/scaledobject-{light,medium,heavy}.yaml`. Масштабирование
идёт по длине списка BullMQ (`bull:xlsx2pdf.<tier>:wait`), доступ к Docker
не нужен.

### В docker compose — сервис autoscaler

В compose нет ничего, что умеет масштабировать сервис по внешней метрике,
поэтому реплики создаются сервисом `autoscaler` через API движка — Docker
или Podman: API у них совместимый, различаются путь к сокету и политика
SELinux.

Autoscaler различает реплики по меткам:

- стартовые реплики compose (метки без `doc-converter.managed`) он только
  считает — удалять их нельзя, иначе `restart: unless-stopped` вернёт
  контейнер и autoscaler начнёт бесконечно бороться с compose;
- созданные им самим (`doc-converter.managed=autoscaler`) — поднимает
  и гасит по правилам выше.

За один цикл число реплик меняется не более чем на `AUTOSCALER_MAX_STEP`:
реплика поднимается несколько секунд и занимает сотни мегабайт, поэтому
скачок «1 → 10» выедает память быстрее, чем приходят задачи.

Реплики получают тот же бюджет конвертации, что и стартовые
(`CONVERSION_TIMEOUT_MS` зависит от уровня: 120 с для light и medium,
300 с для heavy): иначе поведение зависело бы от того, кто поднял контейнер.

> **Внимание.** Autoscaler монтирует сокет движка, что даёт контейнеру
> root-эквивалент на хосте. Это осознанная плата за автомасштабирование
> в compose; в Kubernetes доступ к сокету не нужен.

### Под Podman

Стек работает и под Podman, но три вещи отличаются от Docker:

- **Сокет лежит в другом месте.** В `.env` задаётся `DOCKER_SOCKET_SOURCE` —
  путь, который монтируется в контейнер (`podman info --format
  '{{.Host.RemoteSocket.Path}}'` его печатает, но без схемы `unix://`).
  Внутри контейнера сокет оказывается по обычному `/var/run/docker.sock`,
  и `DOCKER_SOCKET_PATH` менять не нужно.
- **SELinux блокирует `connect()`.** Сокет помечен `user_tmp_t`, а контейнеру
  достаётся `container_t`: запись в такой `sock_file` запрещена. Поэтому у
  сервиса `autoscaler` стоит `label=disable` — ровно это предписывает
  `podman-system-service(1)` для доступа к сокету API из контейнера.
  Без SELinux опция не делает ничего.
- **Памяти `podman machine` по умолчанию мало.** Реплике воркера нужно до
  2 ГБ, а машина создаётся с ~2 ГиБ: не хватает в том числе на сборку образов
  (`exit code 137`). Лечится `podman machine set --memory 8192`.

Полный рецепт запуска — в `docs/deployment.md`, раздел «Podman».

## Разработка

```bash
pnpm install
npm run build                                 # пакеты, затем приложения — по графу
npm run dev                                   # api + воркер через concurrently
```

Локальный запуск требует доступных Valkey и MinIO (проще всего —
`docker compose up valkey minio minio-init`).

```bash
npm test              # весь набор (Redis и MinIO не нужны)
npm run test:watch    # то же в режиме наблюдения
npm run typecheck     # сборка + проверка типов во всех пакетах
```

Тесты читают исходники на TypeScript, сборка перед прогоном не нужна.
Проверяются оценка сложности, правила автомасштабирования, маршруты API
и каркас приложения — всё, что не требует живой инфраструктуры.

## Непрерывная интеграция

`.github/workflows/ci.yml` на каждый пуш в `main`, каждый pull request
и по кнопке повторяет ровно то, что разработчик делает перед коммитом:
`pnpm ci` (установка строго по замку), `pnpm -r build`, `pnpm -r typecheck`,
`pnpm test`, плюс проверку синтаксиса скриптов в `docker/` — их не покрывают
ни сборка, ни тесты, потому что UNO-скрипт исполняется только внутри образа
с LibreOffice. Service-контейнеры не поднимаются: набор тестов обходится
без Redis и MinIO. Версии инструментов workflow не задаёт — pnpm берётся
из `packageManager`, Node 24 совпадает с `engines.node` и Dockerfile'ами.

`.github/workflows/images.yml` собирает три образа (`api`, `web`,
`uno-worker`) и разбирает `docker-compose.yml`, ничего не публикуя:
проверяется сама сборка, а не доставка. После сборки образ загружается
в демон и проверяется его **состав** — точки входа на месте, `dist`
автоскейлера в образе `api` есть, инструментов сборки и исходников нет.
Это не педантизм: ошибка в стадиях даёт образ, который собирается, но падает
в работе, — именно так автоскейлер однажды остался без своего `dist`, и сборка
при этом была зелёной. Слои кешируются в кеше GitHub Actions — слой
с LibreOffice иначе качался бы из microdnf каждый раз. На изменения только
в документации, тестах и манифестах K8s этот workflow не запускается.

Проверки локально — те же команды из раздела «Разработка»; отдельной
конфигурации для CI нет намеренно, чтобы «зелено в CI» и «зелено локально»
означало одно и то же.

## Структура

```text
pnpm-workspace.yaml         состав workspace и каталог версий общих зависимостей
tsconfig.base.json          общая для всех пакетов цель компиляции и строгость
tsconfig.json               среда исполнения серверного кода (Node)
.npmrc                      настройки pnpm: требования к Node из engines обязательны
.github/workflows/          CI: проверки (ci.yml) и сборка образов (images.yml)

apps/                       запускаемые приложения — по каталогу на процесс
  api/                      NestJS: приём файлов, статусы, /health
    src/conversion/         контроллер, сервис, оценка сложности
    src/common/             фильтр ошибок, ограничитель частоты, логгер Nest
    src/health/             /health и healthcheck-скрипт
    src/security/           лимиты, сигнатуры, вид документа OOXML, zip-гард
    Dockerfile              образ API
  worker/                   BullMQ-воркер: soffice через UNO
    src/                    процессор, вызов Python, healthcheck
    Dockerfile              образ воркера (LibreOffice Calc и Writer внутри)
  autoscaler/               масштабирование реплик в compose
  web/                      интерфейс: Vite + React, раздаётся nginx

packages/                   библиотеки, общие для приложений
  contract/                 zod-схемы и выведенные типы
  config/                   все таймауты и лимиты с обоснованиями
  observability/            логгер pino и аудит-лог
  queue/                    соединения Redis, очереди, состояние задач
  storage/                  MinIO: загрузка, скачивание, presigned-ссылки

docker/uno/
  worker-entrypoint.sh      запуск soffice и ожидание готовности UNO
  uno_convert.py            конвертация: PageStyle, FilterData, экспорт
docker/almalinux/           репозиторий и ключ AlmaLinux 9 AppStream —
                            единственный доступный источник LibreOffice
                            для образа воркера (в репозиториях UBI его нет)
deploy/k8s/                 KEDA ScaledObject для трёх очередей
docs/                       справочники: API, конфигурация, развёртывание
tests/                      Vitest: сложность, OOXML, zip-гард, скейлинг, маршруты
```

## Известные ограничения и подводные камни

1. **`fitToOnePage` может сделать большую таблицу нечитаемой.** Масштаб
   подбирает LibreOffice; для «простыни» на сотни строк шрифт станет
   микроскопическим. Это ожидаемое поведение режима «на одну страницу»,
   и параметр можно отключить.
2. **Водяной знак — текст или URL.** FilterData `Watermark`/`TiledWatermark`
   принимает и то и другое; сервис передаёт текст. Если текст похож на URL,
   LibreOffice попытается загрузить ресурс — поэтому длинные значения
   ограничены 200 символами, но экзотические строки всё равно стоит
   проверять на своей версии LibreOffice. В готовом PDF текст знака записан
   глифами CID-шрифта, поэтому поиск по строкам (`pdftotext | grep`) его
   не найдёт — проверяйте визуально.
3. **Версии PDF 1.4–1.7 выбрать нельзя.** Проверено перебором значений
   `SelectPdfVersion`: поддерживаются только «по умолчанию» (PDF 1.6)
   и три варианта PDF/A — 1a, 2b и 3b. Коды 4 и выше дают тот же файл,
   что и 0, поэтому в API этих вариантов нет. Набор проверен на LibreOffice
   7.4, а после перехода воркера на EL9 — повторно на 7.1.8: результат тот же
   (1 → PDF/A-1a, 2 → PDF/A-2b, 3 → PDF/A-3b, 4 и 5 → как 0).
4. **UNO не потокобезопасен.** `concurrency: 1` в воркере — не настройка,
   а требование. Увеличение приведёт к порче документов и падениям бриджа.
5. **Падение soffice роняет воркер.** Ретраев внутри процесса нет: контейнер
   перезапускается (`restart: unless-stopped`), а задача возвращается
   в очередь stalled-механизмом BullMQ — но **не мгновенно**, а в пределах
   `BULLMQ_STALLED_INTERVAL` (2 минуты у лёгкой и средней очереди, 5 минут
   у тяжёлой). Проверено: после `docker kill` воркера задача вернулась
   в очередь и была выполнена другой репликой. `maxStalledCount: 1`
   ограничивает число таких повторов, чтобы «ядовитый» файл не крутился вечно.
6. **Образ воркера тяжёлый** (LibreOffice Calc и Writer, libreoffice-pyuno,
   шрифты, а с переходом на UBI — ещё и JRE, которую LibreOffice требует
   жёстко: 2,1 ГБ против 1,3 ГБ у Debian-сборки). Это влияет на скорость
   холодного старта реплики: в KEDA с `minReplicaCount: 0` первая задача
   после простоя ждёт и подъёма контейнера, и старта soffice.
7. **Presigned-ссылка подписывается вместе с хостом.** В compose ссылки
   формируются для `S3_PUBLIC_ENDPOINT` (по умолчанию `localhost:9000`):
   изнутри сети MinIO доступен как `minio:9000`, но браузер такого имени
   не знает. В K8s нужен ingress на MinIO или внешний S3.
8. **Autoscaler требует доступа к сокету движка.** Сокет даёт root-эквивалент
   на хосте — в K8s используйте KEDA и не монтируйте сокет.
9. **Ключи BullMQ в Redis.** KEDA и autoscaler читают список
   `bull:<queue>:wait`; при смене `QUEUE_PREFIX` нужно поправить и манифесты
   KEDA.
10. **Исходный документ с паролем.** Параметры `userPassword`/`ownerPassword`
    относятся к PDF на выходе. Если сама книга защищена паролем, его нужно
    передать отдельно — сейчас API такого поля не имеет, и такая книга
    упадёт с `conversion_failed`.
11. **Файлы `.xls` и `.doc`** (старые OLE-форматы) не принимаются — сервис
    работает только с XLSX и DOCX. Причина: они не являются zip-контейнерами,
    поэтому не проходят zip-гард, а их структура проверялась лишь восемью
    байтами сигнатуры. Через `.xls` приходили и макросы Excel 4.0, которых
    в XLSX не бывает. Старые файлы нужно пересохранить в OOXML.
12. **Документы с макросами не принимаются.** `.xlsm` и `.docm` по структуре
    контейнера не отличаются от обычных книг и документов, поэтому
    отсекаются не по расширению, а по части пакета `vbaProject.bin` —
    её находит zip-гард.
