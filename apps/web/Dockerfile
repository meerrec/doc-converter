# =============================================================================
# Образ веб-интерфейса: сборка Vite + раздача nginx
#
# Собирается отдельно от основного образа сервиса: итоговый контейнер
# не содержит Node.js и исходного кода — только статику и nginx.
#
# Сборка: docker build -f apps/web/Dockerfile .
# (контекст — корень репозитория)
#
# Веб входит в pnpm-workspace и зависит от @doc-converter/contract, поэтому
# собирается из корня: контракт нужно собрать до интерфейса, иначе Vite
# не найдёт его типы и код.
# =============================================================================

# --- Стадия 1: сборка статики ------------------------------------------------
# Базовый образ — UBI 9 с registry.access.redhat.com: Docker Hub в целевых
# окружениях недоступен. Берётся s2i-образ Node 24 (в нём есть npm, которым
# ставится pnpm); версия Node совпадает с engines.node и с окружением
# разработки. Сервер статики в финальной стадии — ubi9/nginx-126.
FROM registry.access.redhat.com/ubi9/nodejs-24:1 AS builder

# Образ стартует от UID 1001, а сборка пишет в /app, созданный демоном
# от root: без возврата к root установка не сможет туда писать.
USER root

WORKDIR /app

# Манифесты участников workspace — отдельным слоем, чтобы кеш установки
# не сбрасывался на каждой правке исходников. `.npmrc` идёт тем же слоем:
# правила установки обязаны совпадать с теми, что действуют у разработчика
COPY pnpm*.yaml ./
COPY .npmrc ./
COPY package*.json ./

# Версия pnpm берётся из поля `packageManager` в package.json — как раньше
# делал corepack, которого в UBI-образе Node нет вовсе (проверено по составу
# пакета nodejs: corepack поставляется только в nodejs-docs). Второй источник
# версии заводить нельзя: с `npx pnpm` сборка зависела от даты сборки, а не
# от репозитория. Ставится в /usr/local, а не в префикс из переменных образа:
# тот указывает в домашний каталог, а он в финальной стадии другой.
#
# Сверка версии обязательна: pnpm сравнивает себя с полем packageManager
# и при расхождении пытается скачать собственный бинарник вместо работы.
RUN PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1]')" && \
    npm install -g --prefix /usr/local "pnpm@${PNPM_VERSION}" && \
    test "$(pnpm --version)" = "${PNPM_VERSION}"

# Конфигурации TypeScript: контракт наследует корневой `tsconfig.json`,
# а тот — `tsconfig.base.json`. Копирование здесь выборочное, `COPY . .`
# в этом файле нет, поэтому обе нужны явно.
COPY tsconfig.base.json ./
COPY tsconfig.json ./

# Манифесты всех участников workspace: pnpm сверяет состав проектов с замком,
# и отсутствие любого манифеста ломает установку с --frozen-lockfile
COPY packages/contract/package.json ./packages/contract/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
COPY packages/queue/package.json ./packages/queue/
COPY packages/storage/package.json ./packages/storage/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/autoscaler/package.json ./apps/autoscaler/
COPY apps/web/package.json ./apps/web/

# Ставим зависимости веба и контракта (с тремя точками — вместе с зависимостями)
RUN pnpm ci --filter @doc-converter/web...

# Исходники контракта и веба
COPY packages/contract ./packages/contract
COPY apps/web ./apps/web

# Сборка по графу зависимостей: контракт собирается первым, потому что
# web импортирует его собранный dist
RUN pnpm --filter @doc-converter/web... build

# --- Стадия 2: раздача -------------------------------------------------------
FROM registry.access.redhat.com/ubi9/nginx-126:1

# Конфигурация сайта копируется не в /etc/nginx/conf.d, а в каталог сниппетов
# default-server: штатный nginx.conf образа подключает его внутри своего
# server-блока, а тот уже слушает 8080 и настроен на запуск от 1001.
# См. apps/web/nginx.conf — это сниппет, а не самостоятельный конфиг.
COPY apps/web/nginx.conf /opt/app-root/etc/nginx.default.d/converter.conf

# Собранная статика. Каталог — тот же, что в root штатного конфига образа
# (в Debian-варианте был /usr/share/nginx/html).
COPY --chown=1001:0 --from=builder /app/apps/web/dist /opt/app-root/src

# nginx слушает 8080 (штатный конфиг образа), а не 80: compose публикует
# "8080:8080". Порт в EXPOSE и в healthcheck обязан совпадать с ним,
# иначе контейнер навсегда остаётся unhealthy с «Connection refused»
EXPOSE 8080

# Проверка идёт по HTTP-коду (`--fail`), а не «порт открыт»: подключение
# к сокету проходит и тогда, когда nginx отвечает 500. curl в образе уже есть
# (wget, которым проверял Debian-вариант, — нет), поэтому ни один пакет
# ради healthcheck'а не добавляется.
#
# Адрес задан явно (127.0.0.1, а не localhost): localhost резолвится ещё и в
# IPv6 ::1, а nginx слушает только IPv4 — проверка получала «Connection refused»
# и контейнер навсегда оставался unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/ >/dev/null || exit 1

# Команда задана явно: у самого образа в CMD стоит /usr/libexec/s2i/run только
# в сборках, сделанных через s2i, а в базовом образе — /usr/libexec/s2i/usage,
# который просто печатает подсказку и завершается. run нужен именно этот:
# он готовит запись пользователя (образ рассчитан на произвольный UID)
# и запускает nginx от имени 1001.
CMD ["/usr/libexec/s2i/run"]
