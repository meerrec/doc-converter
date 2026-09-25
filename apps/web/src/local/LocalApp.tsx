/**
 * Браузерная конвертация: предпросмотр документа и экспорт PDF.
 *
 * Здесь нет ни одного обращения к нашему серверу: файл читается из памяти
 * браузера, конвертируется сборкой LibreOffice в воркере и отдаётся
 * на скачивание. Сервер об этом не узнаёт — в этом и смысл страницы.
 *
 * Состояния идут последовательно, и каждое из них длится заметное время,
 * поэтому их видно словами, а не только полосой: `idle` → `loading` (скачивание
 * сборки) → `ready` → `opening` (предпросмотр) или `converting` (экспорт).
 *
 * Порядок работы с файлом повторяет серверный: документ открывается скрыто
 * и экспортируется тем же набором параметров (`filterData.ts`), а в браузере
 * дополнительно показывается в окне офиса — предпросмотр. Если документ уже
 * открыт для предпросмотра, конвертация использует его же: открытие — самая
 * дорогая операция, и повторять её ради экспорта незачем.
 *
 * Все комментарии на русском языке.
 */

import { useCallback, useRef, useState } from 'react';
import type { ConversionOptions } from '@doc-converter/contract';
import { DropZone } from '../components/DropZone';
import { OptionsPanel } from '../components/OptionsPanel';
import { ProgressBar } from '../components/ProgressBar';
import { DEFAULT_CONVERSION_OPTIONS } from '../config';
import { boot } from './lowa/boot';
import { MAX_FILE_BYTES, MIN_OUTPUT_BYTES } from './lowa/constants';
import { buildFilterData } from './lowa/filterData';
import { LOCAL_FORMATS, exportFilterFor } from './lowa/filters';
import { preloadAssets, type PreloadProgress } from './lowa/preload';
import { LocalError, type LocalSession } from './lowa/session';
import type { LocalErrorCode } from './lowa/protocol';

/**
 * Путь входного файла в файловой системе сборки.
 *
 * Имя обезличено намеренно: расширение нужно (по нему офис выбирает
 * импортёр), а остальное — пользовательское имя файла — в виртуальной
 * файловой системе ни к чему, и подставлять его в путь значило бы
 * протаскивать ввод туда, где он не проверяется.
 */
const INPUT_BASE = '/tmp/source';

/** Путь результата в той же файловой системе. */
const OUTPUT_PATH = '/tmp/result.pdf';

/** Что происходит на странице. */
type Phase = 'idle' | 'loading' | 'ready' | 'opening' | 'converting';

/**
 * Что показать пользователю при отказе.
 *
 * Коды приходят из обвязки (`protocol.ts`), и каждый означает разное:
 * «не хватило памяти» лечится меньшим документом, «не загрузился офис» —
 * повторной попыткой, и сводить их к одному «ошибка» значит лишать
 * пользователя единственной подсказки, что делать.
 */
const ERROR_MESSAGES: Readonly<Record<LocalErrorCode, string>> = {
  lowa_boot_failed: 'Не удалось загрузить офис. Обновите страницу и попробуйте снова.',
  lowa_load_failed: 'Документ не открылся: возможно, файл повреждён или это не Excel и не Word.',
  lowa_export_failed: 'Не удалось сохранить PDF. Проверьте параметры экспорта.',
  lowa_oom:
    'Не хватило памяти браузера. Закройте лишние вкладки или возьмите документ поменьше — эта операция выполняется на вашем устройстве.',
  lowa_timeout: 'Операция заняла слишком много времени и была прервана.',
  lowa_unavailable: 'Офис в браузере недоступен. Обновите страницу.',
};

/** Размер сборки, который скачивается при запуске, в мегабайтах. */
const OFFICE_SIZE_MB = 78;

/**
 * Приводит исключение к тексту для пользователя.
 *
 * @param error - пойманное исключение
 * @returns сообщение
 */
function describeError(error: unknown): string {
  if (error instanceof LocalError) {
    return ERROR_MESSAGES[error.code];
  }

  return error instanceof Error ? error.message : String(error);
}

