# Безопасность

Сервис принимает недоверенные файлы и ходит по недоверенным URL, поэтому защита построена
как последовательность независимых слоёв. Каждый слой можно проверить отдельно, и каждый
возвращает свой код ошибки.

```
rateLimit → validate (схема + allowlist) → urlGuard (SSRF) → magicBytes → zipGuard → sandbox/изоляция
```

Все проверки сосредоточены в `src/security/` (плюс middleware `src/api/middleware/validate.js`)
и покрыты `tests/security.test.js` — 76 тестов, фикстуры для атак генерируются кодом в
`tests/helpers/attackFixtures.js`.

## Rate limiting

`src/api/middleware/rateLimit.js` — sliding window на IP-адрес.

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `RATE_PER_SEC` | `5` | Устойчивая скорость запросов в секунду с одного IP |
| `RATE_BURST` | `20` | Допустимый кратковременный всплеск |

Middleware навешан дважды: глобально в `api/server.js:50` и на маршрут конвертации
(`api/routes/convert.js:71`).

## Валидация схемы запроса

`validateBodyMiddleware()` (`src/api/middleware/validate.js:261`) пропускает только
известные поля — любое лишнее поле даёт `unknown_field`. Это защита от «инъекции»
неожиданных параметров в конвертер.

Порядок проверок: `unknown_field` → `{field}_required` → `field_type_mismatch` →
`exactly_one_source_required` (XOR `url`/`data`) → allowlist форматов → паттерны полей.

| Поле | Ограничение |
|---|---|
| `key` | `^[A-Za-z0-9._-]{1,128}$`, иначе `key_invalid_chars` |
| `title` | не длиннее 255 символов, иначе `title_too_long` |
| `region` | `^[a-zA-Z]{2}(-[a-zA-Z]{2})?$`, иначе `region_invalid` |
| `codePage` | только `65001, 1251, 1252, 866, 20866, 28595` |
| `delimiter` | только `1, 2, 3, 4` |

Форматы — по allowlist: 16 входных (`doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp, rtf,
txt, html, htm, csv, pdf, epub`) и 16 выходных (`pdf, pdfa, docx, xlsx, csv, txt, html,
png, jpg, jpeg, svg, odt, ods, odp, rtf, epub`).

## SSRF-защита (`urlGuard.js`)

Разрешены только схемы **http** и **https**; `file`, `ftp`, `gopher`, `data`, `javascript`
и прочие отбрасываются с `url_scheme_forbidden`. URL с логином/паролем — `url_credentials_forbidden`.

Приватные адреса блокируются и как IP-литералы, и после DNS-резолва:

| Диапазон | Назначение |
|---|---|
| `0.0.0.0/8` | «this network» |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | приватные сети |
| `100.64.0.0/10` | Shared Address Space (RFC 6598) |
| `127.0.0.0/8` | loopback |
| `169.254.0.0/16` | link-local, включая `169.254.169.254` — метаданные облака |
| `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | IETF/TEST-NET |
| `192.88.99.0/24` | 6to4 relay anycast |
| `198.18.0.0/15` | benchmarking |
| `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255` | multicast и зарезервированные |
| `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `ff00::/8` | IPv6: loopback, ULA, link-local, IPv4-mapped, multicast |

Дополнительно отбрасываются хосты, содержащие подстроки `localhost`, `local`, `internal`,
`private`, `intranet`.

**Fail-safe по DNS.** Если имя не резолвится, хост считается приватным и блокируется
(`urlGuard.js:220-227`): недоступность DNS не должна открывать доступ внутрь периметра.
Резолв ограничен таймаутом `DNS_RESOLVE_TIMEOUT_MS` = 5 с. Ограничение длины URL —
`MAX_URL_LENGTH` = 2048 символов.

## Проверка сигнатур файлов (`magicBytes.js`)

Расширению из запроса не доверяем: формат подтверждается сигнатурой в начале файла.

| Формат | Сигнатура |
|---|---|
| `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`, `epub` | `PK\x03\x04` (или `PK\x05\x06` для пустого архива) |
| `doc`, `xls`, `ppt` | `D0 CF 11 E0 A1 B1 1A E1` (OLE Compound File) |
| `pdf` | `%PDF` |
| `rtf` | `{\rtf` |
| `png` | `89 50 4E 47 0D 0A 1A 0A` |
| `jpg`, `jpeg` | `FF D8 FF` |
| `txt`, `html`, `htm`, `csv` | сигнатуры нет — проверяется отсутствие NUL-байта в первых 8 КиБ |

Коды ошибок: `magic_mismatch`, `magic_buffer_empty`, `magic_type_missing`,
`magic_unsupported_type`, `magic_buffer_too_small`.
Через API несовпадение отдаётся как **415**.

## Защита ZIP-архивов (`zipGuard.js`)

Проверка идёт **без распаковки**: `yauzl` в режиме `lazyEntries` читает только оглавление,
решения принимаются по заявленным в заголовках размерам. Это защищает от заполнения диска
и памяти при разборе бомбы.

