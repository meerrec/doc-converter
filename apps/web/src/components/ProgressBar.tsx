/**
 * Полоса прогресса задачи.
 *
 * Построена на нативном элементе <progress>: он сам сообщает
 * вспомогательным технологиям значение и не требует ARIA-разметки.
 *
 * Сервер не отдаёт прогресс в процентах — известно только состояние задачи,
 * поэтому полоса почти всегда показывается без значения (нативный
 * «неопределённый» режим): он честно говорит «работа идёт», тогда как
 * выдуманный процент пришлось бы объяснять пользователю.
 */

import { memo } from 'react';

interface ProgressBarProps {
  /** Прогресс в процентах (0–100); без значения полоса неопределённая. */
  value?: number;
  /** Подпись для скринридеров. */
  label: string;
}

export const ProgressBar = memo(function ProgressBar({ value, label }: ProgressBarProps) {
  const safeValue =
    value === undefined ? undefined : Math.min(100, Math.max(0, Math.round(value)));

  if (safeValue === undefined) {
    return <progress className="progress" aria-label={label} />;
  }

  return <progress className="progress" value={safeValue} max={100} aria-label={label} />;
});
