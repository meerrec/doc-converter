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
 * `failed`), остальные — локальные: файл ждёт отправки, отправляется,
 * его отправка отменена или его обрабатывает движок в браузере.
 *
 * У браузерного маршрута состояний четыре, а не одно: движок один и работает
 * по очереди, поэтому «ждёт», «грузится модуль движка», «идёт экспорт»
 * и «открывается предпросмотр» — это разные вещи с разным временем ожидания,
 * и свести их к «Конвертация» значило бы скрыть от пользователя, чего он ждёт.
 */
const STATUS_LABELS: Readonly<Record<QueueItemStatus, string>> = {
  pending: 'Ожидает отправки',
  submitting: 'Отправка',
  queued: 'В очереди',
  processing: 'Конвертация',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменена',
  'browser-waiting': 'Ждёт движок',
  'browser-loading': 'Загрузка движка',
  'browser-converting': 'Экспорт в браузере',
  'browser-previewing': 'Предпросмотр',
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
