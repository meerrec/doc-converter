/**
 * Полоса прогресса задачи.
 *
 * Построена на нативном элементе <progress>: он сам сообщает
 * вспомогательным технологиям значение и не требует ARIA-разметки.
 */

import { memo } from 'react';

interface ProgressBarProps {
  /** Прогресс в процентах (0–100). */
  value: number;
  /** Подпись для скринридеров. */
  label: string;
}

export const ProgressBar = memo(function ProgressBar({ value, label }: ProgressBarProps) {
  const safeValue = Math.min(100, Math.max(0, Math.round(value)));

  return (
    <progress
      className="progress"
      value={safeValue}
      max={100}
      aria-label={label}
    />
  );
});
