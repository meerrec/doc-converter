# =============================================================================
# Образ веб-интерфейса: сборка Vite + раздача nginx
#
# Собирается отдельно от основного образа сервиса: итоговый контейнер
# не содержит Node.js и исходного кода — только статику и nginx.
#
# Сборка: docker build -f web/Dockerfile .
# (контекст — корень репозитория, чтобы COPY web/... работал)
# =============================================================================

# --- Стадия 1: сборка статики ------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /web

# Зависимости ставятся отдельным слоем: при изменении исходников
# этот слой берётся из кеша
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# --- Стадия 2: раздача -------------------------------------------------------
FROM nginx:1.27-alpine

# Конфигурация с проксированием API и SPA-fallback
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

# Собранная статика
COPY --from=builder /web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