/** Как называется файл в интерфейсе. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function LocalApp() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<PreloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [options, setOptions] = useState<ConversionOptions>(DEFAULT_CONVERSION_OPTIONS);
  const [sheets, setSheets] = useState<number | null>(null);
  const [resultBytes, setResultBytes] = useState<number | null>(null);

  const sessionRef = useRef<LocalSession | null>(null);
  const preparedPathRef = useRef<string | null>(null);

  const busy = phase === 'loading' || phase === 'opening' || phase === 'converting';

  /**
   * Поднимает офис: скачивает сборку и запускает её.
   *
   * Скачивание отдельным шагом, потому что это единственное место, где виден
   * прогресс: сама сборка грузит свои файлы молча, и отличить работу
   * от зависания было бы нечем.
   */
  const startOffice = useCallback(async () => {
    setPhase('loading');
    setError(null);

    try {
      const assets = await preloadAssets('/local/lowa/', setProgress);

      sessionRef.current = await boot({
        canvas: document.getElementById('qtcanvas') as HTMLCanvasElement,
        assetsUrl: '/local/lowa/',
        runtimeUrl: '/local/uno/runtime.js',
        bridgeUrl: '/local/bridge.js',
        assets,
      });

      setPhase('ready');
    } catch (failure) {
      setError(describeError(failure));
      setPhase('idle');
    } finally {
      setProgress(null);
    }
  }, []);

  /**
   * Принимает выбранный файл.
   *
   * Проверки здесь — про возможности браузерного пути, а не про безопасность:
   * файл никуда не отправляется, и защищать от него некого. Размер ограничен
   * памятью вкладки, расширение — тем, что вообще умеет офис.
   */
  const handleFiles = useCallback((files: File[]) => {
    const [selected] = files;

    setFileError(null);
    setSheets(null);
    setResultBytes(null);

    if (selected === undefined) {
      return;
    }

    if (exportFilterFor(selected.name) === null) {
      setFileError(`Поддерживаются файлы ${LOCAL_FORMATS.join(' и ').toUpperCase()}.`);
      setFile(null);

      return;
    }

    if (selected.size > MAX_FILE_BYTES) {
      setFileError(
        `Файл больше ${formatBytes(MAX_FILE_BYTES)}: конвертация идёт в памяти браузера, и такой документ её исчерпает.`
      );
      setFile(null);

      return;
    }

    // Документ сменился — прежний в файловой системе сборки больше не нужен
    preparedPathRef.current = null;
    setFile(selected);
  }, []);

  /**
   * Кладёт выбранный файл в файловую систему сборки.
   *
   * @param selected - выбранный файл
   * @returns путь файла в файловой системе сборки
   */
  const prepare = useCallback(async (selected: File): Promise<string> => {
    const session = sessionRef.current;

    if (session === null) {
      throw new LocalError('lowa_unavailable', 'офис не запущен');
    }

    const extension = selected.name.slice(selected.name.lastIndexOf('.') + 1).toLowerCase();
    const path = `${INPUT_BASE}.${extension}`;

    if (preparedPathRef.current !== path) {
      session.writeFile(path, new Uint8Array(await selected.arrayBuffer()));
      preparedPathRef.current = path;
    }

    return path;
  }, []);

  /** Открывает документ в окне предпросмотра. */
  const openPreview = useCallback(async () => {
    if (file === null) {
      return;
    }

    setPhase('opening');
    setError(null);

    try {
      const path = await prepare(file);
      const preview = await sessionRef.current?.preview(path);

      setSheets(preview?.sheets ?? null);
      setPhase('ready');
    } catch (failure) {
      setError(describeError(failure));
      setPhase('ready');
    }
  }, [file, prepare]);

  /** Конвертирует документ и отдаёт готовый PDF на скачивание. */
  const convert = useCallback(async () => {
    if (file === null) {
      return;
    }

    const filterName = exportFilterFor(file.name);

    if (filterName === null) {
      return;
    }

    setPhase('converting');
    setError(null);
    setResultBytes(null);

    try {
      const session = sessionRef.current;
      const path = await prepare(file);

      await session?.convert({
        source: path,
        target: OUTPUT_PATH,
        filterName,
        filterData: buildFilterData(options),
        // Подгонка под страницу — свойство страничного стиля Calc, у документа
        // Word его нет (серверный путь правит их так же)
        scaleToPages: options.fitToOnePage && filterName === 'calc_pdf_Export',
      });

      const bytes = session?.readFile(OUTPUT_PATH) ?? new Uint8Array();

      if (bytes.byteLength < MIN_OUTPUT_BYTES) {
        throw new LocalError('lowa_export_failed', 'экспортёр вернул пустой файл');
      }

      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
      const link = document.createElement('a');

      link.href = url;
      link.download = `${file.name.replace(/\.[^.]+$/, '')}.pdf`;
      link.click();

      // Адрес освобождается следующим тиком, а не сразу: скачивание
      // начинается асинхронно, и немедленный отзыв может оборвать его
      // раньше, чем браузер прочитает данные
      setTimeout(() => URL.revokeObjectURL(url), 0);

      session?.removeFile(OUTPUT_PATH);

      setResultBytes(bytes.byteLength);
      setPhase('ready');
    } catch (failure) {
      setError(describeError(failure));
      setPhase('ready');
    }
  }, [file, options, prepare]);

  return (
    <div className="page">
      <h1 className="page__title">Конвертация в браузере</h1>
      <p className="page__subtitle">
        Документ не отправляется на сервер: LibreOffice работает в этой вкладке,
        и файл остаётся у вас. Готовый PDF можно скачать сразу.
      </p>

      <main className="page__main">
        {phase === 'idle' && (
          <>
            {/* Canvas пуст до первого предпросмотра, и без подписи выглядел бы
                сломанным изображением */}
            <p className="preview__hint">
              Здесь появится документ — после загрузки офиса и нажатия
              «Показать документ».
            </p>

            <section className="panel">
              <h2 className="tasks__title">Сначала — офис</h2>
              <p className="field__hint">
                Для конвертации нужно скачать сборку LibreOffice в браузер: около{' '}
                {OFFICE_SIZE_MB} МБ сжатых данных. Дальше она останется в кеше браузера,
                и следующий запуск будет быстрым.
              </p>

              <div className="actions">
                <button type="button" className="button button--primary" onClick={startOffice}>
                  Загрузить офис
                </button>
              </div>
            </section>
          </>
        )}

        {phase === 'loading' && (
          <section className="panel">
            <h2 className="tasks__title">Загрузка офиса</h2>
            <ProgressBar
              value={
                progress?.totalBytes ? (progress.loadedBytes / progress.totalBytes) * 100 : undefined
              }
              label="Загрузка сборки LibreOffice"
            />
            <p className="field__hint">
              Получено {formatBytes(progress?.loadedBytes ?? 0)}
              {progress?.totalBytes ? ` из ${formatBytes(progress.totalBytes)}` : ''}
            </p>
          </section>
        )}

        {phase !== 'idle' && phase !== 'loading' && (
          <>
            <section className="panel">
              <DropZone
                onFiles={handleFiles}
                disabled={busy}
                maxBytes={MAX_FILE_BYTES}
                formats={LOCAL_FORMATS}
              />

              {fileError !== null && <p className="alert alert--error">{fileError}</p>}

              {file !== null && (
                <>
                  <p className="field__hint">
                    {file.name} — {formatBytes(file.size)}
                    {sheets !== null ? `, листов: ${sheets}` : ''}
                  </p>

                  <div className="actions">
                    <button
                      type="button"
                      className="button"
                      onClick={openPreview}
                      disabled={busy}
                    >
                      {phase === 'opening' ? 'Открываю…' : 'Показать документ'}
                    </button>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={convert}
                      disabled={busy}
                    >
                      {phase === 'converting' ? 'Конвертирую…' : 'Скачать PDF'}
                    </button>
                  </div>

                  {resultBytes !== null && (
                    <p className="field__hint">Готово: {formatBytes(resultBytes)}</p>
                  )}
                </>
              )}

              {error !== null && <p className="alert alert--error">{error}</p>}
            </section>

            <section className="panel">
              <OptionsPanel
                options={options}
                onOptionsChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
                disabled={busy}
              />
            </section>
          </>
        )}
      </main>

      <footer className="page__footer">
        <p className="page__subtitle">
          Предпросмотр — окно самого офиса. Строку формул и боковую панель в нём
          скрыть не удалось: это ограничение сборки, а не страницы. Результат
          экспорта от них не зависит.
        </p>
      </footer>
    </div>
  );
}
