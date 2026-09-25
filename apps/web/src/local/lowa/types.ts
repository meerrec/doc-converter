/**
 * Типы браузерной сборки LibreOffice (LOWA) и перенесённой обвязки.
 *
 * Здесь объявлено **только то, что вызывает наша обвязка**, а не весь UNO API:
 * динамический вызов через `css.script.Invocation` (см. `public/uno/runtime.js`)
 * позволяет обратиться к любому интерфейсу по имени, и типизировать всё дерево
 * означало бы переписать сюда `unoapi`. Объявленное проверяется компилятором,
 * остальное — прогоном.
 *
 * Соответствие объявлений реальной сборке ничем, кроме прогона, не проверяется:
 * при обновлении сборки расхождение проявится ошибкой вызова, а не ошибкой
 * типов. Поэтому имена здесь имеют смысл документации к сборке, а не гарантии.
 *
 * Все комментарии на русском языке.
 */

/** Непрозрачный тип UNO: создаётся только самой обвязкой. */
export interface UnoTypeHandle {
  readonly __unoType?: never;
}

/** Непрозрачное значение `any`: обёртка над значением и его типом. */
export interface UnoAny {
  readonly __unoAny?: never;
}

/**
 * Прокси-объект UNO.
 *
 * Обвязка создаёт по прокси на каждый объект и добавляет методы по описанию
 * типа, поэтому точный состав членов статически неизвестен. Там, где состав
 * важен, вызывающий приводит прокси к объявленному интерфейсу (см. ниже).
 */
export interface UnoProxy {
  readonly [member: string]: unknown;
}

/**
 * Структура `com.sun.star.beans.PropertyValue`.
 *
 * В аргументах UNO она встречается постоянно: `Hidden` при загрузке,
 * `FilterName` и `FilterData` при экспорте. Конструктор берётся из дерева
 * (`new zetajs.uno.com.sun.star.beans.PropertyValue({...})`), а не создаётся
 * вручную: полей у структуры четыре, и заполняет их обвязка.
 */
export interface PropertyValue {
  readonly Name: string;
  readonly Value: unknown;
}

/** Конструктор структуры `PropertyValue`. */
export interface PropertyValueCtor {
  new (init: { Name: string; Value: unknown }): PropertyValue;
}

// ===========================================================================
// Объекты UNO, с которыми работает обвязка
// ===========================================================================
//
// Приведения типов (`query`) здесь нет и быть не может: перенесённая обвязка
// строит прокси сразу по всем интерфейсам объекта, и его методы доступны
// напрямую. Поэтому документ — один тип с методами, которые обвязка вызывает,
// а не набор `XCloseable`/`XStorable`, к которым его пришлось бы приводить
// по отдельности. Объявлено ровно то, что вызывается: остальное проверяется
// прогоном, а не компилятором.

/** Рабочий стол: то, через что открывается документ. */
export interface XDesktop {
  loadComponentFromURL(
    url: string,
    target: string,
    searchFlags: number,
    args: PropertyValue[]
  ): XDocument | null;
}

/**
 * Открытый документ.
 *
 * `storeToURL` пишет копию и не меняет сам документ — этим он и отличается
 * от `store`, который здесь не нужен: исходный файл не перезаписывается.
 */
export interface XDocument {
  close(deliverOwnership: boolean): void;
  storeToURL(url: string, args: PropertyValue[]): void;
  /** Семейства стилей: страничный стиль книги живёт здесь. */
  getStyleFamilies(): XStyleFamilies;
  /** Контроллер окна — нужен предпросмотру. */
  getCurrentController(): XController;
  /** Есть только у Calc: у текстового документа листов нет. */
  getSheets?(): XCountable;
}

/** Семейства стилей документа. */
export interface XStyleFamilies {
  getByName(name: string): XStyleContainer;
}

/** Контейнер элементов: доступ по индексу. */
export interface XStyleContainer {
  getCount(): number;
  getByIndex(index: number): XPropertySet;
}

/** Объект, у которого обвязка спрашивает только число элементов. */
export interface XCountable {
  getCount(): number;
}

/** Свойства объекта: страничный стиль задаётся именно так. */
export interface XPropertySet {
  setPropertyValue(name: string, value: unknown): void;
}

/** Контроллер документа — нужен предпросмотру для доступа к окну. */
export interface XController {
  getFrame(): XFrame;
}

/** Окно документа. */
export interface XFrame {
  readonly LayoutManager: XLayoutManager;
  getContainerWindow(): XWindow;
}

/** Управление элементами интерфейса окна. */
export interface XLayoutManager {
  hideElement(element: string): boolean;
}

/** Окно, у которого можно запросить полноэкранный режим. */
export interface XWindow {
  FullScreen: boolean;
}

/** Конфигурация офиса: используется для перебора имён элементов интерфейса. */
export interface XConfigurationAccess {
  getByHierarchicalName(name: string): XConfigurationNode;
  commitChanges(): void;
}

