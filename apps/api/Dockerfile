# =============================================================================
# Dockerfile API-сервиса (приём задач, выдача статусов и ссылок).
#
# LibreOffice здесь НЕ устанавливается: конвертация идёт в отдельных
# контейнерах-воркерах (apps/worker/Dockerfile), а API только принимает файл,
# кладёт его в объектное хранилище и ставит задачу в очередь. Так api
# остаётся лёгким (десятки мегабайт памяти вместо сотен) и масштабируется
# независимо от воркеров.
#
# Базовый образ: node:24-bookworm-slim — версия совпадает с engines.node
# и с окружением разработки.
# =============================================================================

# -----------------------------------------------------------------------------
# Стадия сборки
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

# Инструменты сборки нативных модулей не нужны: все зависимости приходят
# либо чистым JS, либо готовыми бинарниками (msgpackr-extract — опциональный
# ускоритель BullMQ с prebuild-сборками, при их отсутствии откатывается на JS).

RUN groupadd -r conv && \
    useradd -r -g conv -m -d /home/conv -s /bin/false conv

# Версия pnpm берётся из поля `packageManager` в package.json: corepack
# подставляет ровно её. Раньше здесь стоял `npx pnpm`, который скачивает
# последнюю выпущенную версию — сборка зависела от даты сборки, а не от
# репозитория. Слой кешируется: corepack только создаёт шимы, загрузка
# происходит при первом вызове pnpm.
RUN corepack enable

# Манифесты всех участников workspace копируются до установки: pnpm читает
# pnpm-workspace.yaml (в нём же каталог версий) и без package.json каждого
# пакета отказывается ставить зависимости. Отдельным слоем — чтобы кеш
# не сбрасывался на каждой правке исходников.
#
# `.npmrc` копируется тем же слоем: настройки проекта обязаны действовать
# и в сборке образа, иначе установка здесь идёт по другим правилам, чем
# у разработчика, и расхождение обнаружится только на этапе runtime.
WORKDIR /app
COPY pnpm*.yaml ./
COPY .npmrc ./
COPY package*.json ./
# Манифесты всех участников workspace: pnpm сверяет состав проектов
# с замком, и отсутствие любого манифеста ломает установку
# с --frozen-lockfile, даже если этот пакет в образ не войдёт
COPY packages/contract/package.json ./packages/contract/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
COPY packages/queue/package.json ./packages/queue/
COPY packages/storage/package.json ./packages/storage/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/autoscaler/package.json ./apps/autoscaler/
COPY apps/web/package.json ./apps/web/

# Многоточие добавляет зависимости пакета: api импортирует пакеты workspace,
# и без них он не соберётся. Веб и воркер в образ не попадают.
RUN pnpm ci --filter @doc-converter/api...

COPY . .

# `.dockerignore` исключает `dist`, поэтому сборка обязательна: без неё
# контейнер соберётся, но упадёт на старте — точки входа нет.
# Сборка идёт по графу зависимостей: сначала пакеты, потом api.
RUN pnpm --filter @doc-converter/api... build

# ЗАМЕЧАНИЕ О РАЗМЕРЕ ОБРАЗА.
#
# В runtime-образ попадают devDependencies (typescript, @swc/core, vitest,
# supertest). Попытка `pnpm install --prod --frozen-lockfile` образ
# не уменьшает: шаг снимает симлинки верхнего уровня, но пакеты остаются
# в виртуальном хранилище node_modules/.pnpm. Настоящее решение — отдельная
# стадия с установкой production-зависимостей в пустой каталог; выигрыш
# около 100–150 МБ, и он не стоит усложнения, пока образ не стал проблемой.

# -----------------------------------------------------------------------------
# Финальный образ
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim

COPY --from=builder /etc/group /etc/group
COPY --from=builder /etc/passwd /etc/passwd

RUN mkdir -p /app /var/log/converter /tmp

WORKDIR /app

COPY --chown=conv:conv --from=builder /app /app

RUN chown -R conv:conv /app /var/log/converter /tmp && \
    chmod -R 750 /var/log/converter /tmp

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    AUDIT_LOG_PATH=/var/log/converter/audit.log \
    LOG_LEVEL=info

# Потолок кучи V8. API не конвертирует, но принимает файлы до 100 МБ
# и передаёт их в хранилище — 1 ГБ покрывает буфер и запас на фрагментацию.
ENV NODE_OPTIONS=--max-old-space-size=1024

USER conv

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node /app/apps/api/dist/health/health-check.js || exit 1

CMD ["node", "/app/apps/api/dist/main.js"]
