/**
 * Шрифты для canvas: то, чем рисуется предпросмотр.
 *
 * Путь в PDF и путь в canvas берут шрифты из разных мест. В PDF байты
 * встраиваются в файл, и больше ничего не нужно. Canvas рисует двумя
 * способами: обводками глифов (их даёт wasm по номерам, полученным при
 * вёрстке) и вызовом `fillText` — так приходят номера пунктов списка
 * у документов Word и весь текст книги. Второму нужен шрифт, известный
 * окружению, то есть `FontFace` в наборе шрифтов воркера.
 *
 * Байты берутся из того же источника, что и для вёрстки: иначе `measureText`
 * в canvas измерил бы одно, а движок разложил другое, и выравнивание текста
 * в ячейках поехало бы относительно скачанного файла.
 *
 * Регистрация — **no-op там, где набора шрифтов нет** (Node, старые браузеры):
 * предпросмотр в этом окружении всё равно недоступен, а вёрстка и PDF
 * от шрифтов canvas не зависят.
 *
 * Все комментарии на русском языке.
 */

import { createFontProvider } from '@betteroffice/fonts';

/** Набор шрифтов окружения — та часть, которой пользуется этот модуль. */
interface FontsHost {
  readonly fonts?: { add(face: FontFace): void };
  readonly FontFace?: typeof FontFace;
}

/** Реестр шрифтов canvas. */
export interface CanvasFonts {
  /**
   * Регистрирует начертание семейства.
   *
   * @param family - имя семейства так, как его называет документ
   * @param bold - полужирное начертание
   * @param italic - курсив
   */
  ensure(family: string, bold: boolean, italic: boolean): Promise<void>;
}

/**
 * Создаёт реестр шрифтов canvas.
 *
 * @returns реестр; в окружении без `FontFace` его вызовы ничего не делают
 */
export function createCanvasFonts(): CanvasFonts {
  const host = globalThis as unknown as FontsHost;
  const provider = createFontProvider();
  const done = new Map<string, Promise<void>>();

  /**
   * Регистрирует одно начертание.
   *
   * @param key - ключ «что именно попросили»
   * @param family - имя семейства для canvas
   * @param bold - полужирное начертание
   * @param italic - курсив
   * @param loader - откуда взять байты
   */
  const register = (
    key: string,
    family: string,
    bold: boolean,
    italic: boolean,
    loader: (() => Promise<ArrayBuffer>) | undefined
  ): Promise<void> => {
    const pending = done.get(key);

    if (pending !== undefined) {
      return pending;
    }

    const started = (async () => {
      const Face = host.FontFace;
      const fonts = host.fonts;

      // Окружение без набора шрифтов: регистрировать некуда и незачем
      if (Face === undefined || fonts === undefined || loader === undefined) {
        return;
      }

      const face = new Face(family, await loader(), {
        weight: bold ? '700' : '400',
        style: italic ? 'italic' : 'normal',
      });

      // Загрузка до добавления: рисование идёт сразу после регистрации,
      // и незагруженный шрифт дал бы подстановку вместо нужного начертания
      await face.load();
      fonts.add(face);
    })().catch(() => {
      // Неудачная регистрация — не отказ документа: текст уйдёт подстановкой.
      // Запоминаем как выполненную, чтобы не тянуть те же байты на каждый
      // прогон, и даём шанс следующему начертанию
      done.delete(key);
    });

    done.set(key, started);

    return started;
  };

  return {
    ensure(family: string, bold: boolean, italic: boolean): Promise<void> {
      const key = `${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
      // Подстановка та же, что у вёрстки: известное семейство, а для
      // незнакомого — последняя надежда. Иначе canvas взял бы системный
      // шрифт, и метрики разошлись бы с теми, по которым считал движок
      const loader = provider.resolve(family, bold, italic) ?? provider.resolveLastResort(family, bold, italic);

      return register(key, family, bold, italic, loader);
    },
  };
}
