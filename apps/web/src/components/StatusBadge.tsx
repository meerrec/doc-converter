/**
 * Бейдж состояния задачи.
 *
 * Состояние передаётся не только цветом, но и текстом — так оно
 * различимо при дальтонизме и читается скринридером.
 */

import { memo } from 'react';
import type { QueueItemStatus } from '../hooks/useConversionQueue';

/**
 * Тексты состояний.
 *
 * Серверных состояний ровно четыре (`queued`, `processing`, `completed`,
 * `failed`), остальные — локальные: файл ждёт отправки, отправляется
 * или его отправка отменена.
 */
const STATUS_LABELS: Readonly<Record<QueueItemStatus, string>> = {
  pending: 'Ожидает отправки',
  submitting: 'Отправка',
  queued: 'В очереди',
  processing: 'Конвертация',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменена',
};

interface StatusBadgeProps {
  status: QueueItemStatus;
}

export const StatusBadge = memo(function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge--${status}`} data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
});
