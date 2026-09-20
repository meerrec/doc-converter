/**
 * Строка таблицы задач.
 *
 * Обёрнута в memo: при обновлении состояния одной задачи перерисовываются
 * только изменившиеся строки, а не весь список.
 */

import { memo } from 'react';
import { StatusBadge } from './StatusBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes, formatClockTime, formatDuration, pluralize } from '../lib/format';
import { TIER_LABELS } from '../config';
import type { QueueItem } from '../hooks/useConversionQueue';

interface TaskRowProps {
  item: QueueItem;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export const TaskRow = memo(function TaskRow({ item, onRetry, onRemove }: TaskRowProps) {
  const isWorking =
    item.status === 'submitting' ||
    item.status === 'queued' ||
    item.status === 'processing';

  const parts: string[] = [
    item.result
      ? `${formatBytes(item.size)} → ${formatBytes(item.result.sizeBytes)}`
      : `${formatBytes(item.size)} → PDF`,
  ];

  if (item.tier) {
    parts.push(`уровень: ${TIER_LABELS[item.tier].toLowerCase()}`);
  }

  if (typeof item.sheets === 'number') {
    parts.push(`${item.sheets} ${pluralize(item.sheets, ['лист', 'листа', 'листов'])}`);
  }

  // Ссылка на результат живёт ограниченное время: сервер подписывает её
  // на час, поэтому срок показывается рядом с кнопкой, а после истечения
  // скачивание предлагается повторить
  const expiresAt = item.result ? Date.parse(item.result.expiresAt) : Number.NaN;
  const isExpired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
  const expiresLabel = item.result ? formatClockTime(item.result.expiresAt) : null;

  // Скачивать есть что только у завершённой задачи с неистёкшей ссылкой
  const canDownload =
    item.status === 'completed' && item.result !== undefined && !isExpired;

  const elapsed =
    isWorking && item.submittedAt !== undefined
      ? formatDuration((Date.now() - item.submittedAt) / 1000)
      : null;

  return (
    <tr className="task">
      <td className="task__name">
        <span className="task__file" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="task__meta">{parts.join(' · ')}</span>
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
          <>
            <ProgressBar label={`Конвертация ${item.file.name}`} />
            {elapsed ? <span className="task__meta">идёт {elapsed}</span> : null}
          </>
        ) : null}
      </td>

      <td className="task__actions">
        {canDownload ? (
          <a
            className="button button--link"
            href={item.result?.url}
            download={item.downloadName}
            target="_blank"
            rel="noopener noreferrer"
          >
            Скачать
          </a>
        ) : null}

        {canDownload && expiresLabel ? (
          <span className="task__meta">ссылка действует до {expiresLabel}</span>
        ) : null}

        {item.status === 'completed' && !canDownload ? (
          <span className="task__meta">
            Ссылка на файл истекла — запустите конвертацию заново
          </span>
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
