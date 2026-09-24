#!/bin/sh
# =============================================================================
# Получение готовой сборки LibreOffice для браузера (LOWA) и фиксация её состава.
#
# Сборка не собирается нами: она берётся готовой у вендора (ZetaOffice) и
# раздаётся со своего nginx. Что это меняет по сравнению с раздачей прямо
# с чужого CDN:
#
#   - версия перестаёт быть плавающей. У вендора доступен единственный путь
#     `zetaoffice_latest`, то есть «сегодня одно, завтра другое». Контрольные
#     суммы, записанные здесь, превращают его в пин: сборка образа сверяет
#     файлы с этими хэшами и падает, если вендор обновил сборку;
#   - раздача работает в закрытом контуре, где внешний CDN недоступен.
#
# Обновление сборки — осознанное действие: запустить этот скрипт, посмотреть,
# что изменилось, и закоммитить новый файл сумм. Автоматического «подтянуть
# последнюю» нет намеренно.
#
# ВНИМАНИЕ: вопрос о праве на самостоятельную раздачу этих файлов открыт —
# условия вендор не публикует, на сайте сказано «Both options are possible»
# с отсылкой к контактам. До получения ответа файлы используются для проверки
# гипотезы, а не для поставки. См. docs/local-wasm.md.
#
# Использование: fetch.sh [каталог]
#   каталог — куда скачать (по умолчанию apps/web/lowa/assets)
#
# Все комментарии на русском языке.
# =============================================================================
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET_DIR=${1:-"$SCRIPT_DIR/assets"}

# Адрес можно переопределить: в закрытом контуре это будет внутреннее зеркало,
# куда файлы положены один раз.
SOURCE_URL=${LOWA_SOURCE_URL:-https://cdn.zetaoffice.net/zetaoffice_latest/}

# Состав сборки. `soffice.data.js.metadata` — не мелочь: в нём описан образ
# файловой системы, и без него загрузчик не сможет его смонтировать.
FILES="soffice.js soffice.wasm soffice.data soffice.data.js.metadata"

# sha256sum есть в Linux, shasum — в macOS: скрипт запускается и там, и там.
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

mkdir -p "$TARGET_DIR"

echo "[lowa] Источник: ${SOURCE_URL}"
echo "[lowa] Каталог:  ${TARGET_DIR}"

for file in $FILES; do
  echo "[lowa] Скачивание ${file}"
  curl --fail --location --silent --show-error \
    --output "${TARGET_DIR}/${file}" "${SOURCE_URL}${file}"
done

# Сжатые копии крупных файлов: nginx отдаёт их через gzip_static, не тратя
# время на сжатие при каждом запросе. Для wasm и образа ФС это вчетверо
# меньший трафик, а js-файлы мелкие — им достаточно обычного gzip.
for large in soffice.wasm soffice.data; do
  if [ ! -f "${TARGET_DIR}/${large}.gz" ]; then
    echo "[lowa] Сжатие ${large}"
    gzip -9 -k -f "${TARGET_DIR}/${large}"
  fi
done

# Файл контрольных сумм — в формате `sha256sum -c`, чтобы проверка в сборке
# образа была одной командой. Строки, начинающиеся с решётки, этот формат
# допускает, поэтому шапка с происхождением сборки живёт здесь же: рядом
# с хэшами её невозможно забыть обновить.
MANIFEST="$SCRIPT_DIR/assets.sha256"

{
  echo "# Состав сборки LibreOffice для браузера (LOWA)."
  echo "# Источник: ${SOURCE_URL}"
  echo "# Получено: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Обновление: apps/web/lowa/fetch.sh, затем проверить diff и закоммитить."
  for file in $FILES; do
    printf '%s  %s\n' "$(hash_file "${TARGET_DIR}/${file}")" "$file"
  done
} > "$MANIFEST"

echo "[lowa] Записано: ${MANIFEST}"
echo "[lowa] Проверка выполняется командой: sha256sum -c ${MANIFEST##*/}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "manifest=${MANIFEST}" >> "$GITHUB_OUTPUT"
fi
