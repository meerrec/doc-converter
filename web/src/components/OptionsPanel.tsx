/**
 * Панель параметров конвертации.
 *
 * Поля показываются по контексту: кодировка имеет смысл для текстовых
 * форматов, разделитель — для CSV, параметры листа — для таблиц. Так
 * пользователь не отправляет заведомо неприменимые опции.
 */

import { useId } from 'react';
import {
  CODE_PAGES,
  CSV_FORMAT,
  DELIMITERS,
  OUTPUT_FORMATS,
  OUTPUT_FORMAT_LABELS,
  SPREADSHEET_INPUT_FORMATS,
  TEXT_INPUT_FORMATS,
} from '../config';
import type { ConversionOptions } from '../api/types';

interface OptionsPanelProps {
  outputType: string;
  onOutputTypeChange: (value: string) => void;
  options: ConversionOptions;
  onOptionsChange: (patch: Partial<ConversionOptions>) => void;
  /** Форматы добавленных файлов — определяют видимость полей. */
  inputFormats: string[];
  disabled?: boolean;
}

export function OptionsPanel({
  outputType,
  onOutputTypeChange,
  options,
  onOptionsChange,
  inputFormats,
  disabled = false,
}: OptionsPanelProps) {
  const outputId = useId();
  const regionId = useId();
  const passwordId = useId();
  const codePageId = useId();
  const delimiterId = useId();
  const orientationId = useId();
  const fitToWidthId = useId();
  const placeholdersId = useId();

  const showCodePage = inputFormats.some((format) => TEXT_INPUT_FORMATS.has(format));
  const showDelimiter = inputFormats.includes(CSV_FORMAT);
  const showSpreadsheet = inputFormats.some((format) =>
    SPREADSHEET_INPUT_FORMATS.has(format)
  );

  return (
    <form className="options" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="options__group" disabled={disabled}>
        <legend>Результат</legend>

        <div className="field">
          <label htmlFor={outputId}>Формат результата</label>
          <select
            id={outputId}
            name="outputtype"
            value={outputType}
            onChange={(event) => onOutputTypeChange(event.target.value)}
          >
            {OUTPUT_FORMATS.map((format) => (
              <option key={format} value={format}>
                {OUTPUT_FORMAT_LABELS[format] ?? format}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={regionId}>Регион</label>
          <input
            id={regionId}
            name="region"
            type="text"
            placeholder="ru-RU"
            pattern="[A-Za-z]{2}(-[A-Za-z]{2})?"
            defaultValue={options.region ?? ''}
            onChange={(event) =>
              onOptionsChange({ region: event.target.value || undefined })
            }
          />
          <span className="field__hint">Влияет на форматы дат и чисел. Вид: ru-RU</span>
        </div>

        <div className="field">
          <label htmlFor={passwordId}>Пароль документа</label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="off"
            onChange={(event) =>
              onOptionsChange({ password: event.target.value || undefined })
            }
          />
          <span className="field__hint">
            Заполняйте, только если исходный файл защищён паролем
          </span>
        </div>
      </fieldset>

      {showCodePage || showDelimiter ? (
        <fieldset className="options__group" disabled={disabled}>
          <legend>Текстовые файлы</legend>

          {showCodePage ? (
            <div className="field">
              <label htmlFor={codePageId}>Кодировка исходного файла</label>
              <select
                id={codePageId}
                name="codePage"
                defaultValue={options.codePage ?? 65001}
                onChange={(event) =>
                  onOptionsChange({ codePage: Number(event.target.value) })
                }
              >
                {CODE_PAGES.map((codePage) => (
                  <option key={codePage.value} value={codePage.value}>
                    {codePage.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {showDelimiter ? (
            <div className="field">
              <label htmlFor={delimiterId}>Разделитель CSV</label>
              <select
                id={delimiterId}
                name="delimiter"
                defaultValue={options.delimiter ?? 2}
                onChange={(event) =>
                  onOptionsChange({ delimiter: Number(event.target.value) })
                }
              >
                {DELIMITERS.map((delimiter) => (
                  <option key={delimiter.value} value={delimiter.value}>
                    {delimiter.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {showSpreadsheet ? (
        <fieldset className="options__group" disabled={disabled}>
          <legend>Параметры листа</legend>

          <div className="field">
            <label htmlFor={orientationId}>Ориентация</label>
            <select
              id={orientationId}
              name="orientation"
              defaultValue={options.spreadsheetLayout?.orientation ?? ''}
              onChange={(event) => {
                const value = event.target.value;

                onOptionsChange({
                  spreadsheetLayout: {
                    ...options.spreadsheetLayout,
                    orientation: value === '' ? undefined : (value as 'portrait' | 'landscape'),
                  },
                });
              }}
            >
              <option value="">Как в документе</option>
              <option value="portrait">Книжная</option>
              <option value="landscape">Альбомная</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor={fitToWidthId}>Уместить по ширине страниц</label>
            <input
              id={fitToWidthId}
              name="fitToWidth"
              type="number"
              min={1}
              max={99}
              inputMode="numeric"
              defaultValue={options.spreadsheetLayout?.fitToWidth ?? ''}
              onChange={(event) => {
                const value = Number(event.target.value);

                onOptionsChange({
                  spreadsheetLayout: {
                    ...options.spreadsheetLayout,
                    fitToWidth: Number.isFinite(value) && value > 0 ? value : undefined,
                  },
                });
              }}
            />
            <span className="field__hint">
              Пусто — не масштабировать. Значение 1 умещает таблицу в одну страницу
            </span>
          </div>
        </fieldset>
      ) : null}

      <fieldset className="options__group" disabled={disabled}>
        <legend>Документ</legend>

        <div className="checkbox">
          <input
            id={placeholdersId}
            name="drawPlaceHolders"
            type="checkbox"
            defaultChecked={options.documentLayout?.drawPlaceHolders ?? false}
            onChange={(event) =>
              onOptionsChange({
                documentLayout: {
                  ...options.documentLayout,
                  drawPlaceHolders: event.target.checked,
                },
              })
            }
          />
          <label htmlFor={placeholdersId}>Показывать рамки полей ввода</label>
        </div>
      </fieldset>
    </form>
  );
}
