# HTTP API

Базовый адрес в compose: `http://localhost:3000` (порт открыт только
на loopback, наружу отдаёт nginx на `http://localhost:8080`).

Формат ошибок единый для всех маршрутов:

```json
{ "error": "file_required", "message": "В запросе нет файла в поле «file»" }
```

`error` — код в snake_case из `packages/contract/src/errors.ts`,
`jobId` и `requestId` добавляются, когда ошибка привязана к задаче
или к конкретному запросу.

## POST /convert/xlsx-to-pdf

Принимает файл и ставит задачу на конвертацию.

**Тело:** `multipart/form-data`.

| Поле | Обязательное | Описание |
|---|---|---|
| `file` | да | Файл XLSX или XLS, до 100 МиБ |
| `watermark` | нет | Текст водяного знака, до 200 символов |
| `watermarkMode` | нет | `single` (по умолчанию) или `tiled` |
| `fitToOnePage` | нет | `true` по умолчанию |
| `pdfVersion` | нет | `default`, `pdfa-1a`, `pdfa-2b`, `pdfa-3b` |
| `quality` | нет | 1–100, по умолчанию 90 |
| `reduceImageResolution` | нет | `true` по умолчанию |
| `maxImageResolution` | нет | 50–1200 DPI, по умолчанию 300 |
| `exportBookmarks` | нет | `true` по умолчанию |
| `taggedPdf` | нет | `false` по умолчанию |
| `userPassword` | нет | Пароль на открытие PDF |
| `ownerPassword` | нет | Пароль владельца |
| `restrictPermissions` | нет | `false` по умолчанию |
| `allowPrinting` | нет | `true` по умолчанию |
| `allowChanges` | нет | `false` по умолчанию |

**Ответ 202:**

```json
{
  "jobId": "9f1c2f5e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  "status": "queued",
  "tier": "light",
  "queue": "xlsx2pdf.light",
  "sheets": 3,
  "sizeBytes": 48211,
  "createdAt": "2026-09-20T10:15:00.000Z"
}
```

`sheets` равен `null`, если число листов определить не удалось (файл `.xls`
или повреждённый контейнер). `tier` и `queue` показывают, куда попала задача.

**Ошибки:**

| Код | Статус | Когда |
|---|---|---|
| `file_required` | 400 | Поля `file` нет или файл пуст |
| `invalid_option_value` | 400 | Параметр вне диапазона или неизвестное значение |
| `file_too_large` | 413 | Файл больше `MAX_FILE_BYTES` |
| `magic_mismatch` | 415 | Содержимое не соответствует расширению |
| `unsupported_format` | 415 | Формат не поддерживается |
| `content_validation_failed` | 422 | Архив не прошёл zip-гард (бомба, traversal) |
| `storage_unavailable` | 503 | Недоступно хранилище или очередь |
| `rate_limited` | 429 | Превышен лимит запросов (есть `Retry-After`) |

## GET /convert/status/:id

Состояние задачи. `:id` — идентификатор в формате UUID, выданный при постановке.

**Ответ 200:**

```json
{
  "jobId": "9f1c2f5e-...",
  "status": "completed",
  "tier": "light",
  "createdAt": "2026-09-20T10:15:00.000Z",
  "startedAt": "2026-09-20T10:15:02.000Z",
  "finishedAt": "2026-09-20T10:15:06.000Z",
  "result": {
    "url": "http://localhost:9000/conversions/results/9f1c2f5e-....pdf?X-Amz-...",
    "expiresAt": "2026-09-20T11:15:06.000Z",
    "sizeBytes": 152340
  }
}
```

Состояния: `queued` → `processing` → `completed` либо `failed`.

При `failed` вместо `result` приходит описание ошибки:

```json
{
  "status": "failed",
  "error": { "code": "conversion_failed", "message": "LibreOffice не смог открыть документ" }
}
```

`result.url` — presigned-ссылка MinIO. Она живёт `PRESIGN_EXPIRY_SEC`
(по умолчанию час) и **привязана к хосту**: если клиент не может открыть
её напрямую, значит `S3_PUBLIC_ENDPOINT` не совпадает с адресом, доступным
клиенту.

**Ошибки:**

| Код | Статус | Когда |
|---|---|---|
| `invalid_request` | 400 | Идентификатор не в формате UUID |
| `job_not_found` | 404 | Задачи нет или истёк `JOB_TTL_SEC` |

## GET /health

```json
{ "status": "ok", "storage": true, "version": "1.0.0" }
```

`status` принимает значение `ok` или `degraded`. Ответ всегда 200:
`degraded` означает, что процесс жив, но хранилище недоступно — это отличает
отказ зависимости от отказа сервиса. Готовность LibreOffice здесь
не проверяется, за неё отвечает healthcheck контейнера-воркера.
