/**
 * Главный экран конвертера.
 *
 * Собирает зону выбора файлов, панель параметров и таблицу задач.
 * Все сетевые операции выполняет хук очереди — компонент отвечает
 * только за ввод и отображение.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { DropZone } from './components/DropZone';
import { OptionsPanel } from './components/OptionsPanel';
import { TaskTable } from './components/TaskTable';
import { useConversionQueue } from './hooks/useConversionQueue';
import { request } from './api/client';
import { detectInputFormat } from './lib/format';
import {
  CSV_FORMAT,
  spreadsheetInputFormatSet,
  textInputFormatSet,
} from '@doc-converter/contract';
import type { ConversionOptions, HealthResponse } from '@doc-converter/contract';

/** Состояние доступности сервиса. */
type HealthState = 'checking' | 'ok' | 'unavailable';

export function App() {
  const [outputType, setOutputType] = useState('pdf');
  const [options, setOptions] = useState<ConversionOptions>({});
  const [rejected, setRejected] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthState>('checking');

  // Обновление списка файлов и переключение параметров не должны
  // блокировать ввод — помечаем их как непрерывные обновления
  const [isPending, startTransition] = useTransition();

  const queue = useConversionQueue({ outputType, options });
  const { addFiles, startAll, cancelAll, stats } = queue;

  useEffect(() => {
    const controller = new AbortController();

    request<HealthResponse>('/health', { signal: controller.signal })
      .then(() => setHealth('ok'))
      .catch(() => setHealth('unavailable'));

    return () => controller.abort();
  }, []);

  /** Обрабатывает выбранные файлы. */
  const handleFiles = useCallback(
    (files: File[]) => {
      startTransition(() => {
        setRejected(addFiles(files));
      });
    },
    [addFiles]
  );

  /** Меняет формат результата. */
  const handleOutputTypeChange = useCallback((value: string) => {
    startTransition(() => setOutputType(value));
  }, []);

  /** Обновляет опции конвертации. */
  const handleOptionsChange = useCallback((patch: Partial<ConversionOptions>) => {
    setOptions((current) => ({ ...current, ...patch }));
  }, []);

  // Форматы добавленных файлов определяют, какие поля опций показывать.
  //
  // Наружу отдаём булевы флаги, а не список форматов: список — это новый
  // массив на каждом обновлении прогресса, и он обнулял бы memo у панели
  // опций, заставляя её перерисовываться на каждом тике опроса
  const optionFields = useMemo(() => {
    let showCodePage = false;
    let showDelimiter = false;
    let showSpreadsheet = false;

    for (const item of queue.items) {
      const format = detectInputFormat(item.file.name);

      if (!format) {
        continue;
      }

      showCodePage ||= textInputFormatSet.has(format);
      showDelimiter ||= format === CSV_FORMAT;
      showSpreadsheet ||= spreadsheetInputFormatSet.has(format);
    }

    return { showCodePage, showDelimiter, showSpreadsheet };
  }, [queue.items]);

  const isBusy = stats.pending > 0 || stats.active > 0;

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Конвертер документов</h1>
        <p className="page__subtitle">
          Документы, таблицы и презентации в PDF и другие форматы. Обработка идёт
          на сервере, файлы не покидают ваш контур.
        </p>

        {health === 'unavailable' ? (
          <p className="alert alert--error" role="alert">
            Сервис конвертации недоступен. Проверьте, запущены ли API и воркер.
          </p>
        ) : null}
      </header>

      <main className="page__main">
        <div className="panel">
          <DropZone onFiles={handleFiles} disabled={false} />

          {rejected.length > 0 ? (
            <ul className="alert alert--warning" role="alert">
              {rejected.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}

          <OptionsPanel
            outputType={outputType}
            onOutputTypeChange={handleOutputTypeChange}
            options={options}
            onOptionsChange={handleOptionsChange}
            showCodePage={optionFields.showCodePage}
            showDelimiter={optionFields.showDelimiter}
            showSpreadsheet={optionFields.showSpreadsheet}
            disabled={isBusy}
          />

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
            Уже отправленные задачи отменить нельзя — сервер обработает их до конца.
            Отмена прерывает только подготовку и отправку файлов.
          </p>
        </div>

        <TaskTable queue={queue} busy={isPending} />
      </main>
    </div>
  );
}
