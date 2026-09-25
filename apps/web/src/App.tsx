/**
 * Главный экран конвертера документов в PDF.
 *
 * Файлы выбираются один раз, а способ конвертации выбирается для каждого
 * файла отдельно — кнопкой в его строке. Маршрутов два: серверный (очередь
 * воркеров, файл уходит на сервер) и браузерный (сборка LibreOffice в этой
 * вкладке, файл не покидает компьютер). Плюс предпросмотр, который показывает
 * документ в окне офиса и маршрута не занимает: он не конвертирует файл.
 *
 * Все сетевые операции выполняет хук очереди — компонент отвечает
 * только за ввод и отображение.
 */

import { useCallback, useEffect, useState } from 'react';
import { isHealthResponse } from '@doc-converter/contract/health';
import type { ConversionOptions, HealthResponse } from '@doc-converter/contract';
import { DropZone } from './components/DropZone';
import { OfficePanel } from './components/OfficePanel';
import { OptionsPanel } from './components/OptionsPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { TaskTable } from './components/TaskTable';
import { useConversionQueue, type RejectedFile } from './hooks/useConversionQueue';
import { useOfficeState } from './hooks/useOfficeState';
import { openOffice } from './office';
import { request } from './api/client';
import { DEFAULT_CONVERSION_OPTIONS, MAX_VISIBLE_REJECTIONS } from './config';
import { pluralize } from './lib/format';

/** Состояние доступности сервиса. */
type HealthState =
  | { kind: 'checking' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'unavailable' };

export function App() {
  const [options, setOptions] = useState<ConversionOptions>(DEFAULT_CONVERSION_OPTIONS);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });

  const queue = useConversionQueue({ options });
  const { addFiles, startAll, cancelAll, stats, preview } = queue;
  const office = useOfficeState();

  useEffect(() => {
    const controller = new AbortController();

    request<HealthResponse>('/health', {
      signal: controller.signal,
      guard: isHealthResponse,
    })
      .then((data) => setHealth({ kind: 'ok', data }))
      .catch((error: unknown) => {
        // Отмена при уходе со страницы — не признак недоступности сервиса
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setHealth({ kind: 'unavailable' });
      });

    return () => controller.abort();
  }, []);

  /** Обрабатывает выбранные файлы. */
  const handleFiles = useCallback(
    (files: File[]) => {
      setRejected(addFiles(files));
    },
    [addFiles]
  );

  /** Обновляет параметры конвертации. */
  const handleOptionsChange = useCallback((patch: Partial<ConversionOptions>) => {
    setOptions((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * Загружает офис по кнопке.
   *
   * Провал не пробрасывается: он терминален и уже записан в состоянии офиса,
   * откуда его показывает панель. Необработанный отказ здесь попал бы
   * в консоль и в сборщик ошибок как «что-то сломалось», ничего не добавив.
   */
  const handleLoadOffice = useCallback(() => {
    void openOffice().catch(() => undefined);
  }, []);

  const isBusy = stats.pending > 0 || stats.active > 0;
  const storageDown = health.kind === 'ok' && !health.data.storage;

  // Имя файла для подписи в панели предпросмотра: состояние предпросмотра
  // хранит идентификатор строки, а показывать нужно имя
  const previewed =
    preview === null ? null : (queue.items.find((item) => item.id === preview.itemId) ?? null);

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Конвертер документов в PDF</h1>
        <p className="page__subtitle">
          Книги Excel и документы Word превращаются в PDF средствами LibreOffice. На сервере —
          очередью воркеров, в браузере — в этой вкладке, без отправки файла. Предпросмотр
          показывает документ до конвертации.
        </p>

        {health.kind === 'unavailable' ? (
          <p className="alert alert--error" role="alert">
            Сервис конвертации недоступен. Проверьте, запущены ли API и воркер.
          </p>
        ) : null}

        {storageDown ? (
          <p className="alert alert--warning" role="alert">
            Хранилище результатов недоступно: задачи не принимаются, а готовые
            ссылки могут не открываться.
          </p>
        ) : null}
      </header>

      <main className="page__main">
        <div className="panel">
          <DropZone onFiles={handleFiles} />

          {rejected.length > 0 ? (
            <ul className="alert alert--warning" role="alert">
              {rejected.slice(0, MAX_VISIBLE_REJECTIONS).map((entry) => (
                <li key={entry.id}>{entry.message}</li>
              ))}

              {rejected.length > MAX_VISIBLE_REJECTIONS ? (
                <li>
                  и ещё {rejected.length - MAX_VISIBLE_REJECTIONS}{' '}
                  {pluralize(rejected.length - MAX_VISIBLE_REJECTIONS, [
                    'файл',
                    'файла',
                    'файлов',
                  ])}
                </li>
              ) : null}
            </ul>
          ) : null}

          {/* Панель остаётся доступной и во время обработки: параметры
              запоминаются для каждой задачи в момент запуска, поэтому
              их можно спокойно готовить для следующей пачки */}
          <OptionsPanel options={options} onOptionsChange={handleOptionsChange} />

          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              onClick={startAll}
              disabled={stats.pending === 0}
            >
              Конвертировать все на сервере
              {stats.pending > 0 ? ` (${stats.pending})` : ''}
            </button>

            <button
              type="button"
              className="button button--secondary"
              onClick={cancelAll}
              disabled={!isBusy}
            >
              Отменить
            </button>
          </div>

          <p className="actions__hint">
            Задачи, уже принятые сервером, отменить нельзя — воркер доведёт их
            до конца. Отмена прерывает только подготовку и отправку файлов.
          </p>
        </div>

        <OfficePanel state={office} onLoad={handleLoadOffice} />

        <PreviewPanel
          fileName={previewed?.file.name ?? null}
          sheets={preview?.sheets ?? null}
          busy={office.kind === 'loading'}
          onClose={queue.closePreview}
        />

        <TaskTable queue={queue} officeFailed={office.kind === 'failed'} />
      </main>

      <footer className="page__footer">
        {health.kind === 'ok' ? <>Версия сервиса: {health.data.version}. </> : null}
      </footer>
    </div>
  );
}
