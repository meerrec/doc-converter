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
  в `src/config/index.ts` — при изменении лимита обновляй и обоснование.

История: сервис начинался как конвертер на WASM-сборке LibreOffice
(`@matbee/libreoffice-converter` в fork-процессах) с Р7-совместимым API.
От WASM отказались: библиотека 2.x держала ~1.16 ГБ RSS на процесс,
не освобождала память между задачами, и контейнер упирался в `mem_limit`
(в логах — `Conversion failed: No process`). Вместе с ней ушли fork-пул,
Р7-эндпоинты и поддержка остальных форматов. **Не возвращай их.**

## Команды

```bash
pnpm install
pnpm --filter @doc-converter/contract build   # контракт — рантайм-зависимость сервера
npm run build:server                          # tsc → dist/ (NestJS требует декораторов)
npm run typecheck:server

npm run start:api                             # node dist/nest/main.js
npm run start:worker                          # WORKER_QUEUE=light node dist/worker/uno/index.js
npm run start:autoscaler                      # node dist/autoscaler/index.js
npm run dev                                   # api + воркер через concurrently

npm test                                      # весь набор
NODE_ENV=test npx vitest run tests/complexity.test.js   # один файл
```

Сервер запускается только из `dist/`: декораторам NestJS нужен
`emitDecoratorMetadata`, с которым нативное стирание типов Node несовместимо.
Тесты же читают **исходники** на TypeScript — сборка перед прогоном не нужна.

Полный стек:

```bash
docker compose up --build      # api, web, три воркера, autoscaler, minio, valkey
docker compose --profile build-only build uno-worker-light   # только образ воркера
```

## Архитектура

### Путь одной задачи

```
POST /convert/xlsx-to-pdf  (multipart)
  → src/nest/xlsx/xlsx.controller.ts    FileInterceptor, разбор параметров
  → src/nest/xlsx/xlsx.service.ts       сигнатура, zip-гард, оценка сложности
  → src/storage/s3.ts                   вход в MinIO: incoming/{jobId}.xlsx
  → src/queue/jobStatus.ts              запись состояния: job:{jobId}
  → src/queue/queues.ts                 задача в очередь xlsx2pdf.{tier}
                                        ↓
  → src/worker/uno/index.ts             BullMQ Worker, concurrency: 1
  → src/worker/uno/processor.ts         скачать вход → конвертировать → загрузить PDF
  → src/worker/uno/uno-converter.ts     spawn python3 с таймаутом
  → docker/uno/uno_convert.py           UNO → soffice → PDF
```

### Три очереди по сложности

`light` / `medium` / `heavy` — по старшему из двух признаков: размер файла
и число листов (`src/nest/xlsx/complexity.ts`, листы читаются из
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
  `src/queue/connection.ts`.

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

Все таймауты и лимиты — в **`src/config/index.ts`**, с обоснованием рядом
с каждой константой. Не хардкодь числа в модулях.

Два исключения:

- `src/security/limits.ts` — лимиты zip-гарда и сигнатур (дополняют config,
  а не дублируют).
- NestJS-слой читает своё подмножество через `src/nest/config/env.ts`
  (`NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `RATE_*`, `TRUST_PROXY`) —
  не при импорте модуля, а при создании приложения (тесты правят окружение
  в `beforeAll`).

`.env.example` — источник истины по переменным окружения.

## Соглашения

- **Формат ошибок API** единый: `{ error: <код>, message, jobId?, requestId? }`,
  код — snake_case из `packages/contract/src/errors.ts`
  (`file_required`, `magic_mismatch`, `storage_unavailable`, …).
  Домен бросает `AppError` со статусом и кодом; в HTTP-ответ их маппит
  `src/nest/common/exception.filter.ts`. Всё, что не `AppError`, отдаётся
  как 500 без подробностей — иначе в ответ попадут `err.message` и системные
  коды вроде `ENOENT`.
- **Контракт API живёт в `packages/contract`**: zod-схемы и выведенные типы.
  Сервер берёт оттуда схемы запроса и коды ошибок, веб-интерфейс — типы.
  Своих копий списков у сторон нет.
- **Числовые коды FilterData — только в контракте** (`PDF_VERSION_CODES`):
  в API версия PDF называется так, как её видит пользователь («1.7»,
  «pdfa-2b»), а экспортёр LibreOffice принимает числа.
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
