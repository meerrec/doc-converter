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
FROM node:24-bookworm-slim AS builder

# Версия pnpm берётся из поля `packageManager` в package.json: corepack
# подставляет ровно её вместо последней выпущенной, которую скачивал `npx pnpm`
RUN corepack enable

WORKDIR /app

# Манифесты участников workspace — отдельным слоем, чтобы кеш установки
# не сбрасывался на каждой правке исходников. `.npmrc` идёт тем же слоем:
# правила установки обязаны совпадать с теми, что действуют у разработчика
COPY pnpm*.yaml ./
COPY .npmrc ./
COPY package*.json ./
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
FROM nginx:1.27-alpine

# Конфигурация с проксированием API и SPA-fallback
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Собранная статика
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# nginx слушает 8080 (apps/web/nginx.conf), а не 80: compose публикует
# "8080:8080". Порт в EXPOSE и в healthcheck обязан совпадать с ним,
# иначе контейнер навсегда остаётся unhealthy с «Connection refused»
EXPOSE 8080

# Адрес задан явно (127.0.0.1, а не localhost): localhost резолвится ещё и в
# IPv6 ::1, а nginx слушает только IPv4 — wget получал «Connection refused»
# и контейнер навсегда оставался unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
