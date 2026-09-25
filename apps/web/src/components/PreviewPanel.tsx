/**
 * Панель предпросмотра: окно офиса с открытым документом.
 *
 * Canvas `#qtcanvas` лежит в `index.html`, а не в разметке React, и это
 * не стилистическое решение. Сборка ищет элемент по идентификатору
 * в момент инициализации (идентификатор задан вендором — его требует
 * Qt-бэкенд), и React, удалив узел при перерисовке, оставил бы запущенный
 * офис без цели для рисования. Поэтому узел не создаётся и не удаляется
 * компонентом: панель один раз переносит его в свой слот и больше не трогает.
 *
 * Отсюда же отсутствие очистки в эффекте: возвращать узел в `body` при
 * размонтировании значило бы потерять окно офиса на пустом месте.
 *
 * Все комментарии на русском языке.
 */

import { memo, useLayoutEffect, useRef } from 'react';

/** Идентификатор canvas, которого ждёт сборка. */
const CANVAS_ID = 'qtcanvas';

interface PreviewPanelProps {
  /** Имя файла, открытого в окне; null — предпросмотра нет. */
  fileName: string | null;
  /** Число листов книги; null — не книга или документ ещё не открыт. */
  sheets: number | null;
  /** Идёт открытие документа: кнопка «Закрыть» ждёт. */
  busy: boolean;
  onClose: () => void;
}

export const PreviewPanel = memo(function PreviewPanel({
  fileName,
  sheets,
  busy,
  onClose,
}: PreviewPanelProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const canvas = document.getElementById(CANVAS_ID);

    // Проверка на родителя делает перенос идемпотентным: повторный вызов
    // (двойной монтаж, повторный рендер) ничего не ломает
    if (slot !== null && canvas !== null && canvas.parentElement !== slot) {
      slot.append(canvas);
    }
  }, []);

  return (
    <section className="panel panel--preview" aria-label="Предпросмотр документа">
      <h2 className="tasks__title">Предпросмотр</h2>

      {/* Слот постоянный: canvas переезжает сюда и остаётся здесь до конца
          жизни страницы. Подсказка живёт рядом с ним и исчезает, когда
          документ открыт — сам canvas React не трогает */}
      <div className="preview__slot" ref={slotRef}>
        {fileName === null ? (
          <p className="preview__hint">
            Здесь появится документ — после загрузки офиса и нажатия «Предпросмотр»
            в строке файла.
          </p>
        ) : null}
      </div>

      {fileName !== null ? (
        <>
          <p className="field__hint">
            {fileName}
            {sheets !== null ? `, листов: ${sheets}` : ''}
          </p>

          <div className="actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
              disabled={busy}
            >
              Закрыть документ
            </button>
          </div>

          <p className="field__hint">
            Предпросмотр — окно самого офиса. Строку формул и боковую панель в нём скрыть
            не удалось: это ограничение сборки, а не страницы. Результат экспорта от них
            не зависит.
          </p>
        </>
      ) : null}
    </section>
  );
});
