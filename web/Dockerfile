# =============================================================================
# Образ веб-интерфейса: сборка Vite + раздача nginx
#
# Собирается отдельно от основного образа сервиса: итоговый контейнер
# не содержит Node.js и исходного кода — только статику и nginx.
#
# Сборка: docker build -f web/Dockerfile .
# (контекст — корень репозитория)
#
# Веб входит в pnpm-workspace и зависит от @doc-converter/contract, поэтому
# собирается из корня: контракт нужно собрать до интерфейса, иначе Vite
# не найдёт его типы и код.
# =============================================================================

# --- Стадия 1: сборка статики ------------------------------------------------
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Манифесты участников workspace — отдельным слоем, чтобы кеш установки
# не сбрасывался на каждой правке исходников
COPY pnpm*.yaml ./
COPY package*.json ./
COPY packages/contract/package.json ./packages/contract/
COPY web/package.json ./web/

# Ставим зависимости веба и контракта (с тремя точками — вместе с зависимостями)
RUN npx pnpm ci --filter doc-converter-web...

# Исходники контракта и веба
COPY packages/contract ./packages/contract
COPY web ./web

# Контракт собирается первым: web импортирует его собранный dist
RUN npx pnpm --filter @doc-converter/contract build
RUN npx pnpm --filter doc-converter-web build

# --- Стадия 2: раздача -------------------------------------------------------
FROM nginx:1.27-alpine

# Конфигурация с проксированием API и SPA-fallback
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

# Собранная статика
COPY --from=builder /app/web/dist /usr/share/nginx/html

# nginx слушает 8080 (web/nginx.conf), а не 80: compose публикует
# "8080:8080". Порт в EXPOSE и в healthcheck обязан совпадать с ним,
# иначе контейнер навсегда остаётся unhealthy с «Connection refused»
EXPOSE 8080

# Адрес задан явно (127.0.0.1, а не localhost): localhost резолвится ещё и в
# IPv6 ::1, а nginx слушает только IPv4 — wget получал «Connection refused»
# и контейнер навсегда оставался unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
