# =============================================================================
# Dockerfile воркера конвертации: LibreOffice (Calc и Writer) + UNO + Node.
#
# Один контейнер — один soffice-процесс и один воркер с `concurrency: 1`.
# Это требование корректности, а не оптимизация: UNO не потокобезопасен,
# и вторая одновременная конвертация в том же процессе портит результат.
# Масштабирование — только репликами (autoscaler в compose, KEDA в K8s).
#
# soffice мультимодульный: один и тот же процесс конвертирует и книги,
# и текстовые документы — различается только фильтр экспорта. Поэтому
# реплики не делятся по форматам, а модули ставятся оба.
#
# Отличия от apps/api/Dockerfile: образ тяжелее (LibreOffice, python3-uno
# и шрифты — порядка 1,3 ГБ), но таких контейнеров ровно столько, сколько
# нужно для текущей нагрузки, и в простое их может не быть вовсе. Раскладка
# стадий та же — manifests → (prod-deps | builder) → финальный образ;
# отличается список проектов, попадающих в runtime, и копирование docker/uno.
#
# Базовые образы — UBI 9: стадии сборки берут s2i-образ Node 24 (в нём есть
# npm, которым ставится pnpm), финальная — minimal-вариант того же Node 24,
# как в apps/api/Dockerfile. Готовый ubi9/nodejs-24 в runtime не годится: он
# притащил бы gcc, make и git в контейнер, который обрабатывает недоверенные
# документы. Node приходит из базового образа, поэтому его версия совпадает
# с engines.node и со стадиями сборки по построению, а не по совпадению
# номеров модуля; назначать её в этом файле больше нечем.
#
# Пакетный менеджер minimal-образа — microdnf: dnf в нём нет вовсе.
#
# Вместе с Node базовый образ приносит npm и nodemon: в runtime они
# не вызываются, но компиляторами не являются — выбор minimal вместо полного
# s2i-образа обоснован отсутствием gcc, make и git, и оно проверяется в CI.
#
# LibreOffice в репозиториях UBI отсутствует — ни в baseos, ни в appstream,
# ни в CRB (проверено по метаданным), поэтому подключается AppStream
# AlmaLinux 9: тот же EL9 ABI, что и у UBI9.
# =============================================================================

# -----------------------------------------------------------------------------
# Стадия манифестов
# -----------------------------------------------------------------------------
# Общая основа обеих стадий установки — см. apps/api/Dockerfile: список
# манифестов обязан совпадать у них полностью, иначе установка
# с --frozen-lockfile падает на отсутствующем в образе проекте.
FROM registry.access.redhat.com/ubi9/nodejs-24:1 AS manifests

# Образы sclorg стартуют от UID 1001, а сборка пишет в /app, созданный
# демоном от root: без возврата к root `pnpm ci` не сможет туда писать.
# Понижение до 1001 — в финальной стадии.
USER root

WORKDIR /app

# Манифесты workspace и настройки pnpm — до установки, отдельным слоем:
# pnpm-workspace.yaml содержит каталог версий, а `.npmrc` — правила установки,
# и они обязаны совпадать с теми, что действуют у разработчика
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
FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:1

# Установка идёт от root (microdnf, каталоги, права): базовый образ sclorg
# стартует от непривилегированного 1001, а писать в /app, созданный демоном
# от root, ему нельзя. Runtime-пользователь — тот же встроенный 1001; своего
# не создаём: отдельная учётная запись дублировала бы его, а 1001 — соглашение
# UBI, на которое рассчитаны и compose, и K8s-политики.
USER root

# Репозиторий и ключ AlmaLinux — источник LibreOffice: в UBI его нет вовсе,
# а AlmaLinux 9 собран из того же RHEL 9, поэтому ABI и версия python3.9
# совпадают с базой. Ключ импортируется из файла в образе: rpm умеет тянуть
# его и по URL, но тогда проверка подписи зависела бы от того же хоста, что
# и сами пакеты.
COPY docker/almalinux/RPM-GPG-KEY-AlmaLinux-9 /etc/pki/rpm-gpg/
COPY docker/almalinux/almalinux-9-appstream.repo /etc/yum.repos.d/
RUN rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-AlmaLinux-9