/** Узел конфигурации: список имён и доступ к элементу по имени. */
export interface XConfigurationNode {
  getElementNames(): string[];
  getByName(name: string): XPropertySet;
}

// ===========================================================================
// Узлы дерева UNO
// ===========================================================================

/**
 * Фабрика сервиса: `css.frame.Desktop.create(context)`.
 *
 * `Desktop` — единственный сервис, который обвязка создаёт напрямую: остальное
 * берётся у него.
 */
export interface UnoServiceFactory<T> {
  create(...args: unknown[]): T;
}

/**
 * Дерево сервисов и интерфейсов UNO.
 *
 * Путь повторяет имена модулей UNO (`com.sun.star.beans.PropertyValue`),
 * поэтому читается как обычная ссылка в коде на UNO. Перечислено только то,
 * что обвязка берёт из дерева: документ, его стили и контроллер берутся
 * у самого документа, поэтому их здесь нет.
 */
export interface ZetajsUnoTree {
  readonly com: {
    readonly sun: {
      readonly star: {
        readonly beans: {
          readonly PropertyValue: PropertyValueCtor;
        };
        readonly frame: {
          /** Рабочий стол — единственный сервис, создаваемый напрямую. */
          readonly Desktop: UnoServiceFactory<XDesktop>;
        };
        readonly document: {
          /** Константа группы `com.sun.star.document.MacroExecMode`. */
          readonly MacroExecMode: { readonly NEVER_EXECUTE: number };
        };
        readonly configuration: {
          readonly ReadWriteAccess: UnoServiceFactory<XConfigurationAccess>;
        };
      };
    };
  };
}

/**
 * Узел `com.sun.star` — то, что обвязка называет `css`.
 *
 * Отдельным именем, потому что в коде это самая частая ссылка, а полный путь
 * `uno.com.sun.star` в каждой строке читался бы как шум.
 */
export type ZetajsCss = ZetajsUnoTree['com']['sun']['star'];

// ===========================================================================
// Обвязка и модуль
// ===========================================================================

/**
 * Обвязка UNO (`Module.zetajs`), создаваемая перенесённым `runtime.js`.
 *
 * Порт обмена живёт здесь же (`mainPort`): отдельного API у сборки для него нет.
 */
export interface Zetajs {
  readonly uno: ZetajsUnoTree;
  readonly type: {
    readonly long: UnoTypeHandle;
    readonly boolean: UnoTypeHandle;
    readonly string: UnoTypeHandle;
    sequence(componentType: UnoTypeHandle): UnoTypeHandle;
  };
  readonly Any: new (type: UnoTypeHandle, value: unknown) => UnoAny;
  getAnyType(value: unknown): UnoTypeHandle;
  getUnoComponentContext(): UnoProxy;
  catchUnoException(error: unknown): UnoException;
  /** Порт обмена с главным потоком — со стороны воркера. */
  readonly mainPort: MessagePort;
}

/** Исключение UNO, разобранное обвязкой. */
export interface UnoException {
  readonly Message?: string;
}

/**
 * Виртуальная файловая система сборки.
 *
 * Общая для обоих потоков: файл, записанный главным потоком, виден в воркере
 * по тому же пути, и наоборот. Это единственный канал передачи содержимого
 * документа — через `postMessage` передаются только пути и параметры.
 */
export interface EmscriptenFs {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  mkdirTree?(path: string): void;
  /** Сведения о файле: из них берётся размер результата без чтения файла. */
  stat?(path: string): { size: number };
}

/**
 * Глобальный объект `Module`, которого требует сборка.
 *
 * Сборка читает `canvas`, `uno_scripts` и `locateFile` при инициализации,
 * а кладёт в `Module` промисы готовности и порты обмена. Ни одно из полей
 * не является нашим API: это точки соприкосновения со сборкой, и их состав
 * задан её кодом, а не нами.
 */
export interface LowaModule {
  // --- то, что задаём мы, до подключения soffice.js ---
  canvas?: HTMLCanvasElement;
  /** Скрипты, исполняемые в воркере, по порядку. */
  uno_scripts?: string[];
  locateFile?: (path: string, prefix: string) => string;
  /** Скрипт, который воркер исполняет первым (Emscripten `mainScriptUrlOrBlob`). */
  mainScriptUrlOrBlob?: Blob | string;

  // --- то, что появляется после инициализации ---
  /** Инициализация UNO завершена (доступно в обоих потоках). */
  readonly uno_init?: Promise<void>;
  /** Порт обмена со стороны главного потока. */
  readonly uno_main?: Promise<MessagePort>;
  /** Обвязка UNO (в воркере). */
  readonly zetajs?: Promise<Zetajs>;
  /** Виртуальная файловая система (в главном потоке — `window.FS`). */
  readonly FS?: EmscriptenFs;
  /** Куча WASM: нужна только для диагностики памяти. */
  readonly HEAPU8?: Uint8Array;
}
