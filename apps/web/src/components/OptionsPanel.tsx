/**
 * Панель параметров конвертации документов в PDF.
 *
 * Все поля управляемые: значения приходят из состояния приложения, где лежат
 * умолчания контракта (`DEFAULT_CONVERSION_OPTIONS`). Так форма показывает
 * ровно то, с чем задача уйдёт на сервер, и не расходится с серверными
 * умолчаниями, как было бы с `defaultValue` у неуправляемых полей.
 *
 * Панель обёрнута в memo: параметры меняются редко, а родитель перерисовывается
 * на каждом тике опроса статусов.
 */

import { memo, useId } from 'react';
import { PDF_VERSIONS } from '@doc-converter/contract/conversion';
import type { ConversionOptions, PdfVersion } from '@doc-converter/contract';
import { MAX_WATERMARK_LENGTH, PDF_VERSION_OPTIONS } from '../config';

interface OptionsPanelProps {
  options: ConversionOptions;
  onOptionsChange: (patch: Partial<ConversionOptions>) => void;
  disabled?: boolean;
}

/** Нижняя граница качества JPEG-сжатия. */
const MIN_QUALITY = 1;

/** Верхняя граница качества JPEG-сжатия. */
const MAX_QUALITY = 100;

/** Нижняя граница разрешения изображений (DPI). */
const MIN_DPI = 50;

/** Верхняя граница разрешения изображений (DPI). */
const MAX_DPI = 1200;

/**
 * Проверяет, что значение поля — известная версия PDF.
 *
 * Список приходит из контракта, поэтому проверка не разойдётся с сервером,
 * а приведение типа (`as PdfVersion`) не понадобится.
 *
 * @param value - значение из выпадающего списка
 * @returns true, если версия известна
 */
function isPdfVersion(value: string): value is PdfVersion {
  return (PDF_VERSIONS as readonly string[]).includes(value);
}

/**
 * Разбирает целое число из поля ввода и удерживает его в границах.
 *
 * @param raw - значение поля
 * @param fallback - значение для незаполненного поля
 * @param min - нижняя граница
 * @param max - верхняя граница
 * @returns число в допустимых границах
 */
function parseBoundedInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);

  // Пустое поле даёт NaN: отправлять 0 нельзя (сервер отвергнет значение
  // как выходящее за диапазон), поэтому возвращается прежнее значение
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

