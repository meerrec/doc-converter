# Справочник API

Базовый URL — `http://<host>:3000`. Тело запросов и ответов — JSON (`Content-Type: application/json`).

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/ConvertService.ashx` | Конвертация документа (совместимо с Р7-Офис) |
| `GET` | `/status/:taskId` | Статус одной задачи |
| `GET` | `/status?taskIds=<id>&taskIds=<id>` | Статусы нескольких задач |
| `GET` | `/results/:fileName` | Скачивание готового файла |
| `GET` | `/health` | Готовность сервиса |

## POST /ConvertService.ashx

### Поля запроса

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `filetype` | string | **да** | Формат входного файла. Allowlist: `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`, `html`, `htm`, `csv`, `pdf`, `epub` |
| `outputtype` | string | **да** | Формат результата. Allowlist: `pdf`, `pdfa`, `docx`, `xlsx`, `csv`, `txt`, `html`, `png`, `jpg`, `jpeg`, `svg`, `odt`, `ods`, `odp`, `rtf`, `epub` |
| `url` | string | XOR | Ссылка на файл (только http/https, публичный хост). Ровно одно из `url`/`data` |
| `data` | string | XOR | Содержимое файла в base64. Ровно одно из `url`/`data` |
| `async` | boolean | нет | `false` (по умолчанию) — конвертация в рамках запроса; `true` — постановка в очередь |
| `key` | string | нет | Идентификатор задачи для идемпотентности. `^[A-Za-z0-9._-]{1,128}$`. Если не указан — генерируется UUID |
| `title` | string | нет | Заголовок документа, до 255 символов |
| `codePage` | number | нет | Кодировка для `txt`/`csv`/`html`: `65001` (UTF-8), `1251`, `1252`, `866`, `20866` (KOI8-R), `28595` (ISO-8859-5) |
| `delimiter` | number | нет | Разделитель CSV: `1` — табуляция, `2` — `;`, `3` — пробел, `4` — `,` |
| `region` | string | нет | Локаль, `^[a-zA-Z]{2}(-[a-zA-Z]{2})?$` (например `ru-RU`) |
| `documentLayout` | object | нет | Параметры отрисовки документа: `drawPlaceHolders`, `drawFormHighlight` |
| `spreadsheetLayout` | object | нет | Параметры листа: `pageSize` (`width`, `height`), `margins` (`left`, `right`, `top`, `bottom`), `fitToWidth`, `fitToHeight`, `orientation` |
| `documentRenderer` | object | нет | `textAssociation` — привязка текста |
| `password` | string \| null | нет | Пароль защищённого документа |
| `thumbnail` | object | нет | Принимается схемой, но в маппинг опций не входит |

Неизвестное поле в теле — ошибка `unknown_field` (400). Поля с неверным типом — `field_type_mismatch`.

### Синхронный режим

```bash
curl -X POST http://localhost:3000/ConvertService.ashx \
  -H 'Content-Type: application/json' \
  -d '{
        "async": false,
        "filetype": "docx",
        "outputtype": "pdf",
        "url": "http://files.example.com/report.docx",
        "key": "task-123"
      }'
```

Успех — `200`:

```json
{
  "status": "success",
  "fileUrl": "/results/task-123.pdf",
  "fileType": "pdf",
  "taskId": "task-123"
}
```

Заголовок `X-Task-Id` дублирует идентификатор задачи.

Бюджет времени: `SYNC_TIMEOUT_MS` (30 с). Если конвертация не уложилась — `504` с кодом
`sync_timeout`. Ожидание слота в семафоре ограничено `SYNC_QUEUE_WAIT_MS` (5 с).

Результат синхронного запроса сохраняется в хранилище тем же `writeResult`
(`src/storage/fileStorage.ts`), что и в асинхронном пути, — скачать его можно по `fileUrl`
из ответа. Прежняя Express-версия синхронного пути файл не записывала.

### Асинхронный режим

```bash
curl -X POST http://localhost:3000/ConvertService.ashx \
  -H 'Content-Type: application/json' \
  -d '{"async": true, "filetype": "xlsx", "outputtype": "pdf", "data": "UEsDBBQ...", "key": "task-456"}'
