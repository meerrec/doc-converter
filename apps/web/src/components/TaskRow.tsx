/**
 * Строка таблицы задач.
 *
 * Обёрнута в memo: при обновлении состояния одной задачи перерисовываются
 * только изменившиеся строки, а не весь список.
 *
 * В строке два равноправных маршрута и предпросмотр. Кнопки не прячутся
 * и не заменяют друг друга: пользователь выбирает способ для конкретного
 * файла, и выбор должен быть виден целиком. Недоступная кнопка объясняет
 * причину (`title` и подпись под именем файла), а не молчит — иначе три
 * кнопки в строке читаются как поломка.
 */

import { memo } from 'react';
import { browserFormatOf, MAX_FILE_BYTES } from '@doc-converter/office';
import { StatusBadge } from './StatusBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes, formatClockTime, formatDuration, pluralize } from '../lib/format';
import { TIER_LABELS } from '../config';
import {
  isBrowserStatus,
  isWorkingStatus,
  type QueueItem,
  type QueueRoute,
} from '../hooks/useConversionQueue';

interface TaskRowProps {
  item: QueueItem;
  /**
   * Истёк ли срок действия ссылки на результат.
   *
   * Считается в таблице, а не здесь: время — изменчивое значение, и чтение
   * его в рендере строки лишило бы memo смысла (см. TaskTable).
   */
  isExpired: boolean;
  /** Сколько секунд идёт конвертация; null — задача не в работе. */
  elapsedSeconds: number | null;
  /** Офис в браузере не запустился: браузерные действия недоступны. */
  officeFailed: boolean;
  onRun: (id: string, route: QueueRoute) => void;
  onPreview: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export const TaskRow = memo(function TaskRow({
  item,
  isExpired,
  elapsedSeconds,
  officeFailed,
  onRun,
  onPreview,
  onCancel,
  onRetry,
  onRemove,
}: TaskRowProps) {
  const isWorking = isWorkingStatus(item.status);

  // Браузерный маршрут ограничен возможностями вкладки, а не сервиса:
  // файл конвертируется в памяти браузера, и потолок у него свой (32 МиБ
  // против серверных 100 МиБ)
  const browserFormat = browserFormatOf(item.file.name);
  const tooLargeForBrowser = item.file.size > MAX_FILE_BYTES;
  const browserReason = officeFailed
    ? 'Офис в браузере не запустился — обновите страницу'
    : browserFormat === null
      ? 'Браузерный путь принимает только XLSX и DOCX'
      : tooLargeForBrowser
        ? `Файл больше ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} МБ: браузерный путь ограничен памятью вкладки`
        : null;
  const canUseBrowser = browserReason === null && !isWorking;

  const parts: string[] = [
    item.result
      ? `${formatBytes(item.size)} → ${formatBytes(item.result.sizeBytes)}`
      : `${formatBytes(item.size)} → PDF`,
  ];

  if (item.route) {
    parts.push(item.route === 'browser' ? 'в браузере' : 'на сервере');
  }

  if (item.tier) {
    parts.push(`уровень: ${TIER_LABELS[item.tier].toLowerCase()}`);
  }

  if (typeof item.sheets === 'number') {
    parts.push(`${item.sheets} ${pluralize(item.sheets, ['лист', 'листа', 'листов'])}`);
  }

  // Ссылка на результат живёт ограниченное время: сервер подписывает её
  // на час, поэтому срок показывается рядом с кнопкой, а после истечения
  // скачивание предлагается повторить
  const expiresLabel =
    item.result?.kind === 'server' ? formatClockTime(item.result.expiresAt) : null;

  // Скачивать есть что только у завершённой задачи с действующим результатом:
  // серверная ссылка истекает, браузерный blob живёт до уборки строки
  const canDownload =
    item.status === 'completed' && item.result !== undefined && !isExpired;

  const elapsed = elapsedSeconds === null ? null : formatDuration(elapsedSeconds);

  return (
    <tr className="task">
      <td className="task__name">
        <span className="task__file" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="task__meta">{parts.join(' · ')}</span>
        {browserReason !== null ? <span className="task__meta">{browserReason}</span> : null}
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

        {/* Срок есть только у серверной ссылки; браузерный PDF лежит
            в памяти вкладки, и напоминание о сроке было бы неправдой */}
        {canDownload && expiresLabel ? (
          <span className="task__meta">ссылка действует до {expiresLabel}</span>
        ) : null}

        {canDownload && item.result?.kind === 'browser' ? (
          <span className="task__meta">скачайте до закрытия страницы</span>
        ) : null}

        {/* Ссылка в хранилище живёт час; у браузерного результата срока нет,
            и напоминать о нём нечего */}
        {item.status === 'completed' && item.result?.kind === 'server' && isExpired ? (
          <span className="task__meta">Ссылка на файл истекла — запустите конвертацию заново</span>
        ) : null}

        <button
          type="button"
          className="button button--secondary"
          onClick={() => onRun(item.id, 'server')}
          disabled={isWorking}
          title="Конвертировать на сервере: файл уйдёт в очередь воркеров"
          aria-label={`Конвертировать ${item.file.name} на сервере`}
        >
          На сервере
        </button>

        <button
          type="button"
          className="button button--secondary"
          onClick={() => onRun(item.id, 'browser')}
          disabled={!canUseBrowser}
          title={browserReason ?? 'Конвертировать в браузере: файл не покидает ваш компьютер'}
          aria-label={`Конвертировать ${item.file.name} в браузере`}
        >
          В браузере
        </button>

        <button
          type="button"
          className="button button--ghost"
          onClick={() => onPreview(item.id)}
          disabled={!canUseBrowser}
          title={browserReason ?? 'Показать документ в окне офиса'}
          aria-label={`Показать ${item.file.name} в предпросмотре`}
        >
          Предпросмотр
        </button>

        {isBrowserStatus(item.status) && item.status === 'browser-waiting' ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onCancel(item.id)}
          >
            Убрать из очереди
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
