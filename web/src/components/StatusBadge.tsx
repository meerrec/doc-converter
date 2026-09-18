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
 * Состояния очереди BullMQ (`waiting`, `active`, `delayed` и прочие) попадают
 * сюда потому, что сервер отдаёт их как есть, когда задачи нет в Valkey,
 * но она есть в очереди. Показывать пользователю английские имена нельзя,
 * поэтому для них заведены подписи. Правильнее было бы не выпускать
 * внутренние состояния очереди наружу — это задача серверной стороны.
 */
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
  error: 'Ошибка',
  cancelled: 'Отменена',

  // Состояния очереди BullMQ
  waiting: 'Ожидает обработки',
  active: 'Конвертация',
  delayed: 'Отложена',
  paused: 'Приостановлена',
  prioritized: 'В очереди',
  'waiting-children': 'Ожидает зависимостей',
  stuck: 'Зависла',
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
