/**
 * Строка таблицы задач.
 *
 * Обёрнута в memo: при обновлении прогресса одной задачи перерисовываются
 * только изменившиеся строки, а не весь список.
 */

import { memo } from 'react';
import { StatusBadge } from './StatusBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes } from '../lib/format';
import type { QueueItem } from '../hooks/useConversionQueue';

interface TaskRowProps {
  item: QueueItem;
  onDownload: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export const TaskRow = memo(function TaskRow({
  item,
  onDownload,
  onRetry,
  onRemove,
}: TaskRowProps) {
  const isWorking =
    item.status === 'encoding' ||
    item.status === 'uploading' ||
    item.status === 'queued' ||
    item.status === 'processing';

  return (
    <tr className="task">
      <td className="task__name">
        <span className="task__file" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="task__meta">
          {formatBytes(item.size)} → {item.outputType.toUpperCase()}
        </span>
        {item.errorText ? (
          <span className="task__error" role="alert">
            {item.errorText}
          </span>
        ) : null}
      </td>

      <td className="task__status">
        <StatusBadge status={item.status} />
      </td>

      <td className="task__progress">
        {isWorking ? (
          <ProgressBar value={item.progress} label={`Конвертация ${item.file.name}`} />
        ) : null}
      </td>

      <td className="task__actions">
        {item.status === 'completed' ? (
          <button type="button" className="button" onClick={() => onDownload(item.id)}>
            Скачать
          </button>
        ) : null}

        {item.status === 'failed' || item.status === 'cancelled' ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onRetry(item.id)}
          >
            Повторить
          </button>
        ) : null}

        {!isWorking ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onRemove(item.id)}
            aria-label={`Убрать ${item.file.name} из списка`}
          >
            Убрать
          </button>
        ) : null}
      </td>
    </tr>
  );
});
