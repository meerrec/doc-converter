/**
 * Работа с UNO внутри воркера: открытие документа, экспорт PDF, предпросмотр.
 *
 * Модуль исполняется в воркере сборки — там, где живёт UNO. Обращаться
 * к `document` отсюда нельзя (в воркере его нет), поэтому окно предпросмотра
 * настраивается через UNO, а не через DOM.
 *
 * Последовательность работы с документом повторяет серверную
 * (`docker/uno/uno_convert.py`) намеренно: расхождение здесь означало бы
 * разный PDF для одного и того же файла — то, ради чего затевался весь путь.
 * Общий у серверного и браузерного экспорта — только список параметров
 * (`filterData.ts`), который сверяется тестом; остальное повторяется
 * по смыслу, а не буквально: у сервера загрузка идёт с диска по пути,
 * здесь — из виртуальной файловой системы по URL.
 *
 * Все комментарии на русском языке.
 */

import type { FilterDataEntry } from '../filterData.js';
import type {
  ConvertRequest,
  LocalErrorCode,
  MemoryResult,
  PreviewResult,
} from '../protocol.js';
import type {
  LowaModule,
  PropertyValue,
  UnoAny,
  XConfigurationNode,
  XDesktop,
  XDocument,
  XStyleContainer,
  Zetajs,
  ZetajsCss,
} from '../types.js';

/**
 * Префиксы ресурсов интерфейса, которые скрываются в предпросмотре.
 *
 * Имена ресурсов берутся из конфигурации офиса, а не перечисляются списком:
 * панелей инструментов много, и их имена в разных модулях разные. Здесь
 * только префиксы — то, что в окне является интерфейсом, а не документом.
 */
const HIDDEN_UI_PREFIXES = [
  'private:resource/menubar/',
  'private:resource/toolbar/',
  'private:resource/statusbar/',
  'private:resource/sidebar/',
];

/**
 * Элементы, которые возвращает на место полноэкранный режим.
 *
 * Измерено: после перехода в полноэкранный режим меню и строка состояния
 * появляются снова, хотя были скрыты до него. Поэтому они скрываются
 * повторно — и именно после.
 */
const UI_ELEMENTS_TO_HIDE_AGAIN = [
  'private:resource/menubar/menubar',
  'private:resource/statusbar/statusbar',
];

/**
 * Модули, настройки интерфейса которых читаются при подготовке предпросмотра.
 *
 * Оба: по расширению файла вид документа здесь не определяется, а настройка
 * скрытия элементов — операция дешёвая и безвредная для чужого модуля.
 */
const UI_MODULES = ['Calc', 'Writer'];

/**
 * Отказ операции с указанием причины.
 *
 * Код нужен странице, чтобы отличить отказы друг от друга: подсказка
 * «документ слишком велик» уместна только при исчерпании памяти, а «не
 * удалось открыть» — только при загрузке. Разбирать для этого текст
 * сообщения на стороне страницы значило бы зависеть от формулировок.
 */
export class OfficeError extends Error {
  /** Код отказа. */
  readonly code: LocalErrorCode;

  /**
   * @param code - код отказа
   * @param message - описание для журнала
   */
  constructor(code: LocalErrorCode, message: string) {
    super(message);
    this.name = 'OfficeError';
    this.code = code;
  }
}

/** Рабочий стол UNO и всё, что обвязка делает с документами. */
export class Office {
  private readonly zetajs: Zetajs;
  private readonly css: ZetajsCss;
  private readonly desktop: XDesktop;
  private readonly module: LowaModule;

  /**
   * Открытый документ и путь, по которому он открыт.
   *
   * Документ держится открытым между операциями: открытие — самая дорогая
   * часть работы, и перезагружать его между предпросмотром и конвертацией
   * значило бы платить эту цену дважды. Одновременно открыт не более одного
   * документа: линейная память сборки — 1 ГБ, и два документа делят её.
   */
  private open: { readonly path: string; readonly doc: XDocument } | null = null;

  /**
   * @param zetajs - обвязка UNO, созданная перенесённым `runtime.js`
   * @param module - сборка: файловая система и куча берутся из неё
   */
  constructor(zetajs: Zetajs, module: LowaModule) {
    this.zetajs = zetajs;
    this.css = zetajs.uno.com.sun.star;
    this.module = module;

    this.desktop = this.css.frame.Desktop.create(zetajs.getUnoComponentContext());
  }

