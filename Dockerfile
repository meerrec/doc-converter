# =============================================================================
# Dockerfile для сервиса конвертации документов
#
# Базовый образ: node:24-bookworm-slim
# Обоснование версии: Node 24 — среда, на которой сервис разрабатывается и
# тестируется; WASM-движку LibreOffice нужен --disable-wasm-trap-handler
# (см. NODE_OPTIONS ниже), а не конкретная мажорная версия.
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

# Инструменты сборки нативных модулей здесь больше не нужны: единственный
# нативный модуль (isolated-vm) удалён, а оставшиеся зависимости приходят
# либо чистым JS, либо готовыми бинарниками (msgpackr-extract — опциональный
# ускоритель BullMQ с prebuild-сборками; при их отсутствии откатывается на JS).

# Создаем non-root пользователя
RUN groupadd -r conv && \
    useradd -r -g conv -m -d /home/conv -s /bin/false conv

# Копируем приложение.
#
# Манифесты всех участников workspace копируются до установки: pnpm читает
# pnpm-workspace.yaml и без package.json каждого пакета отказывается ставить
# зависимости. Отдельным слоем — чтобы кеш не сбрасывался на каждой правке
# исходников.
WORKDIR /app
COPY pnpm*.yaml ./
COPY package*.json ./
COPY packages/contract/package.json ./packages/contract/
COPY web/package.json ./web/

# Ставим зависимости только серверной части (включая devDependencies для
# сборки). Фильтр отсекает React и Vite из web — в образе api/worker они
# не нужны и заметно увеличивают размер.
#
# Многоточие в фильтре добавляет зависимости пакета: контракт
# (@doc-converter/contract) — участник workspace, который сервер импортирует
# в рантайме, поэтому в образе должны быть и его исходники, и его инструменты
# сборки.
RUN npx pnpm ci --filter doc-converter...

COPY . .

# Сборка: контракт — первым, сервер — вторым.
#
# `.dockerignore` исключает `dist`, поэтому в образе нет ни собранного
# контракта, ни собранного сервера: без этих шагов контейнер соберётся,
# но упадёт на старте (сервер импортирует @doc-converter/contract, а точка
# входа — dist/nest/main.js). Порядок тот же, что в web/Dockerfile.
RUN npx pnpm --filter @doc-converter/contract build
RUN npm run build:server

# ЗАМЕЧАНИЕ О РАЗМЕРЕ ОБРАЗА.
#
# В runtime-образ попадают devDependencies: typescript (~23 МБ), @swc/core
# с платформенным бинарником (~25 МБ), vitest с Vite, supertest, yazl,
# concurrently. Выглядит как то, что легко исправить, — и это уже пробовали:
#
#   RUN npx pnpm install --prod --frozen-lockfile --filter doc-converter...
#
# Шаг **не работает**. Он снимает симлинки верхнего уровня в `node_modules`,
# но сами пакеты остаются в виртуальном хранилище `node_modules/.pnpm`
# (271 МБ), откуда и берётся основной вес. Замер после такого шага: состав
# каталога меняется, размер образа — те же 994 МБ.
#
# Настоящее решение — отдельная стадия, где production-зависимости ставятся
# в пустой каталог (`pnpm ci --prod`), и финальный образ собирается из неё
# копированием `node_modules` вместе с `packages/contract/node_modules`.
# Это заметно усложняет Dockerfile и требует аккуратности с симлинками pnpm;
# выигрыш — около 100–150 МБ из 994. Пока не сделано осознанно.

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
# Каталог входных файлов очереди. Обязан быть вне STORAGE_PATH: имена
# результатов собираются из клиентского `key`, и входной документ в общем
# каталоге стал бы доступен по GET /results/{key}.{ext}. Вложенность
# проверяется в src/config/index.ts и роняет старт приложения.
ENV INPUT_STORAGE_PATH=/data/incoming
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
    CMD node /app/dist/nest/health/health-check.js || exit 1

# Команда запуска
# В production запускаем API и worker через node (concurrently не нужен в Docker)
CMD ["node", "/app/dist/nest/main.js"]
