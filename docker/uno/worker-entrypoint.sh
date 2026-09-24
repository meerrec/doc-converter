#!/bin/sh
# =============================================================================
# Точка входа контейнера-воркера: soffice с UNO-сокетом, затем воркер.
#
# Порядок важен: воркер начинает слушать очередь только после того, как
# UNO-бридж готов принимать вызовы. Проверка «порт открыт» недостаточна —
# сокет начинает принимать соединения раньше, чем зарегистрирован
# сервис-менеджер, и первая же задача упала бы с ошибкой подключения.
#
# Профиль LibreOffice лежит в /tmp: корневая файловая система контейнера
# смонтирована только для чтения, а LibreOffice обязан писать в профиль
# пользователя при старте.
#
# Все комментарии на русском языке.
# =============================================================================
set -eu

UNO_PORT="${UNO_PORT:-2002}"
UNO_SCRIPT="${UNO_SCRIPT_PATH:-/app/docker/uno/uno_convert.py}"
PROFILE_DIR="${LO_PROFILE_DIR:-/tmp/lo-profile}"
WORKER_ENTRY="${WORKER_ENTRY:-/app/apps/worker/dist/index.js}"

# Сколько секунд ждать готовности бриджа. Холодный старт занимает 2–5 с,
# но под нагрузкой (одновременный старт реплик, сканирование шрифтов) время
# растёт; 60 с — с запасом, и всё равно меньше таймаута healthcheck'а.
READY_TIMEOUT_SEC="${UNO_READY_TIMEOUT_SEC:-60}"

# Период опроса бриджа после запуска воркера. Сама проверка (`kill -0`)
# бесплатна, пауза нужна лишь чтобы не крутить цикл на холостом ходу.
# 2 с — это ещё и окно, в течение которого воркер может взять задачу
# у мёртвого бриджа; задача не теряется, BullMQ вернёт её в очередь
# по stalled-механизму.
BRIDGE_WATCH_INTERVAL_SEC=2

mkdir -p "$PROFILE_DIR"

echo "[entrypoint] Запуск LibreOffice (порт UNO ${UNO_PORT})"

# --norestore: не пытаться восстановить сессии после падения
# --nolockcheck: не проверять блокировки файлов в общем профиле
# --nodefault/--nofirststartwizard: не показывать диалоги (их всё равно негде показать)
soffice \
  --headless \
  --invisible \
  --nologo \
  --nodefault \
  --norestore \
  --nolockcheck \
  --nofirststartwizard \
  -env:UserInstallation="file://${PROFILE_DIR}" \
  --accept="socket,host=127.0.0.1,port=${UNO_PORT};urp;" &

SOFFICE_PID=$!

# Останавливает оба процесса: без явного kill soffice переживёт воркера
# и контейнер будет ждать принудительного завершения по таймауту.
#
# Наблюдатель снимается первым и SIGKILL'ом: мягкий сигнал он обработал бы
# между итерациями, успел бы увидеть убитый ниже soffice и напечатать
# «LibreOffice завершился» в лог штатной остановки. Завершать ему нечего —
# ни файлов, ни соединений он не держит.
shutdown() {
  echo "[entrypoint] Остановка"
  if [ -n "${BRIDGE_WATCH_PID:-}" ]; then
    kill -KILL "$BRIDGE_WATCH_PID" 2>/dev/null || true
  fi
  kill -TERM "$SOFFICE_PID" 2>/dev/null || true
  if [ -n "${NODE_PID:-}" ]; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit 0
}

trap shutdown TERM INT

echo "[entrypoint] Ожидание готовности UNO-бриджа"

READY=0
ELAPSED=0

while [ "$ELAPSED" -lt "$READY_TIMEOUT_SEC" ]; do
  # soffice мог упасть (нет места, битый профиль) — ждать дальше бессмысленно
  if ! kill -0 "$SOFFICE_PID" 2>/dev/null; then
    echo "[entrypoint] LibreOffice завершился до готовности бриджа" >&2
    exit 1
  fi

  if python3 "$UNO_SCRIPT" --ping >/dev/null 2>&1; then
    READY=1
    break
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "$READY" -ne 1 ]; then
  echo "[entrypoint] UNO-бридж не поднялся за ${READY_TIMEOUT_SEC} с" >&2
  kill -TERM "$SOFFICE_PID" 2>/dev/null || true
  exit 1
fi

echo "[entrypoint] Бридж готов, запуск воркера"

node "$WORKER_ENTRY" &
NODE_PID=$!

# Надзор за бриджем. Без него смерть soffice остаётся незамеченной: воркер
# продолжает слушать очередь и валит каждую задачу с `uno_unavailable`,
# пока реплику не перезапустят руками — а healthcheck, которым контейнер
# помечается нездоровым, перезапуска не вызывает.
#
# Опрос, а не `wait`: подождать чужой процесс из подоболочки нельзя, тогда
# как soffice — потомок этого же shell и `kill -0` видит его состояние.
(
  while kill -0 "$SOFFICE_PID" 2>/dev/null; do
    sleep "$BRIDGE_WATCH_INTERVAL_SEC"
  done

  echo "[entrypoint] LibreOffice завершился — останавливаю воркер" >&2
  kill -TERM "$NODE_PID" 2>/dev/null || true
) &
BRIDGE_WATCH_PID=$!

# Ждём именно воркер: если он умрёт, контейнер должен перезапуститься
# (restart: unless-stopped), а не висеть с живым, но бесполезным soffice
wait "$NODE_PID"
EXIT_CODE=$?

# Наблюдатель больше не нужен, и снимается он SIGKILL'ом: мягкий сигнал
# он обработал бы между итерациями — успел бы увидеть убитый ниже soffice
# и напечатать в лог реакцию на событие, к которому отношения не имеет
kill -KILL "$BRIDGE_WATCH_PID" 2>/dev/null || true

# Код выхода решает entrypoint, а не воркер: остановленный наблюдателем
# воркер завершает свой shutdown со статусом 0, и для `restart: unless-stopped`
# это означало бы «всё в порядке». Мёртвый бридж — не порядок: реплика
# в таком виде нерабочая, и контейнер обязан подняться заново.
if ! kill -0 "$SOFFICE_PID" 2>/dev/null; then
  echo "[entrypoint] Бридж мёртв — реплике нужен перезапуск" >&2
  EXIT_CODE=1
fi

echo "[entrypoint] Воркер завершился с кодом ${EXIT_CODE}"
kill -TERM "$SOFFICE_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$EXIT_CODE"
