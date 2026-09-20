/**
 * Зона выбора файлов: перетаскивание или диалог выбора.
 *
 * Основу составляет нативный <input type="file"> внутри <label> — он даёт
 * выбор файлов с клавиатуры и из меню, а перетаскивание работает как
 * дополнительный способ.
 */

import { memo, useCallback, useId, useRef, useState } from 'react';
import { INPUT_FORMATS } from '@doc-converter/contract';
import { MAX_UPLOAD_BYTES } from '../config';

interface DropZoneProps {
  /** Вызывается с выбранными файлами. */
  onFiles: (files: File[]) => void;
  /** Блокирует выбор файлов (например, во время отправки). */
  disabled?: boolean;
}

/** Список расширений для атрибута accept. */
const ACCEPT = INPUT_FORMATS.map((format) => `.${format}`).join(',');

/** Те же форматы в подписи — чтобы список не разошёлся с атрибутом. */
const FORMAT_LIST = INPUT_FORMATS.map((format) => format.toUpperCase()).join(' и ');

export const DropZone = memo(function DropZone({
  onFiles,
  disabled = false,
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const maxSizeMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        id={inputId}
        className="visually-hidden"
        type="file"
        multiple
        accept={ACCEPT}
        onChange={handleChange}
        disabled={disabled}
        aria-describedby={hintId}
      />

      <label className="dropzone__label" htmlFor={inputId}>
        <span className="dropzone__title">Перетащите книги Excel сюда</span>
        <span className="dropzone__subtitle">
          или нажмите, чтобы выбрать на диске
        </span>
      </label>

      <p className="dropzone__hint" id={hintId}>
        Поддерживаются файлы {FORMAT_LIST}, каждый — до {maxSizeMb} МБ.
        Результат конвертации — PDF.
      </p>
    </div>
  );
});
