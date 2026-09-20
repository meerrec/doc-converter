# =============================================================================
# Dockerfile API-сервиса (приём задач, выдача статусов и ссылок).
#
# LibreOffice здесь НЕ устанавливается: конвертация идёт в отдельных
# контейнерах-воркерах (apps/worker/Dockerfile), а API только принимает файл,
# кладёт его в объектное хранилище и ставит задачу в очередь. Так api
# остаётся лёгким (десятки мегабайт памяти вместо сотен) и масштабируется
# независимо от воркеров.
#
# Из этого же образа запускается autoscaler: своего Dockerfile у сервиса
# в compose нет, его команда — node /app/apps/autoscaler/dist/index.js.
# Зависимостью api автоскейлер не является, поэтому он назван отдельным
# фильтром в обеих установках и отдельной строкой в списке артефактов.
# Забытый фильтр сборку не ломает — он роняет контейнер автоскейлера, а тот
# перезапускается молча: у сервиса отключён healthcheck.
#
# Стадии: manifests → (prod-deps | builder) → финальный образ. Runtime
# собирается из двух источников: дерево зависимостей берётся из prod-deps,
# где нет devDependencies, код — из builder'а, где нет ничего, кроме dist
# и манифестов.
#
# Базовый образ: node:24-bookworm-slim — версия совпадает с engines.node
# и с окружением разработки.
# =============================================================================

# -----------------------------------------------------------------------------
# Стадия манифестов
# -----------------------------------------------------------------------------
# Общая основа обеих стадий установки. Список манифестов обязан совпадать
# у них полностью: pnpm сверяет состав проектов с замком, и отсутствие любого
# манифеста ломает установку с --frozen-lockfile, даже если этот пакет
# в образ не войдёт (apps/web/package.json здесь именно поэтому). Держать
# этот список в двух стадиях порознь — значит однажды поправить только одну.
FROM node:24-bookworm-slim AS manifests

# Версия pnpm берётся из поля `packageManager` в package.json: corepack
# подставляет ровно её. Раньше здесь стоял `npx pnpm`, который скачивает
# последнюю выпущенную версию — сборка зависела от даты сборки, а не от
# репозитория. Слой кешируется: corepack только создаёт шимы, загрузка
# происходит при первом вызове pnpm.
RUN corepack enable

# `.npmrc` копируется тем же слоем, что и манифесты: настройки проекта обязаны
# действовать и в сборке образа, иначе установка здесь идёт по другим правилам,
# чем у разработчика, и расхождение обнаружится только на этапе runtime.
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

# -----------------------------------------------------------------------------
# Стадия production-зависимостей
# -----------------------------------------------------------------------------
# Наследуется от манифестов, а не от builder'а, и это несущая деталь: установка
# идёт в пустой каталог. `pnpm install --prod` поверх уже установленного дерева
# образ не уменьшает — шаг снимает симлинки верхнего уровня, а сами пакеты
# остаются в виртуальном хранилище node_modules/.pnpm, откуда и берётся вес.
# Ровно поэтому здесь отдельная стадия, а не шаг в сборке: выглядит одинаково,
# а результат разный, и заметен он только по размеру образа.
#
# `install --prod`, а не `pnpm ci --prod`: `ci` — это `clean` + `install
# --frozen-lockfile`, и проброс `--prod` в него не подтверждён, а молчаливая
# потеря флага вернула бы devDependencies в образ. `--frozen-lockfile` здесь
# так же обязателен, как в сборке: версии не должны разрешаться заново.
#
# Инструменты сборки нативных модулей не нужны: все зависимости приходят либо
# чистым JS, либо готовыми бинарниками (msgpackr-extract — опциональный
# ускоритель BullMQ с prebuild-сборками, при их отсутствии он откатывается
# на JS). Опциональные зависимости поэтому не отключаются.
#
# Многоточие добавляет зависимости пакета. Автоскейлер входит в образ, но
# зависимостью api не является — он назван вторым фильтром, иначе у него
# не окажется ни node_modules, ни собранного dist.
FROM manifests AS prod-deps

RUN pnpm install --prod --frozen-lockfile \
      --filter @doc-converter/api... \
      --filter @doc-converter/autoscaler...

# -----------------------------------------------------------------------------
# Стадия сборки
# -----------------------------------------------------------------------------
FROM manifests AS builder

RUN groupadd -r conv && \
    useradd -r -g conv -m -d /home/conv -s /bin/false conv

# Установка с devDependencies: они нужны сборке (typescript в каждом пакете,
# @types/node — для типов node:*), но не нужны в runtime — отсюда две стадии
# установки вместо одной. Фильтр отсекает веб: React и Vite здесь не нужны.
RUN pnpm ci --filter @doc-converter/api... --filter @doc-converter/autoscaler...

COPY . .

# `.dockerignore` исключает `dist`, поэтому сборка обязательна: без неё
# контейнер соберётся, но упадёт на старте — точки входа нет.
# Сборка идёт по графу зависимостей: сначала пакеты, потом api и автоскейлер.
RUN pnpm --filter @doc-converter/api... --filter @doc-converter/autoscaler... build

# Артефакты runtime складываются в /artifacts в раскладке репозитория, чтобы
# финальная стадия наложила их одной инструкцией COPY вместо семи пар
# «dist + манифест». Копируются только `dist` и манифест: исходников
# в runtime не нужно, а `dist` — то, куда указывают main/exports пакетов,
# HEALTHCHECK и команда автоскейлера.
#
# `set -e` обязателен: /bin/sh (dash) не останавливается на ошибке сам, и цикл
# без него молча пропустил бы несобранный проект — образ собрался бы и упал
# на старте.
RUN set -e; \
    for project in \
        packages/config packages/contract packages/observability \
        packages/queue packages/storage apps/api apps/autoscaler; \
    do \
        test -d "$project/dist" || { echo "нет сборки: $project/dist" >&2; exit 1; }; \
        mkdir -p "/artifacts/$project"; \
        cp -r "$project/dist" "$project/package.json" "/artifacts/$project/"; \
    done

# -----------------------------------------------------------------------------
# Финальный образ
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim

COPY --from=builder /etc/group /etc/group
COPY --from=builder /etc/passwd /etc/passwd

RUN mkdir -p /app /var/log/converter /tmp

WORKDIR /app

# Два источника — две инструкции: prod-deps отдаёт дерево зависимостей без
# devDependencies, /artifacts — собранный код, накладываемый слиянием
# каталогов. Слэш в конце источника у второго COPY несущий: без него COPY
# создал бы /app/artifacts/ вместо слияния, и контейнер упал бы на старте.
#
# `--chown` на обеих: иначе файлы пришли бы root-овыми и chown ниже
# переписывал бы их отдельным слоем.
COPY --chown=conv:conv --from=prod-deps /app /app
COPY --chown=conv:conv --from=builder /artifacts/ /app/

# chown остаётся страховкой: права на /app принадлежат conv целиком, и это
# единственное место, где инвариант фиксируется сразу для всего дерева.
# Здесь же проверяются точки входа: пропавший dist иначе обнаружился бы
# упавшим контейнером, а не упавшей сборкой. Корневой package.json проверяется
# отдельно — version.ts читает его и при отсутствии молча отдаёт версию 0.0.0,
# то есть отказ не виден ни в логах, ни в ответе healthcheck'а.
RUN set -e; \
    test -f /app/apps/api/dist/main.js; \
    test -f /app/apps/api/dist/health/health-check.js; \
    test -f /app/apps/autoscaler/dist/index.js; \
    test -f /app/package.json; \
    chown -R conv:conv /app /var/log/converter /tmp && \
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
