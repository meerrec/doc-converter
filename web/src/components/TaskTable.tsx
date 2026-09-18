/**
 * Таблица задач конвертации.
 */

import { useCallback } from 'react';
import { TaskRow } from './TaskRow';
import { pluralize } from '../lib/format';
import type { ConversionQueue } from '../hooks/useConversionQueue';

interface TaskTableProps {
  queue: ConversionQueue;
  /** Отключает действия, пока идёт отправка. */
  busy: boolean;
}

export function TaskTable({ queue, busy }: TaskTableProps) {
  const { items, stats, downloadItem, retryItem, removeItem } = queue;

  // Зависимости — отдельные функции, а не объект queue: сам объект
  // создаётся заново на каждом рендере, и колбэки на его основе теряли бы
  // идентичность, обнуляя memo у строк таблицы
  const handleDownload = useCallback((id: string) => downloadItem(id), [downloadItem]);

  const handleRetry = useCallback((id: string) => retryItem(id), [retryItem]);

  const handleRemove = useCallback((id: string) => removeItem(id), [removeItem]);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="tasks" aria-label="Задачи конвертации">
      <header className="tasks__header">
        <h2 className="tasks__title">
          {stats.total} {pluralize(stats.total, ['файл', 'файла', 'файлов'])}
        </h2>

        <div className="tasks__summary" aria-live="polite">
          {stats.active > 0 ? <span>В работе: {stats.active}</span> : null}
          {stats.pending > 0 ? <span>Ожидают: {stats.pending}</span> : null}
          {stats.completed > 0 ? <span>Готово: {stats.completed}</span> : null}
          {stats.failed > 0 ? <span className="tasks__failed">Ошибок: {stats.failed}</span> : null}
        </div>

        <div className="tasks__buttons">
          <button
            type="button"
            className="button button--secondary"
            onClick={queue.clearFinished}
            disabled={stats.completed === 0}
          >
            Очистить готовые
          </button>

          <button
            type="button"
            className="button"
            onClick={queue.downloadAll}
            disabled={stats.completed === 0}
          >
            Скачать все
          </button>
        </div>
      </header>

      <table className="table">
        <caption className="visually-hidden">
          Список файлов, поставленных на конвертацию
        </caption>
        <thead>
          <tr>
            <th scope="col">Файл</th>
            <th scope="col">Состояние</th>
            <th scope="col">Прогресс</th>
            <th scope="col">Действия</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <TaskRow
              key={item.id}
              item={item}
              onDownload={handleDownload}
              onRetry={handleRetry}
              onRemove={handleRemove}
            />
          ))}
        </tbody>
      </table>

      {busy ? (
        <p className="tasks__notice" role="status">
          Идёт отправка файлов. Закрытие страницы прервёт загрузку.
        </p>
      ) : null}
    </section>
  );
}
