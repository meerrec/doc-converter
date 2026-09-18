/**
 * Бейдж состояния задачи.
 *
 * Состояние передаётся не только цветом, но и текстом — так оно
 * различимо при дальтонизме и читается скринридером.
 */

import { memo } from 'react';
import type { QueueItemStatus } from '../hooks/useConversionQueue';

/** Тексты состояний. */
const STATUS_LABELS: Record<QueueItemStatus, string> = {
  pending: 'В очереди',
  encoding: 'Подготовка',
  uploading: 'Отправка',
  queued: 'Ожидает обработки',
  processing: 'Конвертация',
  completed: 'Готово',
  failed: 'Ошибка',
  unknown: 'Ожидание',
  not_found: 'Не найдена',
  cancelled: 'Отменена',
};

interface StatusBadgeProps {
  status: QueueItemStatus;
}

export const StatusBadge = memo(function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge--${status}`} data-status={status}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
});
