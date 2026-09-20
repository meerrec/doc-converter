# =============================================================================
# Dockerfile воркера конвертации: LibreOffice Calc + UNO + Node.
#
# Один контейнер — один soffice-процесс и один воркер с `concurrency: 1`.
# Это требование корректности, а не оптимизация: UNO не потокобезопасен,
# и вторая одновременная конвертация в том же процессе портит результат.
# Масштабирование — только репликами (autoscaler в compose, KEDA в K8s).
#
# Отличия от apps/api/Dockerfile: образ тяжелее (LibreOffice Calc, python3-uno
# и шрифты — порядка 700 МБ), но таких контейнеров ровно столько, сколько
# нужно для текущей нагрузки, и в простое их может не быть вовсе. Раскладка
# стадий та же — manifests → (prod-deps | builder) → финальный образ;
# отличается список проектов, попадающих в runtime, и копирование docker/uno.
#
# Базовый образ: node:24-bookworm-slim — версия совпадает с engines.node
# и с окружением разработки.
# =============================================================================

# -----------------------------------------------------------------------------
# Стадия манифестов
# -----------------------------------------------------------------------------
# Общая основа обеих стадий установки — см. apps/api/Dockerfile: список
# манифестов обязан совпадать у них полностью, иначе установка
# с --frozen-lockfile падает на отсутствующем в образе проекте.
FROM node:24-bookworm-slim AS manifests

# Версия pnpm берётся из поля `packageManager` в package.json: corepack
# подставляет ровно её вместо последней выпущенной, которую скачивал `npx pnpm`
RUN corepack enable

WORKDIR /app

# Манифесты workspace и настройки pnpm — до установки, отдельным слоем:
# pnpm-workspace.yaml содержит каталог версий, а `.npmrc` — правила установки,
# и они обязаны совпадать с теми, что действуют у разработчика
COPY pnpm*.yaml ./
COPY .npmrc ./
COPY package*.json ./
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
#
# `install --prod`, а не `pnpm ci --prod`: `ci` — это `clean` + `install
# --frozen-lockfile`, и проброс `--prod` в него не подтверждён, а молчаливая
# потеря флага вернула бы devDependencies в образ.
#
# Инструменты сборки нативных модулей не нужны: зависимости приходят либо
# чистым JS, либо готовыми бинарниками. В образе воркера при этом не
# оказывается ничего лишнего — конвертация идёт в soffice, а Node только
# читает файлы и стримит их в хранилище.
FROM manifests AS prod-deps

RUN pnpm install --prod --frozen-lockfile --filter @doc-converter/worker...

# -----------------------------------------------------------------------------
# Стадия сборки
# -----------------------------------------------------------------------------
FROM manifests AS builder

# Установка с devDependencies: typescript нужен сборке, в runtime он не нужен —
# отсюда вторая стадия установки
RUN pnpm ci --filter @doc-converter/worker...

COPY . .

# Сборка идёт по графу зависимостей: сначала пакеты, потом воркер
RUN pnpm --filter @doc-converter/worker... build

# Артефакты runtime: dist и манифест воркера и всех пяти пакетов — его прямых
# зависимостей. Складываются в /artifacts в раскладке репозитория, чтобы
# финальная стадия наложила их одной инструкцией COPY.
#
# `set -e` обязателен: /bin/sh (dash) не останавливается на ошибке сам,
# и цикл без него молча пропустил бы несобранный проект.
RUN set -e; \
    for project in \
        packages/config packages/contract packages/observability \
        packages/queue packages/storage apps/worker; \
    do \
        test -d "$project/dist" || { echo "нет сборки: $project/dist" >&2; exit 1; }; \
        mkdir -p "/artifacts/$project"; \
        cp -r "$project/dist" "$project/package.json" "/artifacts/$project/"; \
    done

# -----------------------------------------------------------------------------
# Финальный образ
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim

# libreoffice-calc — движок конвертации (тянет за собой libreoffice-core);
# python3-uno — биндинги UNO для системного python3. Именно системный:
# модуль uno ставится в dist-packages Debian и из venv не виден.
# python3-uno ставит и libreoffice-core, но перечислен явно — на него
# опирается скрипт конвертации, и полагаться на транзитивную зависимость
# в этом месте не стоит.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libreoffice-calc \
        python3-uno \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# Пользователь создаётся здесь заново, а не копируется из стадии сборки:
# копирование /etc/passwd из builder'а, где этого пользователя нет, затирало
# бы запись и `chown conv:conv` падал с «invalid user»
RUN groupadd -r conv && \
    useradd -r -g conv -m -d /home/conv -s /bin/false conv

RUN mkdir -p /app /tmp/lo-profile

WORKDIR /app

# Два источника — две инструкции: prod-deps отдаёт дерево зависимостей без
# devDependencies, /artifacts — собранный код, накладываемый слиянием
# каталогов. Слэш в конце источника у второго COPY несущий: без него COPY
# создал бы /app/artifacts/ вместо слияния, и контейнер упал бы на старте.
COPY --chown=conv:conv --from=prod-deps /app /app
COPY --chown=conv:conv --from=builder /artifacts/ /app/

# Python-скрипт и точка входа лежат вне проектов workspace (docker/uno/)
# и в /artifacts не попадают — копируются отдельно. Раскладка обязана
# сохраниться: путь захардкожен и в packages/config (UNO_SCRIPT_PATH),
# и в самом entrypoint (UNO_SCRIPT, WORKER_ENTRY).
COPY --chown=conv:conv --from=builder /app/docker /app/docker

# chown остаётся страховкой: права на /app принадлежат conv целиком.
# Здесь же проверяются точки входа — пропавший dist иначе обнаружился бы
# упавшим контейнером, а не упавшей сборкой.
#
# Бит исполняемости проставляется явно: он легко теряется при копировании
# файлов между системами, а ENTRYPOINT без него не стартует.
RUN set -e; \
    test -f /app/apps/worker/dist/index.js; \
    test -f /app/apps/worker/dist/healthcheck.js; \
    test -f /app/docker/uno/uno_convert.py; \
    chown -R conv:conv /app /tmp/lo-profile && \
    chmod +x /app/docker/uno/worker-entrypoint.sh

ENV NODE_ENV=production \
    UNO_HOST=127.0.0.1 \
    UNO_PORT=2002 \
    UNO_SCRIPT_PATH=/app/docker/uno/uno_convert.py \
    LOG_LEVEL=info

# Локаль задана явно: параметры конвертации (в том числе водяной знак
# на кириллице) передаются скрипту в argv, и без UTF-8-локали Python
# в контейнере может разобрать их как ASCII и упасть на первом же
# нелатинском символе
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Воркер не конвертирует в Node — файлы он стримит в хранилище, а работу
# делает soffice. 512 МБ на кучу хватает с запасом.
ENV NODE_OPTIONS=--max-old-space-size=512

USER conv

# Healthcheck подключается к UNO тем же Python-скриптом: проверка «порт
# открыт» прошла бы и на ещё не готовом бридже.
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD node /app/apps/worker/dist/healthcheck.js || exit 1

ENTRYPOINT ["/app/docker/uno/worker-entrypoint.sh"]