| Угроза | Лимит | Код нарушения |
|---|---|---|
| Много записей (перегрузка CPU) | 5000 записей | `archive_too_many_entries` |
| Гигантская запись | 256 МиБ в распакованном виде | `archive_entry_too_large` |
| Суммарный объём | 512 МиБ | `archive_total_too_large` |
| Zip-бомба по сжатию | коэффициент > 100 | `archive_ratio_exceeded` |
| Глубокая вложенность | 16 уровней | `archive_too_deep` |
| Zip Slip / path traversal | любое `..`, абсолютный путь, `C:\…` | `archive_forbidden_name` |
| Управляющие символы в имени | `[\x00-\x1F\x7F<>:"|?*\\]` | `archive_forbidden_name` |
| Опасные расширения (23 шт.: `.exe`, `.dll`, `.so`, `.bat`, `.ps1`, `.sh`, `.js`, `.jar`, …) | — | `archive_forbidden_extension` |
| Дубликаты имён | — | `archive_duplicate_entry` |
| Пустой архив | — | `archive_empty` |
| Битый архив | — | `archive_corrupt` |

Нарушения возвращаются в `ZipGuardResult.violations`; через API (для источника `data`)
они превращаются в **422** с кодом первого нарушения.

## Защита XML (`xmlGuard.js`)

Эвристическая проверка без полного разбора DOM: ищутся `<!DOCTYPE`, `<!ENTITY`, `SYSTEM`,
`PUBLIC` (признаки XXE), контролируется глубина вложенности (признак billion laughs) и размер
части (признак quadratic blowup).

| Лимит | Значение | Код |
|---|---|---|
| Размер XML-части | 64 МиБ | `xml_part_too_large` |
| Глубина элементов | 256 | `xml_too_deep` |
| Запрещённые конструкции | DOCTYPE/ENTITY/SYSTEM/PUBLIC | `xml_forbidden_construct` |

> **Не подключено к конвейеру.** `validateXml` импортируется в `worker/processor.js:41`,
> но не вызывается; `validateXmlInZip` — заглушка, всегда возвращающая `{isValid: true}`
> (`xmlGuard.js:239`). Фактически XML внутри офисных документов сейчас не проверяется.

## Изоляция выполнения

Два независимых механизма — по одному на каждый путь выполнения (см. [architecture.md](architecture.md)).

### Fork-пул (оба режима)

Конвертация идёт в дочернем процессе (`child_process.fork`, `serialization: 'advanced'`),
который не имеет доступа к сокетам API, очереди и Valkey. Изоляция — на уровне ОС.
Этот механизм используется и синхронным, и асинхронным путём.

- `MAX_CONCURRENT` = 4 задачи одновременно, `FORK_POOL_SIZE` = 4 процесса.
- Ожидание слота ограничено `SYNC_QUEUE_WAIT_MS` = 5 с (в синхронном режиме).
- По истечении `JOB_TIMEOUT_MS` = 60 с процесс убивается **`SIGKILL`**. Это принципиально:
  `Promise.race` не останавливает уже запущенный WASM, а `SIGTERM` перехватывается —
  без `SIGKILL` процесс продолжил бы работу в фоне.
- При обрыве соединения клиентом форк также убивается (`api/routes/convert.js:91-107`).
- Дочерним процессам выдаётся `--disable-wasm-trap-handler --max-old-space-size=1536`.

Дополнительно сама библиотека конвертера в Node-окружении выполняет работу через
`SubprocessConverter` — то есть конвертация идёт ещё на один процесс глубже.

### Отказ от `isolated-vm`

`worker/wasm-isolate.js` (изолят с `memoryLimit`) в конвейере не используется. Причины:
WASM-память не изолируется в пределах потока (это отмечает и загрузчик библиотеки,
`wasm/loader-isolated.cjs`), а вызов конвертера через границу изолята падает с ошибкой
клонирования — проверено на `SubprocessConverter` и `LibreOfficeConverter`. Модуль
оставлен в коде, но не подключён; `vm2` не используется и не должен использоваться.
Защиту по памяти обеспечивают `mem_limit` контейнера и отдельный процесс конвертера.