# libreoffice-calc и libreoffice-writer — движки конвертации для двух входных
# форматов (оба тянут за собой libreoffice-core). Без writer документ Word
# не открылся бы вовсе, а без calc — книга.
# libreoffice-pyuno — биндинги UNO. Именно системный python3: модуль uno
# ставится в /usr/lib64/python3.9/site-packages и из venv не виден, а в базовом
# minimal-образе python3 нет вовсе — он приходит только как зависимость.
# libreoffice-core тянет pyuno сам, но перечислен явно — на него опирается
# скрипт конвертации, и полагаться на транзитивную зависимость здесь не стоит.
#
# install_weak_deps=0 (в microdnf --setopt принимает 0/1, а не False): без него
# LibreOffice притащит language packs и дополнительные фильтры — конвертации
# они не нужны, а образ от них растёт.
# JRE этим флагом не отсекается: java-headless — жёсткая зависимость
# libreoffice-core в EL9, и в образе оказывается java-17-openjdk-headless
# (в Debian-варианте JRE не было). LibreOffice использует Java для Base,
# XSLT-фильтров и части мастеров — для конвертации XLSX и DOCX она не нужна,
# но и не мешает; удалять её с --nodeps значило бы ломать пакетную базу.
# Список репозиториев задан явно, и в minimal это не подстраховка:
# codeready-builder там включён (enabled=1), поэтому без --disablerepo пакет
# мог бы приехать оттуда незаметно. Разделять список запятыми, как в dnf,
# здесь нельзя: microdnf не разбирает его и читает всю строку как один
# идентификатор репозитория — отсюда отдельный --enablerepo на каждый.
#
# Шрифты: DejaVu, Liberation, OpenSymbol и Carlito приходят жёсткими
# зависимостями libreoffice-core (проверено по метаданным AlmaLinux), а Noto —
# нет и назван явно. Соответствие прежнему Debian-набору:
# fonts-noto-core → sans + serif, fonts-noto-cjk → sans-cjk-ttc.
# nodejs в списке нет: он уже в базовом образе — том же модуле nodejs:24, что
# и стадии сборки. Включать модуль и доустанавливать пакет здесь нечего,
# а разойтись с engines.node версия Node теперь не может.
RUN microdnf install -y \
      --setopt=install_weak_deps=0 \
      --setopt=tsflags=nodocs \
      --disablerepo='*' \
      --enablerepo=ubi-9-baseos-rpms \
      --enablerepo=ubi-9-appstream-rpms \
      --enablerepo=almalinux-9-appstream \
        python3 \
        libreoffice-calc \
        libreoffice-writer \
        libreoffice-pyuno \
        google-noto-sans-fonts \
        google-noto-serif-fonts \
        google-noto-sans-cjk-ttc-fonts \
 && microdnf clean all && rm -rf /var/cache/dnf /var/log/dnf* /var/log/microdnf*

RUN mkdir -p /app /tmp/lo-profile

WORKDIR /app

# Два источника — две инструкции: prod-deps отдаёт дерево зависимостей без
# devDependencies, /artifacts — собранный код, накладываемый слиянием
# каталогов. Слэш в конце источника у второго COPY несущий: без него COPY
# создал бы /app/artifacts/ вместо слияния, и контейнер упал бы на старте.
COPY --chown=1001:0 --from=prod-deps /app /app
COPY --chown=1001:0 --from=builder /artifacts/ /app/

# Python-скрипт и точка входа лежат вне проектов workspace (docker/uno/)
# и в /artifacts не попадают — копируются отдельно. Раскладка обязана
# сохраниться: путь захардкожен и в packages/config (UNO_SCRIPT_PATH),
# и в самом entrypoint (UNO_SCRIPT, WORKER_ENTRY).
COPY --chown=1001:0 --from=builder /app/docker /app/docker

# chown остаётся страховкой: права на /app принадлежат runtime-пользователю
# целиком, и это единственное место, где инвариант фиксируется сразу для всего
# дерева. Здесь же проверяются точки входа — пропавший dist иначе обнаружился бы
# упавшим контейнером, а не упавшей сборкой.
#
# Бит исполняемости проставляется явно: он легко теряется при копировании
# файлов между системами, а ENTRYPOINT без него не стартует.
RUN set -e; \
    test -f /app/apps/worker/dist/index.js; \
    test -f /app/apps/worker/dist/healthcheck.js; \
    test -f /app/docker/uno/uno_convert.py; \
    chown -R 1001:0 /app /tmp/lo-profile && \
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

# Непривилегированный пользователь: в UBI он уже есть (1001), и он же владеет
# /app после chown выше. Домашний каталог воркеру задаёт compose (HOME=/tmp):
# fontconfig пишет кэш шрифтов в ~/.cache, а корневая ФС только для чтения.
USER 1001

# Healthcheck подключается к UNO тем же Python-скриптом: проверка «порт
# открыт» прошла бы и на ещё не готовом бридже.
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD node /app/apps/worker/dist/healthcheck.js || exit 1

ENTRYPOINT ["/app/docker/uno/worker-entrypoint.sh"]
