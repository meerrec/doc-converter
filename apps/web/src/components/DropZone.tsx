/**
 * Зона выбора файлов: перетаскивание или диалог выбора.
 *
 * Основу составляет нативный <input type="file"> внутри <label> — он даёт
 * выбор файлов с клавиатуры и из меню, а перетаскивание работает как
 * дополнительный способ.
 */

import { memo, useCallback, useId, useState } from 'react';
import { INPUT_FORMATS } from '@doc-converter/contract/formats';
import { MAX_UPLOAD_BYTES } from '../config';

interface DropZoneProps {
  /** Вызывается с выбранными файлами. */
  onFiles: (files: File[]) => void;
  /** Блокирует выбор файлов (например, во время отправки). */
  disabled?: boolean;
  /**
   * Предельный размер файла в байтах.
   *
   * По умолчанию — серверный лимит: форма одна на два пути, но пределы у них
   * разные. Браузерный путь ограничен памятью вкладки, а не репликой,
   * и подставлять сюда серверное значение значило бы обещать больше, чем
   * этот путь выдержит.
   */
  maxBytes?: number;
  /** Расширения, которые принимаются (без точки). */
  formats?: readonly string[];
}

export const DropZone = memo(function DropZone({
  onFiles,
  disabled = false,
  maxBytes = MAX_UPLOAD_BYTES,
  formats = INPUT_FORMATS,
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputId = useId();
  const hintId = useId();

  /**
   * Обрабатывает перетаскивание: гасит стандартное поведение браузера
   * (иначе файл откроется в новой вкладке).
   */
  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled) {
        return;
      }

      event.preventDefault();
      setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // Событие приходит и при переходе между дочерними элементами
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);

      if (disabled) {
        return;
      }

      const files = Array.from(event.dataTransfer.files);

      if (files.length > 0) {
        onFiles(files);
      }
    },
    [disabled, onFiles]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);

      if (files.length > 0) {
        onFiles(files);
      }

      // Сбрасываем значение, чтобы повторный выбор того же файла
      // снова вызывал событие change
      event.target.value = '';
    },
    [onFiles]
  );

  const maxSizeMb = Math.floor(maxBytes / (1024 * 1024));
  const accept = formats.map((format) => `.${format}`).join(',');
  const formatList = formats.map((format) => format.toUpperCase()).join(' и ');

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={accept}
        onChange={handleChange}
        disabled={disabled}
        aria-describedby={hintId}
      />

      <label className="dropzone__label" htmlFor={inputId}>
        <span className="dropzone__title">Перетащите файлы Excel и Word сюда</span>
        <span className="dropzone__subtitle">
          или нажмите, чтобы выбрать на диске
        </span>
      </label>

      <p className="dropzone__hint" id={hintId}>
        Поддерживаются файлы {formatList}, каждый — до {maxSizeMb} МБ.
        Результат конвертации — PDF.
      </p>
    </div>
  );
});