Уровни защиты памяти описаны в [configuration.md](configuration.md#конкурентность-и-память).

## Аудит-лог

`src/api/middleware/auditLog.js` — отдельный pino-инстанс, пишущий в `AUDIT_LOG_PATH`
(в Docker — `/var/log/converter/audit.log`, том `doc-converter-audit-log`).
Уровень — `AUDIT_LOG_LEVEL` (по умолчанию `info`). Если путь не задан, события уходят в stdout.

События:

| Функция | Когда вызывается |
|---|---|
| `logRejection` | Любой отказ: несовпадение сигнатур, приватный URL, нарушение ZIP, ошибка схемы, конфликт ключа, обрыв клиента |
| `logSuccess` | Успешная постановка задачи в очередь и успешная синхронная конвертация |
| `logConversionError` | Ошибка конвертации — с кодом, сообщением и длительностью |

В записи попадают `requestId`, IP, User-Agent, объявленное расширение, размер и код события.

## Сводная таблица кодов ошибок

| HTTP | Коды | Причина |
|---|---|---|
| **400** | `body_must_be_object`, `unknown_field`, `{field}_required`, `field_type_mismatch`, `exactly_one_source_required`, `input_format_not_allowed`, `output_format_not_allowed`, `key_invalid_chars`, `title_too_long`, `region_invalid`, `codePage_not_allowed`, `delimiter_not_allowed`, `data_invalid_base64` | Нарушение схемы запроса |
| **400** | `url_malformed`, `url_too_long`, `url_scheme_forbidden`, `url_credentials_forbidden`, `url_no_host`, `url_private_ip` | SSRF-проверка |
| **409** | `key_conflict` | Тот же `key`, но другие `filetype`/`outputtype` |
| **413** | `file_too_large`, `data_too_large` | Превышен `MAX_FILE_BYTES` (100 MiB) |
| **415** | `magic_mismatch` и прочие коды `magicBytes` | Содержимое не соответствует объявленному формату |
| **422** | `archive_*` (`archive_forbidden_name`, `archive_ratio_exceeded`, `archive_too_many_entries`, …), `content_validation_failed` | Нарушение при проверке архива |
| **501** | `sync_disabled` | `async: false` при `SYNC_ENABLED=false` |
| **504** | `sync_timeout` | Синхронный запрос не уложился в `SYNC_TIMEOUT_MS` |
| **500** | `conversion_failed`, `internal`, `job_processing_failed`, `output_too_small` | Сбой конвертации или неклассифицированная ошибка |
| **404** | `not_found` | Неизвестный маршрут |

Формат тела ошибки единый: `{ error: <код>, message, taskId? }`, код — snake_case.

## Что покрыто тестами

`tests/security.test.js` (76 тестов) проверяет:

- **magic bytes** — соответствие сигнатур, отказ при несовпадении, поведение на пустом и
  слишком коротком буфере;
- **SSRF** — `127.0.0.1`, `169.254.169.254` (метаданные облака), `10.0.0.1`, `192.168.1.1`,
  `::1`, `fc00::/7`, `fe80::/10`, а также запрещённые схемы `file://` и `gopher://`,
  URL с учётными данными, `localhost`;
- **ZIP** — бомба, path traversal, запрещённые расширения, дубликаты, глубокая вложенность,
  превышение числа записей, управляющие символы в именах;
- **XML** — DOCTYPE, ENTITY, XML-бомба (на уровне модуля);
- **схема запроса** — неизвестные поля, неверные типы, XOR `url`/`data`, allowlist форматов,
  паттерны `key`/`title`/`region`/`codePage`/`delimiter`;
- **API целиком** (supertest) — magic bytes и SSRF через реальный HTTP-запрос.

Не покрыты тестами: rate limiting (в тестах лимиты подняты до 100, чтобы не мешать) и
изоляция отдельной задачи в песочнице.

## Известные ограничения

Честный список того, что в текущей реализации работает не так, как можно ожидать по комментариям:

1. **XML-проверки не активны** — `validateXml` не вызывается, `validateXmlInZip` — заглушка.
2. **`validateZip` в двух местах вызывается без проверки результата** (`api/routes/convert.js:464`,
   `worker/processor.js:245`): реагируют только на исключение. Нарушения-лимиты отсекаются
   лишь в middleware и только для источника `data` — то есть для файла, скачанного по `url`,
   лимиты архива не применяются.
3. **`ZipGuardError` не содержит `statusCode`/`errorCode`** (используется поле `code`), поэтому
   часть нарушений архива в синхронном пути выходит наружу как **500 `internal`**, а не 422.
4. **Ошибки пересекают границу fork в виде строки** (`worker/fork-worker.js:155` шлёт только
   `error`), поэтому исходный `errorCode` теряется и синхронный путь почти всегда отвечает
   `conversion_failed` / `internal` со статусом 500.
5. **`checkMagicBytes` сравнивает префикс**: буфер из 3 байт `PK\x03` уже считается валидным
   DOCX. Реальная защита от мусора — последующая проверка ZIP.
6. **Редиректы при загрузке по URL не ограничены**: `MAX_REDIRECTS = 3` объявлен, но не
   применяется — `fetch` следует за перенаправлениями со стандартным поведением.
   Проверка URL выполняется один раз, до запроса.
7. **`file_too_large` в ZIP-ветке**: лимит `MAX_FILE_BYTES` для `data` проверяется до
   декодирования архива, но распакованный объём ограничивается отдельными лимитами `zipGuard`.
8. **Неиспользуемые константы**: `MAX_HEADER_SIZE`, `MAX_JSON_STRING_LENGTH`, `MAX_JSON_FIELDS`,
   `MAX_JSON_DEPTH`, `MAX_REDIRECTS` из `security/limits.js` не импортируются нигде;
   `magicBytes.js` дублирует их значения литералами.
9. **Валидация дублируется**: тело запроса проверяется дважды (`validateBodyMiddleware` и
   `validateConversionRequest` в роутере), контент — тоже (middleware и `validateInputContent`).
   Поведение при этом согласовано.
