# Развёртывание и эксплуатация

## Требования

- Docker 24+ и Docker Compose v2 (используются `mem_limit`, `group_add`,
  якоря YAML)
- Для автомасштабирования в compose — доступ к `/var/run/docker.sock`
  и GID его владельца в `.env`:

  ```bash
  # Linux
  stat -c '%g' /var/run/docker.sock      # GID группы docker
  # macOS (Docker Desktop) — сокет принадлежит root:root, нужно 0
  ```

  Без этого autoscaler перезапускается с ошибкой «Docker API недоступен».

- Образы берутся из двух реестров, Docker Hub не используется ни для чего:

  - `registry.access.redhat.com/ubi9/*` — базовые образы UBI 9 (Node 24 и его
    minimal-вариант, nginx). Pull анонимный, логин не нужен. С quay.io те же
    образы недоступны: namespace `ubi9` требует авторизации, и анонимный pull
    отвечает `401 Unauthorized`;
  - `quay.io` — MinIO (`quay.io/minio/minio`, `quay.io/minio/mc`; они уже
    собраны на ubi-micro) и Valkey (`quay.io/sclorg/valkey-8-c10s`).

  LibreOffice в репозиториях UBI не публикуется вовсе, поэтому воркер ставит
  его из AppStream AlmaLinux 9 — тот же EL9 ABI, что и у базы. Ставит его
  `microdnf`: runtime-образ воркера — minimal-вариант Node 24, dnf в нём нет.
  Версия там 7.1.8 (у прежнего Debian-образа была 7.4): вёрстку сложных
  документов стоит сверить на эталонных файлах перед выкатом.

## Запуск

```bash
docker compose up --build
```

Поднимаются `api`, `web`, три стартовых воркера, `autoscaler`, `minio`
с `minio-init`, `valkey`. Первый запуск собирает три образа: `api`
(автоскейлер запускается из него же), `web` (статика и nginx) и `uno-worker`
(с LibreOffice, 2,1 ГБ).

В образы приложений попадают только production-зависимости и собранный
`dist`: установка для сборки и установка для runtime — разные стадии
(`prod-deps` ставит `--prod` в пустой каталог), поэтому `typescript`,
`vitest` и исходников в runtime нет. У `api` это 450 МБ, из них
`node_modules` — 77 МБ, у `web` — 496 МБ.

Размеры выросли не из-за кода: базовые образы UBI сами по себе крупнее
Debian-овских (`ubi9/nginx-126` — 495 МБ, `ubi9/nodejs-24-minimal` — 360 МБ),
а в воркере к ним добавляются LibreOffice 7.1.8 из EL9 и JRE, которую
`libreoffice-core` требует жёстко (в Debian-сборке её не было). Наши слои
поверх баз — единицы мегабайт для web и api и около 1,7 ГБ для воркера.

Проверка: `curl -s localhost:3000/health | jq` → `{ "status": "ok", ... }`.

## Ресурсы и память

| Сервис | `mem_limit` | Почему |
|---|---|---|
| `api` | 1 ГБ | Файлы до 100 МБ в памяти при загрузке в хранилище |
| `uno-worker-*` | 2 ГБ | LibreOffice + документ + копия при экспорте |
| `autoscaler` | 256 МБ | Только расчёт и вызовы Docker API |
| `minio` | 512 МБ | Объекты до 100 МБ |
| `valkey` | 512 МБ | `maxmemory 400mb` плюс запас на фрагментацию и COW |

`memswap_limit` равен `mem_limit` намеренно: swap выключен, и при нехватке
памяти контейнер убивается OOM-killer'ом, а не деградирует. Менять значения
только парой — при `mem_limit` больше `memswap_limit` контейнер не стартует.

**Сколько реплик влезает.** Реплика воркера занимает 400–600 МБ в покое
и до 2 ГБ на пике. Планируя `maxReplicaCount`, считайте по пику: три тяжёлые
реплики — это до 6 ГБ.

## Масштабирование

Правила и обоснование — в README, раздел «Масштабирование».

### Kubernetes (KEDA)

Применяются `deploy/k8s/scaledobject-{light,medium,heavy}.yaml` плюс
Deployment'ы приложения. KEDA читает длину списка `bull:xlsx2pdf.<tier>:wait`
и меняет число реплик; доступ к Docker API не нужен.

При смене `QUEUE_PREFIX` поправьте `listName` в манифестах.

### docker compose (autoscaler)

Сервис `autoscaler` создаёт и удаляет контейнеры через Docker API:

- стартовые реплики compose (без метки `doc-converter.managed`) только
  считаются — их удаление привело бы к борьбе с `restart: unless-stopped`;
- созданные им самим (`doc-converter.managed=autoscaler`) — управляются
  полностью;