  /**
   * Конвертирует документ в PDF.
   *
   * Если документ уже открыт (например, для предпросмотра) — экспортируется
   * он же, и закрывать его после экспорта нельзя: страница его показывает.
   * Подгонка под страницу при этом меняет и видимую разметку, что ожидаемо:
   * она и означает «уместить лист на одну страницу».
   *
   * @param request - задание с путями и параметрами экспорта
   * @returns размер готового PDF
   */
  convert(request: ConvertRequest): null {
    const reused = this.open?.path === request.source;
    const doc = this.acquire(request.source, true);

    try {
      if (request.scaleToPages) {
        this.applyFitToPage(doc);
      }

      this.exportPdf(doc, request.target, request.filterName, request.filterData);

      return null;
    } finally {
      if (!reused) {
        this.release();
      }
    }
  }

  /**
   * Открывает документ в окне сборки и убирает из окна интерфейс офиса.
   *
   * @param source - путь документа в виртуальной файловой системе
   * @returns сведения о документе
   */
  preview(source: string): PreviewResult {
    const reused = this.open?.path === source;

    const doc = this.acquire(source, false);

    // ВРЕМЕННО: настройка конфигурации отключена, скрытие в окне включено
    if (!reused) {
      this.hideWindowElements(doc);
    }

    return { sheets: this.countSheets(doc) };
  }

  /** Закрывает открытый документ, освобождая память. */
  close(): null {
    this.release();

    return null;
  }

  /** Текущий размер линейной памяти сборки. */
  memory(): MemoryResult {
    return { heapBytes: this.module.HEAPU8?.byteLength ?? 0 };
  }

  // =========================================================================
  // Документ
  // =========================================================================

  /**
   * Отдаёт открытый документ, открывая его при необходимости.
   *
   * @param source - путь документа
   * @param hidden - открывать ли без окна (для конвертации)
   * @returns открытый документ
   */
  private acquire(source: string, hidden: boolean): XDocument {
    if (this.open !== null && this.open.path === source) {
      return this.open.doc;
    }

    this.release();

    const doc = this.load(source, hidden);

    this.open = { path: source, doc };

    return doc;
  }

  /**
   * Загружает документ по пути в виртуальной файловой системе.
   *
   * Свойства загрузки повторяют серверные: `ReadOnly` — документ открывается
   * для чтения, и попытка сохранить его на место не делает ничего;
   * `UpdateLinks` в нуле — иначе документ с внешней ссылкой ждал бы ответа
   * сети, а из воркера доступ в сеть есть.
   *
   * @param source - путь документа
   * @param hidden - открывать ли без окна
   * @returns загруженный документ
   */
  private load(source: string, hidden: boolean): XDocument {
    const properties: PropertyValue[] = [
      new this.css.beans.PropertyValue({ Name: 'Hidden', Value: hidden }),
      new this.css.beans.PropertyValue({ Name: 'UpdateLinks', Value: 0 }),
    ];

    if (hidden) {
      // Только для скрытой загрузки: документ открывается ради экспорта,
      // и записывать в него ничего не будут. Предпросмотру этот режим
      // не подходит — в нём сборка показывает баннер «документ открыт
      // только для чтения» с кнопкой перехода в режим правки
      properties.push(new this.css.beans.PropertyValue({ Name: 'ReadOnly', Value: true }));
    }

    const macroMode = this.macroExecutionMode();

    if (macroMode !== null) {
      properties.push(
        new this.css.beans.PropertyValue({ Name: 'MacroExecutionMode', Value: macroMode })
      );
    }

    // Целевой фрейм `_default`: с `_blank` сборка отказывается грузить
    // документ (`IllegalArgumentException` на проверке), а скрытому документу
    // окно всё равно не создаётся
    let doc: XDocument | null;

    try {
      doc = this.desktop.loadComponentFromURL(`file://${source}`, '_default', 0, properties);
    } catch (error) {
      throw new OfficeError('lowa_load_failed', this.describe(error));
    }

    if (doc === null) {
      throw new OfficeError('lowa_load_failed', `документ не открылся: ${source}`);
    }

    return doc;
  }