```

Ответ — `202`:

```json
{
  "status": "queued",
  "taskId": "task-456",
  "message": "Task added to queue"
}
```

Задача попадает в очередь `conversion` (BullMQ), её обрабатывает сервис `worker`.
Готовый файл сохраняется в `STORAGE_PATH`, а в Valkey записывается результат.

Если `SYNC_ENABLED=false`, запрос с `async: false` получает `501` с кодом `sync_disabled`.

### Идемпотентность

Ключ `key` резервируется в Valkey через `SET NX EX` на `IDEMPOTENCY_TTL_SEC` (по умолчанию час).

| Ситуация | Ответ |
|---|---|
| Ключ свободен | Задача выполняется (200 или 202) |
| Ключ занят, параметры те же | `202` со статусом существующей задачи; повторной конвертации нет |
| Ключ занят, но `filetype`/`outputtype` другие | `409`, код `key_conflict` |

Без поля `key` каждая конвертация запускается заново под свежим UUID.

## GET /status/:taskId

```bash
curl http://localhost:3000/status/task-456
```

Ответ — `200`:

```json
{
  "taskId": "task-456",
  "status": "completed",
  "progress": 100,
  "result": {
    "fileUrl": "/results/task-456.pdf",
    "fileType": "pdf",
    "size": 12345
  }
}
```

| Поле | Значения |
|---|---|
| `status` | `processing`, `queued`, `completed`, `failed` |
| `progress` | `100` для `completed`, `50` для `processing`, `0` иначе |
| `result` | Присутствует при `completed` |
| `error` | `{ code, message }` при `failed` |
| `queued` | `true`, если задача найдена только в очереди BullMQ |

Задача ищется сначала в Valkey, затем в BullMQ. Если не найдена нигде — `404` с кодом
`task_not_found`. Успешный ответ содержит заголовок `X-Task-Id`.

## GET /status

Пакетная проверка: параметр `taskIds` передаётся повторно, по одному значению на задачу.

```bash
curl 'http://localhost:3000/status?taskIds=task-1&taskIds=task-2'
curl 'http://localhost:3000/status?taskIds=task-1'    # то же, но для одной задачи
```

```json
{
  "tasks": [
    { "taskId": "task-1", "status": "completed", "progress": 100, "result": { } },
    { "taskId": "task-2", "status": "not_found" }
  ]
}
```

Одиночный `taskIds` (без повторов) принимается наравне с массивом — это осознанное
расширение контракта, закреплённое `tests/status.test.js`. `400` с кодом `invalid_request`
возвращается только тогда, когда параметра нет вовсе.

## GET /results/:fileName

Отдаёт готовый файл из хранилища. Имя файла — `{taskId}.{extension}`, то есть
значение `fileUrl` из ответа асинхронной задачи без ведущего слэша.

```bash
curl -OJ 'http://localhost:3000/results/6f1e4c2a-....pdf'
curl -OJ 'http://localhost:3000/results/6f1e4c2a-....pdf?name=Отчёт.pdf'
```

| Параметр | Где | Описание |
|---|---|---|
| `fileName` | путь | `{taskId}.{extension}`, где `extension` — из allowlist выходных форматов |
| `name` | запрос, необязательный | Человекочитаемое имя для `Content-Disposition`. Разделители пути и управляющие символы вырезаются |

Ответ — файл с заголовками `Content-Type` по расширению, `Content-Length` и
`Content-Disposition: attachment`.

Тот же обработчик смонтирован и по пути `/storage/results/...` — алиас сохранён для
совместимости: раньше синхронный и асинхронный пути формировали разные `fileUrl`, и клиент
использует значение из ответа дословно. Сейчас ссылки формируются одинаково
(`/results/...`), но обе формы продолжают работать.

| HTTP | Код | Условие |
|---|---|---|
| `400` | `invalid_result_name` | Имя не разобралось, расширение вне allowlist, идентификатор длиннее 64 символов |
| `404` | `result_not_found` | Файла нет в хранилище (задача не выполнена или результат удалён) |
| `500` | `result_read_failed` | Файл есть, но чтение не удалось |

> Файлы результатов **не удаляются автоматически**: механизма очистки в сервисе нет
> (функция `cleanupStorage()` удалена как мёртвая). Ссылка перестанет работать
> только после ручной очистки каталога `STORAGE_PATH`.

## GET /health

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "wasm": true,
  "version": "1.0.0"
}
```

