#!/usr/bin/env python3
"""Конвертация документа OOXML в PDF через UNO API LibreOffice.

Скрипт подключается к уже запущенному soffice по UNO-сокету, открывает
документ, при необходимости настраивает страничный стиль и экспортирует PDF
с нужными параметрами. Запускается по одному процессу на задачу: сам
LibreOffice поднимает entrypoint контейнера и живёт всё время работы воркера.

Книгу Excel и текстовый документ Word конвертирует один и тот же soffice,
но разными фильтрами экспорта: какой из них взять, скрипт узнаёт из
`--format`. Формат приходит уже проверенным — API определил его по
содержимому контейнера, — поэтому угадывать его здесь по расширению
не нужно.

Почему UNO, а не `soffice --convert-to`: CLI-обёртка не даёт ни доступа
к страничному стилю (подгонка таблицы под одну страницу), ни полного
набора FilterData, а каждый её вызов поднимает новый процесс LibreOffice
вместо использования уже прогретого.

Вывод: одна строка JSON в stdout — результат разбирает вызывающая сторона.
Диагностика идёт в stderr, чтобы не ломать разбор.

Все комментарии на русском языке.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback

try:
    import uno
    from com.sun.star.beans import PropertyValue
except ImportError as exc:  # pragma: no cover - окружение без python3-uno
    print(json.dumps({"ok": False, "error": f"Модуль uno недоступен: {exc}"}), file=sys.stdout)
    sys.exit(2)


# ===========================================================================
# Подключение к бриджу
# ===========================================================================

def connect(timeout_sec: float, host: str, port: int):
    """Подключается к UNO-бриджу LibreOffice, дожидаясь его готовности.

    Ожидание с повторами нужно потому, что воркер стартует одновременно
    с soffice: сокет может быть уже открыт, но сервис-менеджер ещё
    не зарегистрирован, и первый же resolve падает.

    :param timeout_sec: сколько секунд ждать подключения
    :param host: адрес бриджа
    :param port: порт бриджа
    :returns: контекст компонентов LibreOffice
    """
    local_context = uno.getComponentContext()
    resolver = local_context.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_context
    )
    url = f"uno:socket,host={host},port={port};urp;StarOffice.ComponentContext"

    deadline = time.monotonic() + timeout_sec
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            return resolver.resolve(url)
        except Exception as exc:  # noqa: BLE001 - важен любой сбой подключения
            last_error = exc
            time.sleep(0.5)

    raise RuntimeError(f"Не удалось подключиться к UNO ({host}:{port}): {last_error}")


def prop(name: str, value) -> PropertyValue:
    """Создаёт PropertyValue — так UNO передаёт именованные параметры."""
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


# Фильтры экспорта PDF по формату исходного файла. Набор FilterData у обоих
# общий, различается только фильтр: таблицы экспортирует Calc, текстовые
# документы — Writer.
EXPORT_FILTERS = {
    "xlsx": "calc_pdf_Export",
    "docx": "writer_pdf_Export",
}


def macro_execution_mode() -> int | None:
    """Возвращает значение «макросы не исполнять» для MediaDescriptor.

    Значение берётся у самого LibreOffice, а не задаётся числом: константа
    принадлежит API, и зашитая единица в другой версии могла бы означать
    другое (`NEVER_EXECUTE` — это 0, а не 1). Способы достать её различаются
    между сборками python3-uno, поэтому пробуются оба.

    Если константа недоступна, свойство не передаётся — при загрузке
    в headless-режиме макросы и так не исполняются, — но факт остаётся
    в stderr, чтобы это не прошло незамеченным.

    :returns: значение для свойства MacroExecutionMode или None
    """
    try:
        return uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")
    except Exception:  # noqa: BLE001 - способ может отсутствовать в этой сборке
        pass

    try:
        # Биндинги генерируются из IDL, и в части сборок константа доступна
        # только так — импортом сгенерированного модуля
        from com.sun.star.document.MacroExecMode import NEVER_EXECUTE  # noqa: PLC0415

        return NEVER_EXECUTE
    except Exception as exc:  # noqa: BLE001 - старые сборки могут не иметь и его
        print(f"[uno] MacroExecutionMode недоступен: {exc}", file=sys.stderr)
        return None


# ===========================================================================
# Настройка документа
# ===========================================================================

def apply_fit_to_page(doc) -> None:
    """Умещает содержимое каждого листа на одну страницу.

    Масштаб подбирает LibreOffice: `ScaleToPages = 1` включает режим
    «по страницам», а `ScaleToPagesX/Y = 1` задают, что и по ширине,
    и по высоте лист должен уложиться в одну страницу. Настройка ставится
    всем страничным стилям, а не только `Default`: книга может использовать
    собственные стили, и тогда лист с другим стилем остался бы разорванным.

    Применимо только к таблицам: `ScaleToPages*` — свойства страничного
    стиля Calc, у документа Writer их нет, и «уместить весь документ
    на одну страницу» его смыслом не является.
    """
    page_styles = doc.StyleFamilies.getByName("PageStyles")

    for index in range(page_styles.Count):
        style = page_styles.getByIndex(index)
        try:
            style.ScaleToPages = 1
            style.ScaleToPagesX = 1
            style.ScaleToPagesY = 1
        except Exception:  # noqa: BLE001 - у стиля может не быть свойств страницы
            continue


def build_filter_data(options: dict) -> tuple:
    """Собирает FilterData экспортёра PDF.

    :param options: параметры конвертации из API
    :returns: кортеж PropertyValue для FilterData
    """
    data = [
        prop("UseLosslessCompression", False),
        prop("Quality", int(options.get("quality", 90))),
        prop("ReduceImageResolution", bool(options.get("reduceImageResolution", True))),
        prop("MaxImageResolution", int(options.get("maxImageResolution", 300))),
        prop("SelectPdfVersion", int(options.get("pdfVersionCode", 0))),
        prop("UseTaggedPDF", bool(options.get("taggedPdf", False))),
        prop("ExportBookmarks", bool(options.get("exportBookmarks", True))),
        prop("ExportNotes", False),
        prop("IsAddStream", False),
    ]

    watermark = (options.get("watermark") or "").strip()

    if watermark:
        # Мозаичный знак задаётся отдельным ключом: экспортёр либо повторяет
        # текст по всей странице (TiledWatermark), либо ставит один по центру
        key = "TiledWatermark" if options.get("watermarkMode") == "tiled" else "Watermark"
        data.append(prop(key, watermark))

    if options.get("encrypt") or options.get("userPassword") or options.get("ownerPassword"):
        restrict = bool(options.get("restrictPermissions", False))
        allow_printing = bool(options.get("allowPrinting", True))
        allow_changes = bool(options.get("allowChanges", False))

        data.extend(
            [
                prop("EncryptFile", True),
                prop("DocumentOpenPassword", options.get("userPassword") or ""),
                prop("PermissionPassword", options.get("ownerPassword") or ""),
                prop("RestrictPermissions", restrict),
                # Битовые флаги прав: 4 — печать, 8 — изменение содержимого
                prop("Printing", 4 if (not restrict or allow_printing) else 0),
                prop("Change", 8 if (not restrict or allow_changes) else 0),
            ]
        )

    return tuple(data)


def load_document(desktop, input_path: str, options: dict):
    """Открывает документ в LibreOffice.

    :param desktop: сервис Desktop
    :param input_path: путь к исходному файлу
    :param options: параметры конвертации (используется пароль)
    :returns: загруженный документ
    """
    load_props = [
        prop("Hidden", True),
        prop("ReadOnly", True),
        # Внешние ссылки не обновляются: документ может ссылаться на файл
        # в сети, и ожидание ответа съело бы весь бюджет задачи
        prop("UpdateLinks", 0),
    ]

    macro_mode = macro_execution_mode()

    if macro_mode is not None:
        load_props.append(prop("MacroExecutionMode", macro_mode))

    password = options.get("documentPassword")

    if password:
        load_props.append(prop("Password", password))

    return desktop.loadComponentFromURL(
        uno.systemPathToFileUrl(input_path), "_blank", 0, tuple(load_props)
    )


def count_pdf_pages(path: str) -> int:
    """Считает страницы в готовом PDF.

    Число берётся из файла, а не у контроллера документа: у Calc
    `PageCount` до пересчёта разметки равен нулю, а заставлять LibreOffice
    пересчитывать разметку ради счётчика — лишняя работа на каждый документ.
    В PDF дерево страниц содержит узел `/Type /Pages` с полем `/Count`;
    структурные объекты не сжимаются, поэтому значение читается напрямую.
    """
    with open(path, "rb") as handle:
        data = handle.read()

    counts = [int(match) for match in re.findall(rb"/Count\s+(\d+)", data)]

    # В дереве может быть несколько узлов Pages (по одному на ветку);
    # общее число страниц — максимум из них
    return max(counts) if counts else 0


# ===========================================================================
# Конвертация
# ===========================================================================

def convert(
    host: str,
    port: int,
    timeout: float,
    input_path: str,
    output_path: str,
    doc_format: str,
    options: dict,
) -> dict:
    """Выполняет конвертацию и возвращает результат.

    :param host: адрес UNO-бриджа
    :param port: порт UNO-бриджа
    :param timeout: таймаут подключения
    :param input_path: путь к исходному файлу
    :param output_path: путь для PDF
    :param doc_format: формат исходного файла (xlsx или docx)
    :param options: параметры конвертации
    :returns: словарь с числом страниц и размером результата
    """
    context = connect(timeout, host, port)
    service_manager = context.ServiceManager
    desktop = service_manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)

    doc = None

    try:
        doc = load_document(desktop, input_path, options)

        if doc is None:
            raise RuntimeError("LibreOffice не смог открыть документ")

        if doc_format == "xlsx" and options.get("fitToOnePage", True):
            apply_fit_to_page(doc)

        export_props = (
            prop("FilterName", EXPORT_FILTERS[doc_format]),
            prop("Overwrite", True),
            prop(
                "FilterData",
                uno.Any("[]com.sun.star.beans.PropertyValue", build_filter_data(options)),
            ),
        )

        doc.storeToURL(uno.systemPathToFileUrl(output_path), export_props)

        return {
            "ok": True,
            "pages": count_pdf_pages(output_path),
            "bytes": os.path.getsize(output_path),
        }
    finally:
        if doc is not None:
            # close(True) отдаёт документ без сохранения: файл открыт
            # ReadOnly, и запись в исходник невозможна
            try:
                doc.close(True)
            except Exception:  # noqa: BLE001 - закрытие не должно скрывать ошибку конвертации
                pass


def main() -> int:
    """Точка входа скрипта."""
    parser = argparse.ArgumentParser(description="Конвертация документа в PDF через UNO")
    parser.add_argument("--input", help="путь к исходному файлу")
    parser.add_argument("--output", help="путь для PDF")
    parser.add_argument(
        "--format",
        dest="doc_format",
        choices=sorted(EXPORT_FILTERS),
        default="xlsx",
        help="формат исходного файла",
    )
    parser.add_argument("--options", default="{}", help="параметры конвертации в JSON")
    parser.add_argument("--ping", action="store_true", help="только проверить доступность бриджа")
    parser.add_argument("--host", default=os.environ.get("UNO_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("UNO_PORT", "2002")))
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=float(os.environ.get("UNO_CONNECT_TIMEOUT_MS", "30000")) / 1000,
    )
    args = parser.parse_args()

    if args.ping:
        try:
            connect(args.connect_timeout, args.host, args.port)
            print("pong")
            return 0
        except Exception as exc:  # noqa: BLE001
            print(str(exc), file=sys.stderr)
            return 1

    if not args.input or not args.output:
        print(json.dumps({"ok": False, "error": "Не заданы --input или --output"}))
        return 2

    try:
        options = json.loads(args.options)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"Некорректный JSON параметров: {exc}"}))
        return 2

    started = time.monotonic()

    try:
        result = convert(
            args.host,
            args.port,
            args.connect_timeout,
            args.input,
            args.output,
            args.doc_format,
            options,
        )
        result["durationMs"] = int((time.monotonic() - started) * 1000)
        print(json.dumps(result))
        return 0
    except Exception as exc:  # noqa: BLE001 - наружу отдаём текст, он попадёт в статус задачи
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
