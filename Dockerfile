# =============================================================================
# Dockerfile для сервиса конвертации документов
#
# Базовый образ: node:24-bookworm-slim
# Обоснование версии: isolated-vm начиная с 6.x требует Node >= 22, а 7.x — >= 24.
# На Node 20 модуль собирается, но падает с SIGSEGV при создании изолята
# (несовместимость с внутренним API V8).
# - Формат: ES modules ("type": "module")
# - Non-root пользователь: conv
# - Hardening: read_only, cap_drop ALL, no-new-privileges
# - Шрифты для LibreOffice WASM
# - БЕЗ нативного LibreOffice (только WASM)
# =============================================================================

# Стадия сборки
FROM node:24-bookworm-slim AS builder

# Устанавливаем шрифты для LibreOffice WASM
# Эти шрифты используются при конвертации документов
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-core \
        fonts-noto-mono \
    && rm -rf /var/lib/apt/lists/*

# Инструменты сборки нативных модулей.
# Обоснование: isolated-vm — нативный модуль, у него нет prebuilt-бинарника
# под Node 20, поэтому prebuild-install откатывается на `node-gyp rebuild`,
# которому нужны python3, make и компилятор C++. Без них сборка образа
# падает на шаге установки зависимостей.
# В финальный образ эти пакеты не переносятся — там уже собранный модуль.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Создаем non-root пользователя
RUN groupadd -r conv && \
    useradd -r -g conv -m -d /home/conv -s /bin/false conv

# Копируем приложение
WORKDIR /app
COPY pnpm*.yaml ./
COPY package*.json ./

# Устанавливаем зависимости (включая devDependencies для сборки)
RUN npx pnpm ci

COPY . .

# =============================================================================
# Финальный образ
# =============================================================================
FROM node:24-bookworm-slim

# Копируем шрифты из стадии сборки
COPY --from=builder /usr/share/fonts /usr/share/fonts

# Копируем пользователя и группы
COPY --from=builder /etc/group /etc/group
COPY --from=builder /etc/passwd /etc/passwd

# Создаем директории
RUN mkdir -p /app /data/storage /var/log/converter /tmp

# Устанавливаем шрифты (на всякий случай)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# Копируем приложение от non-root пользователя
WORKDIR /app
COPY --chown=conv:conv --from=builder /app /app

# Создаем сиmlink для шрифтов в стандартных местах
# LibreOffice WASM ищет шрифты в /usr/share/fonts
RUN mkdir -p /usr/share/fonts/truetype && \
    ln -sf /usr/share/fonts/truetype/dejavu /usr/share/fonts/truetype/dejavu 2>/dev/null || true

# Устанавливаем права на директории
RUN chown -R conv:conv /app /data /var/log/converter /tmp && \
    chmod -R 750 /data /var/log/converter /tmp

# Настраиваем окружение
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV STORAGE_PATH=/data/storage
ENV AUDIT_LOG_PATH=/var/log/converter/audit.log
ENV LOG_LEVEL=info

# Node.js опции для production
# --disable-wasm-trap-handler: отключает 10GB виртуального резерва, делает процесс
#   совместимым с mem_limit: 3g в Docker
# --max-old-space-size=1536: лимит heap V8 в МБ
# --unhandled-rejections=strict: fail-fast на неперехваченных rejection
ENV NODE_OPTIONS=--disable-wasm-trap-handler --max-old-space-size=1536 --unhandled-rejections=strict

# Переключаемся на non-root пользователя
USER conv

# Порты
EXPOSE 3000

# Здоровье
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node /app/src/api/health-check.js || exit 1

# Команда запуска
# В production запускаем API и worker через node (concurrently не нужен в Docker)
CMD ["node", "/app/src/api/server.js"]