  /**
   * Приводит исключение к тексту.
   *
   * Исключения UNO приходят из воркера как непрозрачные значения, и их
   * разбирает обвязка: без этого в сообщении оказалось бы «[object Object]»
   * вместо причины отказа.
   *
   * @param error - пойманное исключение
   * @returns описание для журнала
   */
  private describe(error: unknown): string {
    try {
      const exception = this.zetajs.catchUnoException(error);
      const message = exception.Message;

      if (typeof message === 'string' && message !== '') {
        return message;
      }
    } catch {
      // Не исключение UNO — разбирается ниже
    }

    return error instanceof Error ? error.message : String(error);
  }

  /** Закрывает документ, если он открыт. */
  private release(): void {
    const open = this.open;

    this.open = null;

    if (open === null) {
      return;
    }

    try {
      // `deliverOwnership = true`: закрыть документ, даже если на него
      // ещё есть ссылки. Иначе документ остался бы в памяти до перезапуска
      // сборки, а память здесь — главный ресурс
      open.doc.close(true);
    } catch {
      // Документ мог быть закрыт пользователем или упасть вместе с модулем:
      // ошибка закрытия не должна подменять результат операции
    }
  }

  /**
   * Возвращает режим исполнения макросов, если сборка его предоставляет.
   *
   * Серверный путь задаёт `MacroExecutionMode` явно, и повторение было бы
   * полным. Но константа лежит в дереве UNO как значение, а не как интерфейс,
   * и её доступность зависит от сборки: если её нет, свойство не передаётся
   * вовсе — выдумывать числовой код значило бы делать вид, что защита есть.
   *
   * @returns код режима или null, если сборка его не предоставляет
   */
  private macroExecutionMode(): number | null {
    try {
      const mode = this.css.document.MacroExecMode.NEVER_EXECUTE;

      return typeof mode === 'number' ? mode : null;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Экспорт
  // =========================================================================

  /**
   * Экспортирует документ в PDF.
   *
   * @param doc - документ
   * @param target - путь результата
   * @param filterName - имя фильтра экспорта
   * @param filterData - параметры экспорта
   */
  private exportPdf(
    doc: XDocument,
    target: string,
    filterName: string,
    filterData: readonly FilterDataEntry[]
  ): void {
    const properties: PropertyValue[] = [
      new this.css.beans.PropertyValue({ Name: 'FilterName', Value: filterName }),
      new this.css.beans.PropertyValue({ Name: 'Overwrite', Value: true }),
    ];

    const data = this.buildFilterData(filterData);

    if (data !== null) {
      properties.push(new this.css.beans.PropertyValue({ Name: 'FilterData', Value: data }));
    }

    try {
      doc.storeToURL(`file://${target}`, properties);
    } catch (error) {
      throw new OfficeError('lowa_export_failed', this.describe(error));
    }
  }

  /**
   * Собирает `FilterData` как типизированную последовательность.
   *
   * Способ передачи решает, дойдут ли параметры до экспортёра. Обычный
   * JS-массив обвязка превращает в последовательность `any`, а экспортёр
   * ожидает `[]com.sun.star.beans.PropertyValue` — и чужой тип **молча
   * игнорирует**: PDF получается валидный, но без PDF/A, водяного знака
   * и сжатия. Поэтому тип последовательности берётся у самой структуры,
   * а не выводится из значения. Проверено на сборке: 1281 байт без
   * типизации против 15 269 с PDF/A.
   *
   * @param entries - параметры экспорта парами
   * @returns значение для свойства `FilterData` или null, если параметров нет
   */
  private buildFilterData(entries: readonly FilterDataEntry[]): UnoAny | null {
    const first = entries[0];

    if (first === undefined) {
      return null;
    }

    const beans = entries.map(
      (entry) => new this.css.beans.PropertyValue({ Name: entry.name, Value: entry.value })
    );

    const componentType = this.zetajs.getAnyType(beans[0]);

    return new this.zetajs.Any(this.zetajs.type.sequence(componentType), beans);
  }

  // =========================================================================
  // Подгонка под страницу
  // =========================================================================

  /**
   * Умещает каждый лист книги на одну страницу.
   *
   * Настройка ставится всем страничным стилям, а не только `Default`: книга
   * может использовать собственные стили, и лист с другим стилем остался бы
   * разорванным. Стиль без свойств страницы пропускается — это не ошибка
   * документа, а его особенность (серверный путь делает так же).
   *
   * @param doc - документ
   */
  private applyFitToPage(doc: XDocument): void {
    let pageStyles: XStyleContainer;

    try {
      pageStyles = doc.getStyleFamilies().getByName('PageStyles');
    } catch {
      // У документа может не быть страничных стилей вовсе
      return;
    }

    for (let i = 0; i < pageStyles.getCount(); i += 1) {
      try {
        const style = pageStyles.getByIndex(i);

        style.setPropertyValue('ScaleToPages', 1);
        style.setPropertyValue('ScaleToPagesX', 1);
        style.setPropertyValue('ScaleToPagesY', 1);
      } catch {
        // У стиля может не быть свойств страницы
      }
    }
  }

  // =========================================================================
  // Предпросмотр
  // =========================================================================

  /**
   * Читает имена элементов интерфейса из конфигурации офиса.
   *
   * Имена не перечисляются списком: их десятки, и они различаются по модулям.
   * Скрывается то, что совпало с известными префиксами, — остальное в окне
   * является документом.
   *
   * @returns имена ресурсов интерфейса
   */
  private interfaceElements(): string[] {
    const names = new Set<string>();

    for (const moduleName of UI_MODULES) {
      try {
        const access = this.css.configuration.ReadWriteAccess.create(
          this.zetajs.getUnoComponentContext(),
          'en-US'
        );
        const states: XConfigurationNode = access.getByHierarchicalName(
          `/org.openoffice.Office.UI.${moduleName}WindowState/UIElements/States`
        );

        for (const name of states.getElementNames()) {
          if (HIDDEN_UI_PREFIXES.some((prefix) => name.startsWith(prefix))) {
            names.add(name);
          }
        }
      } catch {
        // Модуль может отсутствовать в сборке — это не ошибка предпросмотра
      }
    }

    return [...names];
  }

  /**
   * Убирает интерфейс из уже созданного окна документа.
   *
   * Меню, панели и строку состояния убирает `LayoutManager`; полноэкранный
   * режим снимает рамку окна, после чего часть элементов возвращается
   * на место — поэтому ключевые скрываются повторно.
   *
   * **Чего здесь намеренно нет: настройки конфигурации офиса.** Тот же
   * интерфейс можно убрать через `UIElements/States` со свойством
   * `Visible = false` — так делает сам LibreOffice, — но в браузерной сборке
   * это ломает предпросмотр: окно загружается, а canvas остаётся пустым
   * (проверено: с настройкой конфигурации — серый прямоугольник, без неё —
   * документ). Поэтому интерфейс убирается только у созданного окна.
   *
   * Что убрать **не удалось** (проверено на сборке): строку формул и боковую
   * панель. Команды `.uno:InputLineVisible` и свойство `Sidebar.Visible`
   * принимаются без ошибки, но на отрисовку не влияют. Эти два элемента
   * остаются в предпросмотре — это ограничение сборки, а не недоделка здесь.
   *
   * @param doc - открытый документ
   */
  private hideWindowElements(doc: XDocument): void {
    let layout;
    let frame;

    try {
      frame = doc.getCurrentController().getFrame();
      layout = frame.LayoutManager;
    } catch {
      // Документ без окна (открыт скрыто) — скрывать нечего
      return;
    }

    for (const element of this.interfaceElements()) {
      try {
        layout.hideElement(element);
      } catch {
        // Элемента может не быть в этом окне
      }
    }

    try {
      frame.getContainerWindow().FullScreen = true;
    } catch {
      // Полноэкранный режим недоступен — окно останется с рамкой
    }

    for (const element of UI_ELEMENTS_TO_HIDE_AGAIN) {
      try {
        layout.hideElement(element);
      } catch {
        // См. выше
      }
    }
  }

  /**
   * Считает листы книги.
   *
   * У текстового документа листов нет — возвращается null, а не нуль:
   * нуль означал бы «книга без листов», а это разные вещи.
   *
   * @param doc - открытый документ
   * @returns число листов или null
   */
  private countSheets(doc: XDocument): number | null {
    try {
      const sheets = doc.getSheets?.();

      return sheets === undefined ? null : sheets.getCount();
    } catch {
      return null;
    }
  }

}
