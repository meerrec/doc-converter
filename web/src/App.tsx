/**
 * Главный экран конвертера XLSX → PDF.
 *
 * Собирает зону выбора файлов, панель параметров и таблицу задач.
 * Все сетевые операции выполняет хук очереди — компонент отвечает
 * только за ввод и отображение.
 */

import { useCallback, useEffect, useState } from 'react';
import { healthResponseSchema } from '@doc-converter/contract';
import type { ConversionOptions, HealthResponse } from '@doc-converter/contract';
import { DropZone } from './components/DropZone';
import { OptionsPanel } from './components/OptionsPanel';
import { TaskTable } from './components/TaskTable';
import { useConversionQueue } from './hooks/useConversionQueue';
import { request } from './api/client';
import { DEFAULT_CONVERSION_OPTIONS } from './config';

/** Состояние доступности сервиса. */
type HealthState =
  | { kind: 'checking' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'unavailable' };

export function App() {
  const [options, setOptions] = useState<ConversionOptions>(DEFAULT_CONVERSION_OPTIONS);
  const [rejected, setRejected] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });

  const queue = useConversionQueue({ options });
  const { addFiles, startAll, cancelAll, stats } = queue;

  useEffect(() => {
    const controller = new AbortController();

    request<HealthResponse>('/health', {
      signal: controller.signal,
      parse: (value) => healthResponseSchema.parse(value),
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

  const isBusy = stats.pending > 0 || stats.active > 0;
  const storageDown = health.kind === 'ok' && !health.data.storage;

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Конвертер Excel в PDF</h1>
        <p className="page__subtitle">
          Книги XLSX и XLS превращаются в PDF средствами LibreOffice на сервере.
          Файлы не покидают ваш контур.
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
              {rejected.map((message) => (
                <li key={message}>{message}</li>
              ))}
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
              Конвертировать
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

        <TaskTable queue={queue} />
      </main>

      {health.kind === 'ok' ? (
        <footer className="page__footer">
          Версия сервиса: {health.data.version}
        </footer>
      ) : null}
    </div>
  );
}
