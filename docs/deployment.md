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

- Образы MinIO берутся с `quay.io`: MinIO прекратила публикацию на Docker Hub,
  и `minio/minio` там больше не существует.

## Запуск

```bash
docker compose up --build
```

Поднимаются `api`, `web`, три стартовых воркера, `autoscaler`, `minio`
с `minio-init`, `valkey`. Первый запуск собирает два образа: `api`
(лёгкий) и `uno-worker` (с LibreOffice, порядка 700 МБ).

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
| `conversion_timeout` | Книга не уложилась в `CONVERSION_TIMEOUT_MS`: проверьте размер, число листов и память реплики |
| `conversion_failed` | Ошибка самого документа; текст от LibreOffice — в `message` статуса и в логах воркера |
| Ссылка на результат не открывается | `S3_PUBLIC_ENDPOINT` не совпадает с адресом, доступным клиенту |
| Контейнеры воркеров копятся | Autoscaler не может обратиться к Docker API: проверьте `DOCKER_GID` и `docker compose logs autoscaler` |
| Реплики постоянно перезапускаются | Падает soffice: смотрите логи entrypoint, чаще всего это нехватка памяти в `/tmp` (tmpfs) |

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