Обрабатывается контроллером `src/nest/health/health.controller.ts`. Флаг `wasm` сейчас
возвращается константой (`wasmReady = true`), реальная проверка движка не выполняется —
её роль играет docker healthcheck (см. [deployment.md](deployment.md#healthcheck)).

## Заголовки

| Заголовок | Где | Значение |
|---|---|---|
| `X-Task-Id` | Ответы конвертации и статуса | Идентификатор задачи |
| `X-Converter-Version` | Все ответы | Версия из `package.json` |
| `X-Request-Id` | Все ответы | Идентификатор запроса (переиспользуется из заголовка запроса или генерируется) |
| `X-RateLimit-Limit` | Все ответы | Потолок запросов в окне — равен `RATE_BURST` (20) |
| `X-RateLimit-Remaining` | Все ответы | Остаток в текущем окне |
| `X-RateLimit-Reset` | Все ответы | Время сброса окна (Unix-время, секунды) |
| `Retry-After` | Ответ 429 | Через сколько секунд повторять |
| `Cache-Control` | Все ответы | `no-store, no-cache, must-revalidate, private` |
| `X-Content-Type-Options` | Все ответы | `nosniff` |
| `X-Frame-Options` | Все ответы | `DENY` |
| `Cross-Origin-Opener-Policy` | Все ответы | `same-origin` |
| `Cross-Origin-Embedder-Policy` | Все ответы | `require-corp` |
| `Cross-Origin-Resource-Policy` | Все ответы | `same-origin` |
| `Content-Security-Policy` | Только `NODE_ENV=production` | `default-src 'self'; script-src 'self'; …` |
| `Access-Control-Allow-Origin` | Только `NODE_ENV=development` | `*` |

Заголовки COOP/COEP/CORP нужны для `SharedArrayBuffer`: без них не запускается
многопоточный WASM-движок LibreOffice.

## Коды ошибок

Формат тела ошибки единый:

```json
{ "error": "<код>", "message": "<пояснение>", "taskId": "<если применимо>" }
```

Код — snake_case. Полная таблица «код → HTTP-статус → условие» приведена в
[security.md](security.md#сводная-таблица-кодов-ошибок). Кратко:

| HTTP | Коды | Что случилось |
|---|---|---|
| `400` | `unknown_field`, `{field}_required`, `field_type_mismatch`, `exactly_one_source_required`, `input_format_not_allowed`, `output_format_not_allowed`, `key_invalid_chars`, `title_too_long`, `region_invalid`, `codePage_not_allowed`, `delimiter_not_allowed`, `data_invalid_base64` | Нарушение схемы запроса |
| `400` | `url_malformed`, `url_too_long`, `url_scheme_forbidden`, `url_credentials_forbidden`, `url_no_host`, `url_private_ip` | Ссылка не прошла SSRF-проверку |
| `404` | `task_not_found`, `not_found` | Задача или маршрут не найдены |
| `409` | `key_conflict` | Ключ занят задачей с другими параметрами |
| `413` | `file_too_large`, `data_too_large` | Файл больше `MAX_FILE_BYTES` (100 MiB) |
| `415` | `magic_mismatch`, `magic_buffer_empty`, `magic_type_missing`, `magic_unsupported_type`, `magic_buffer_too_small` | Содержимое не соответствует объявленному `filetype` |
| `422` | `archive_forbidden_name`, `archive_ratio_exceeded`, `archive_too_many_entries`, `archive_too_deep`, `archive_duplicate_entry`, `archive_forbidden_extension`, `archive_entry_too_large`, `archive_total_too_large`, `archive_empty`, `archive_corrupt`, `content_validation_failed` | Архив не прошёл проверку |
| `429` | `rate_limited` | Превышен лимит запросов с одного IP |
| `503` | `storage_unavailable` | Хранилище состояния недоступно: Valkey не отвечает или упёрся в `maxmemory`, либо недоступен каталог входных файлов. Ответ несёт `Retry-After` |
| `500` | `conversion_failed`, `internal`, `job_processing_failed`, `output_too_small` | Сбой конвертации |
| `501` | `sync_disabled` | `async: false` при выключенном синхронном режиме |
| `504` | `sync_timeout` | Синхронный запрос не уложился в бюджет времени |
| `408` | `body_timeout` | Тело запроса не пришло за `REQUEST_BODY_TIMEOUT_MS` (на практике не срабатывает — см. ограничения). Статус отдаёт фильтр ошибок для исключений Nest с кодом 408 |

Отдельно у `/status` свои коды: `invalid_request` (400 — не передан `taskIds` либо
идентификаторов больше `MAX_STATUS_BATCH_IDS`), `task_not_found` (404),
`status_check_failed` (500).

Пакетный ответ деградирует по задачам, а не по запросу: если Valkey недоступен,
каждая задача получает `status: "error"`, а сам запрос остаётся `200` — иначе клиент
не отличил бы недоступность хранилища от ошибки собственного запроса. Неизвестный
идентификатор даёт `status: "not_found"`.

### Ограничение частоты

Лимит — ведро с токенами на IP: ёмкость `RATE_BURST` (20), пополнение `RATE_PER_SEC` (5)
в секунду. Всплеск до 20 запросов проходит сразу, дальше устойчивая скорость — 5 запросов
в секунду. При превышении — `429`:

```json
{ "error": "rate_limited", "message": "Too many requests. Try again in 2 seconds." }
```

Состояние счётчиков хранится в памяти процесса, поэтому при нескольких репликах API
каждая считает лимит независимо.

## Ограничения

- Размер тела запроса — 100 МиБ: лимит единый (`BODY_LIMIT_BYTES = MAX_BODY_BYTES`
  в `src/nest/common/http-defaults.ts`), отдельного лимита на маршруте конвертации нет.
  Практический предел base64-полезной нагрузки — около 75 МиБ исходного файла
  (base64 добавляет треть).
- При загрузке по `url` проверяется `Content-Type` (allowlist из шести значений),
  `Content-Length` и фактический размер; редиректы не ограничиваются.
- Хост из `url` проверяется дважды: по списку подозрительных подстрок (`localhost`, `local`,
  `internal`, `private`, `intranet`) и по адресам, в которые он резолвится. Имя вида
  `storage.internal` будет отклонено подстрокой, даже если указывает на публичный адрес, —
  внутренние источники передавайте по IP или через поле `data`.
- Формат ответа для `thumbnail` не реализован: поле принимается, но в опции конвертера не попадает.
- Код `output_too_small` возвращается, если результат короче `MIN_OUTPUT_BYTES` (32 байта) —
  это признак неудачной конвертации.
- **`key` длиннее 64 символов**: схема запроса допускает до 128 символов, но
  `reserveTaskId` отвергает идентификаторы длиннее 64 (`MAX_TASK_ID_LENGTH`). Такой запрос
  вернёт `500 internal`, а не `400`. Держитесь в пределах 64 символов.
- `fileUrl` в обоих режимах формируется одинаково — `/results/{taskId}.{ext}`
  (`writeResult` в `src/storage/fileStorage.ts`); прежний префикс `/storage/results/…`
  продолжает обслуживаться как алиас.
- Таймаут тела запроса (`408 body_timeout`) объявлен, но фактически не срабатывает:
  в NestJS-слое разбор тела ограничен только размером (`BODY_LIMIT_BYTES`), а таймаут
  приёма тела жил в Express-middleware, который удалён вместе с Express-слоем. Код ошибки
  остался в контракте и в фильтре (`src/nest/common/r7-exception.filter.ts`).