- шаг изменения не больше `AUTOSCALER_MAX_STEP` за цикл.

> Autoscaler монтирует docker.sock, что равносильно root-правам на хосте.
> В продакшене за пределами compose используйте KEDA.

## Диагностика

| Симптом | Причина и что смотреть |
|---|---|
| `storage_unavailable` (503) | MinIO недоступен или нет бакета. `docker compose logs minio-init`, `mc ls local/conversions` |
| Задача вечно в `queued` | Воркеры не слушают эту очередь: проверьте `WORKER_QUEUE` у реплики и имя очереди в `job:{id}` |
| `uno_unavailable` | soffice не поднялся: `docker compose logs uno-worker-light` — ищите `[entrypoint]` |
| `uno_unavailable`, в логах `ModuleNotFoundError: uno` | Сломалось связывание UNO с системным python3 (пакет `libreoffice-pyuno`). Проверка в CI: `python3 -c "import uno"` внутри образа |
| `conversion_timeout` | Документ не уложился в `CONVERSION_TIMEOUT_MS`: проверьте размер, число листов или страниц и память реплики |
| `conversion_failed` | Ошибка самого документа; текст от LibreOffice — в `message` статуса и в логах воркера |
| Ссылка на результат не открывается | `S3_PUBLIC_ENDPOINT` не совпадает с адресом, доступным клиенту |
| Контейнеры воркеров копятся | Autoscaler не может обратиться к Docker API: проверьте `DOCKER_GID` и `docker compose logs autoscaler` |
| Реплики постоянно перезапускаются | Падает soffice: смотрите логи entrypoint, чаще всего это нехватка памяти в `/tmp` (tmpfs) |
| Valkey в логах пишет `Permission denied`, задачи не сохраняются | Том принадлежит root: образ sclorg работает от UID 1001. Порядок перехода — в разделе «Обновление» |

Полезные команды:

```bash
# Состояние очередей
docker compose exec valkey valkey-cli llen bull:xlsx2pdf.heavy:wait
docker compose exec valkey valkey-cli llen bull:xlsx2pdf.heavy:active

# Состояние задачи
docker compose exec valkey valkey-cli hgetall job:<jobId>

# Реплики под управлением autoscaler'а
docker ps --filter label=doc-converter.role=uno-worker

# Проверка UNO вручную
docker compose exec uno-worker-light python3 /app/docker/uno/uno_convert.py --ping
```

## Обновление

Порядок: сначала `api` (он совместим со старой и новой версиями задач,
пока формат данных не менялся), затем воркеры. Задачи, взятые воркером
в момент остановки, возвращаются в очередь stalled-механизмом BullMQ
(`BULLMQ_STALLED_INTERVAL`), поэтому простоя для клиента не возникает —
увеличивается только время ожидания.

При изменении формата задачи или имён очередей сначала останавливаются
воркеры старой версии, иначе они будут разбирать задачи, которых не понимают.

**Поддержка DOCX обновляется в порядке «сначала воркеры, потом API».**
Новый API кладёт в очередь задачи с полем `inputFormat`, а воркер старого
образа про формат не знает и запустит для документа Word фильтр экспорта
Calc — задача упадёт. Обратный порядок (старый API, новые воркеры) безопасен:
старый API умеет только XLSX, а новый воркер конвертирует книги как раньше.
Записи о задачах, созданные до обновления, читаются и после него: поле
`inputFormat` в ответе необязательное.

**Том Valkey переходит другому владельцу.** Прежний образ с Docker Hub работал
от root, `quay.io/sclorg/valkey-8-c10s` — от пользователя 1001, и том, созданный
старым контейнером, ему не принадлежит: AOF не запишется, а Valkey будет
ругаться на права. Данные при этом переносятся — файлы лежат в корне тома,
а новый сервис смотрит в тот же каталог (`--dir` в `docker-compose.yml`):

```bash
# В простое: очередь и статусы задач на это время недоступны
docker compose down valkey
docker run --rm -u root --entrypoint chown \
  -v doc-converter-valkey-data:/var/lib/valkey/data \
  quay.io/sclorg/valkey-8-c10s:c10s -R 1001:0 /var/lib/valkey/data
```

Проверка после подъёма: `docker compose exec valkey valkey-cli info persistence`
— `aof_enabled:1`, и `valkey-cli config get maxmemory` → `400mb`
(флаги командной строки действительно применились).

**LibreOffice в воркере понижается с 7.4 до 7.1.8** (EL9-версия из AppStream
AlmaLinux 9). Прогоните эталонные документы — особенно многостраничные DOCX
и книги с `fitToOnePage` — и сверьте результат с прежним PDF до выката.