export const OptionsPanel = memo(function OptionsPanel({
  options,
  onOptionsChange,
  disabled = false,
}: OptionsPanelProps) {
  const watermarkId = useId();
  const watermarkModeId = useId();
  const fitToOnePageId = useId();
  const pdfVersionId = useId();
  const qualityId = useId();
  const reduceImagesId = useId();
  const maxResolutionId = useId();
  const bookmarksId = useId();
  const taggedId = useId();
  const userPasswordId = useId();
  const ownerPasswordId = useId();
  const restrictId = useId();
  const allowPrintingId = useId();
  const allowChangesId = useId();

  const isArchive = options.pdfVersion.startsWith('pdfa');

  return (
    <form className="options" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="options__group" disabled={disabled}>
        <legend>Водяной знак</legend>

        <div className="field">
          <label htmlFor={watermarkId}>Текст</label>
          <input
            id={watermarkId}
            name="watermark"
            type="text"
            maxLength={MAX_WATERMARK_LENGTH}
            placeholder="Черновик"
            value={options.watermark ?? ''}
            onChange={(event) => onOptionsChange({ watermark: event.target.value })}
          />
          <span className="field__hint">
            До {MAX_WATERMARK_LENGTH} символов. Пустое поле — без знака
          </span>
        </div>

        <div className="field">
          <label htmlFor={watermarkModeId}>Режим нанесения</label>
          <select
            id={watermarkModeId}
            name="watermarkMode"
            value={options.watermarkMode}
            onChange={(event) =>
              onOptionsChange({
                watermarkMode: event.target.value === 'tiled' ? 'tiled' : 'single',
              })
            }
          >
            <option value="single">Один по центру страницы</option>
            <option value="tiled">Мозаикой по всей странице</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="options__group" disabled={disabled}>
        <legend>PDF</legend>

        <div className="field">
          <label htmlFor={pdfVersionId}>Версия</label>
          <select
            id={pdfVersionId}
            name="pdfVersion"
            value={options.pdfVersion}
            onChange={(event) => {
              const { value } = event.target;

              if (isPdfVersion(value)) {
                onOptionsChange({ pdfVersion: value });
              }
            }}
          >
            {PDF_VERSION_OPTIONS.map((version) => (
              <option key={version.value} value={version.value}>
                {version.label}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {isArchive
              ? 'PDF/A — формат для долговременного архивирования: шрифты встраиваются в документ'
              : 'Версия по умолчанию подходит для обычного просмотра и печати'}
          </span>
        </div>

        <div className="field">
          <label htmlFor={qualityId}>Качество изображений</label>
          <input
            id={qualityId}
            name="quality"
            type="number"
            min={MIN_QUALITY}
            max={MAX_QUALITY}
            inputMode="numeric"
            value={options.quality}
            onChange={(event) =>
              onOptionsChange({
                quality: parseBoundedInt(
                  event.target.value,
                  options.quality,
                  MIN_QUALITY,
                  MAX_QUALITY
                ),
              })
            }
          />
          <span className="field__hint">
            Качество JPEG-сжатия, {MIN_QUALITY}–{MAX_QUALITY}. Действует только
            при включённом сжатии изображений
          </span>
        </div>

        <div className="checkbox">
          <input
            id={reduceImagesId}
            name="reduceImageResolution"
            type="checkbox"
            checked={options.reduceImageResolution}
            onChange={(event) =>
              onOptionsChange({ reduceImageResolution: event.target.checked })
            }
          />
          <label htmlFor={reduceImagesId}>Сжимать изображения</label>
        </div>

        <div className="field">
          <label htmlFor={maxResolutionId}>Предельное разрешение, DPI</label>
          <input
            id={maxResolutionId}
            name="maxImageResolution"
            type="number"
            min={MIN_DPI}
            max={MAX_DPI}
            inputMode="numeric"
            disabled={!options.reduceImageResolution}
            value={options.maxImageResolution}
            onChange={(event) =>
              onOptionsChange({
                maxImageResolution: parseBoundedInt(
                  event.target.value,
                  options.maxImageResolution,
                  MIN_DPI,
                  MAX_DPI
                ),
              })
            }
          />
          <span className="field__hint">
            {MIN_DPI}–{MAX_DPI} DPI. Разрешение выше исходного не поднимается —
            изображения только уменьшаются
          </span>
        </div>

        <div className="checkbox">
          <input
            id={bookmarksId}
            name="exportBookmarks"
            type="checkbox"
            checked={options.exportBookmarks}
            onChange={(event) =>
              onOptionsChange({ exportBookmarks: event.target.checked })
            }
          />
          <label htmlFor={bookmarksId}>Закладки</label>
        </div>

        <p className="field__hint">
          У книги — по листам, у документа Word — по заголовкам
        </p>

        <div className="checkbox">
          <input
            id={taggedId}
            name="taggedPdf"
            type="checkbox"
            checked={options.taggedPdf}
            onChange={(event) => onOptionsChange({ taggedPdf: event.target.checked })}
          />
          <label htmlFor={taggedId}>
            Теги структуры (нужны для доступности и PDF/A)
          </label>
        </div>
      </fieldset>

      <fieldset className="options__group" disabled={disabled}>
        <legend>Размещение на странице</legend>

        <div className="checkbox">
          <input
            id={fitToOnePageId}
            name="fitToOnePage"
            type="checkbox"
            checked={options.fitToOnePage}
            onChange={(event) =>
              onOptionsChange({ fitToOnePage: event.target.checked })
            }
          />
          <label htmlFor={fitToOnePageId}>Уместить лист на одну страницу</label>
        </div>

        <p className="field__hint">
          Только для книг Excel: LibreOffice сам подбирает масштаб, а для очень
          больших таблиц текст становится нечитаемым — тогда снимайте флажок.
          На документы Word параметр не действует
        </p>
      </fieldset>

      <fieldset className="options__group" disabled={disabled}>
        <legend>Защита документа</legend>

        <div className="field">
          <label htmlFor={userPasswordId}>Пароль на открытие PDF</label>
          <input
            id={userPasswordId}
            name="userPassword"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            value={options.userPassword ?? ''}
            onChange={(event) => onOptionsChange({ userPassword: event.target.value })}
          />
          <span className="field__hint">
            Пустое поле — документ открывается без пароля
          </span>
        </div>

        <div className="field">
          <label htmlFor={ownerPasswordId}>Пароль владельца</label>
          <input
            id={ownerPasswordId}
            name="ownerPassword"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            value={options.ownerPassword ?? ''}
            onChange={(event) => onOptionsChange({ ownerPassword: event.target.value })}
          />
          <span className="field__hint">
            Им снимаются ограничения на печать и изменение документа
          </span>
        </div>

        <div className="checkbox">
          <input
            id={restrictId}
            name="restrictPermissions"
            type="checkbox"
            checked={options.restrictPermissions}
            onChange={(event) =>
              onOptionsChange({ restrictPermissions: event.target.checked })
            }
          />
          <label htmlFor={restrictId}>Ограничить права на документ</label>
        </div>

        <div className="checkbox">
          <input
            id={allowPrintingId}
            name="allowPrinting"
            type="checkbox"
            checked={options.allowPrinting}
            disabled={!options.restrictPermissions}
            onChange={(event) =>
              onOptionsChange({ allowPrinting: event.target.checked })
            }
          />
          <label htmlFor={allowPrintingId}>Разрешить печать</label>
        </div>

        <div className="checkbox">
          <input
            id={allowChangesId}
            name="allowChanges"
            type="checkbox"
            checked={options.allowChanges}
            disabled={!options.restrictPermissions}
            onChange={(event) => onOptionsChange({ allowChanges: event.target.checked })}
          />
          <label htmlFor={allowChangesId}>Разрешить изменение документа</label>
        </div>

        <p className="field__hint">
          Ограничения действуют, только если задан пароль владельца: без него
          любой читатель PDF может их снять
        </p>
      </fieldset>
    </form>
  );
});
