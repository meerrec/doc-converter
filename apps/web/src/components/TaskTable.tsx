/**
 * Таблица задач конвертации.
 */

import { useCallback } from 'react';
import { TaskRow } from './TaskRow';
import { pluralize } from '../lib/format';
import {
  isWorkingStatus,
  type ConversionQueue,
  type QueueItem,
  type QueueRoute,
} from '../hooks/useConversionQueue';

interface TaskTableProps {
  queue: ConversionQueue;
  /** Офис в браузере не запустился: браузерные действия строк недоступны. */
  officeFailed: boolean;
}

/**
 * Истёк ли срок действия ссылки на результат.
 *
 * @param item - задача очереди
 * @param now - текущее время на момент последнего такта часов
 * @returns true, если ссылка больше не действует
 */
function isResultExpired(item: QueueItem, now: number): boolean {
  // Срок есть только у серверной ссылки: браузерный результат лежит в памяти
  // вкладки и не истекает — он исчезает вместе со строкой
  if (item.result?.kind !== 'server') {
    return false;
  }

  const expiresAt = Date.parse(item.result.expiresAt);

  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Сколько секунд идёт конвертация.
 *
 * @param item - задача очереди
 * @param now - текущее время на момент последнего такта часов
 * @returns число секунд или null, если задача не в работе
 */
function elapsedSeconds(item: QueueItem, now: number): number | null {
  if (!isWorkingStatus(item.status) || item.submittedAt === undefined) {
    return null;
  }

  return (now - item.submittedAt) / 1000;
}

export function TaskTable({ queue, officeFailed }: TaskTableProps) {
  const { items, now, stats, retryItem, removeItem, runItem, previewItem, cancelItem } = queue;

  // Зависимости — отдельные функции, а не объект queue: сам объект
  // создаётся заново на каждом рендере, и колбэки на его основе теряли бы
  // идентичность, обнуляя memo у строк таблицы
  const handleRetry = useCallback((id: string) => retryItem(id), [retryItem]);

  const handleRemove = useCallback((id: string) => removeItem(id), [removeItem]);

  const handleRun = useCallback((id: string, route: QueueRoute) => runItem(id, route), [runItem]);

  const handlePreview = useCallback((id: string) => previewItem(id), [previewItem]);

  const handleCancel = useCallback((id: string) => cancelItem(id), [cancelItem]);

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
          {stats.cancelled > 0 ? <span>Отменено: {stats.cancelled}</span> : null}
          {stats.failed > 0 ? <span className="tasks__failed">Ошибок: {stats.failed}</span> : null}
        </div>

        <div className="tasks__buttons">
          <button
            type="button"
            className="button button--secondary"
            onClick={queue.clearFinished}
            disabled={stats.completed + stats.failed + stats.cancelled === 0}
          >
            Очистить завершённые
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
          {/* Зависящие от времени значения считаются здесь, а не в строке:
              время изменчиво, и чтение его внутри memo(TaskRow) либо лишило
              бы memo смысла, либо заморозило бы счётчик. Наружу отдаются
              производные — булев признак и число секунд, — поэтому строка
              перерисовывается только когда меняется что-то у неё самой:
              у готовых и отменённых задач эти пропсы стабильны. */}
          {items.map((item) => (
            <TaskRow
              key={item.id}
              item={item}
              isExpired={isResultExpired(item, now)}
              elapsedSeconds={elapsedSeconds(item, now)}
              officeFailed={officeFailed}
              onRun={handleRun}
              onPreview={handlePreview}
              onCancel={handleCancel}
              onRetry={handleRetry}
              onRemove={handleRemove}
            />
          ))}
        </tbody>
      </table>

      {stats.pending > 0 ? (
        <p className="tasks__notice" role="status">
          Идёт отправка файлов. Закрытие страницы прервёт загрузку.
        </p>
      ) : null}
    </section>
  );
}
