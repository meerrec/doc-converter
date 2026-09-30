/**
 * Панель предпросмотра: страницы открытого документа.
 *
 * Страницы рисует движок — тем же display list, из которого собирается PDF, —
 * а панель показывает их по мере надобности: на каждую страницу стоит
 * плейсхолдер нужного размера, и растр запрашивается, когда страница попадает
 * в область видимости. Документ на сотню страниц стоит столько же, сколько
 * на четыре видимых; прежний вариант создавал canvas на каждую страницу сразу.
 *
 * Растр приходит готовым (`ImageBitmap`) и копируется в canvas один раз:
 * сам растр после этого закрывается. Копия живёт до ухода страницы за край
 * или до смены масштаба.
 *
 * Холсты ставятся в разметку **императивно**, а не через React: страница
 * появляется не по действию пользователя, а по готовности растра, и держать
 * их в состоянии значило бы перерисовывать список на каждой странице.
 * React владеет только плейсхолдерами — и, при отказе, плашкой ошибки внутри
 * плейсхолдера.
 *
 * Закрывать сессию панель не имеет права: ею владеет очередь.
 *
 * Все комментарии на русском языке.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { PreviewSession, SkippedPrimitives } from '@doc-converter/office';
import { PREVIEW_MAX_DPR, PREVIEW_MAX_LIVE_PAGES, PREVIEW_ZOOM_MAX, PREVIEW_ZOOM_MIN } from '../config';
import { pluralize } from '../lib/format';

/** Что не переносится в PDF — словами, а не видами примитивов. */
const SKIPPED_LABELS: Readonly<Record<string, string>> = {
  shape: 'надписи и фигуры',
  text: 'текстовые прогоны',
};

/** Шаг изменения масштаба. */
const ZOOM_STEP = 0.25;

/** Запас вокруг видимой области: соседние страницы успевают подготовиться. */
const VIEWPORT_MARGIN = '100% 0px';

interface PreviewPanelProps {
  /** Имя файла, открытого в предпросмотре; null — предпросмотра нет. */
  fileName: string | null;
  /** Открытый документ; null — показывать нечего. */
  session: PreviewSession | null;
  onClose: () => void;
}

/**
 * Описывает пропущенное в PDF словами.
 *
 * @param skipped - счётчик по видам примитивов
 * @returns строка для показа или null, если пропущенного нет
 */
function describeSkipped(skipped: SkippedPrimitives): string | null {
  const parts: string[] = [];

  for (const [kind, count] of Object.entries(skipped)) {
    if (count <= 0) {
      continue;
    }

    parts.push(`${SKIPPED_LABELS[kind] ?? 'оформление'} (${count})`);
  }

  return parts.length === 0 ? null : parts.join(', ');
}

export const PreviewPanel = memo(function PreviewPanel({
  fileName,
  session,
  onClose,
}: PreviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  /** Сколько страниц уже нарисовано: по нему видно, что предпросмотр идёт. */
  const [painted, setPainted] = useState(0);
  /** Повод перерисовать всё заново: повтор после отказа. */
  const [attempt, setAttempt] = useState(0);

  // Отказы страниц относятся к документу, а не к масштабу: при смене
  // документа плашки снимаются, при смене зума — остаются, и повторить
  // их можно кнопкой
  useEffect(() => {
    setFailed(new Set());
  }, [session]);

  useEffect(() => {
    const container = containerRef.current;

    if (session === null || container === null) {
      setPainted(0);
      return;
    }

    const canvases = new Map<number, HTMLCanvasElement>();
    const visible = new Set<number>();
    const requested = new Set<number>();
    let disposed = false;

    setPainted(0);

    const holders = new Map<number, HTMLElement>();

    for (const holder of container.querySelectorAll<HTMLElement>('[data-page]')) {
      holders.set(Number(holder.dataset.page), holder);
    }

    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR);

    /**
     * Освобождает холсты дальних страниц.
     *
     * Потолок нужен затем, чтобы долгий просмотр не копил растр всего
     * документа: страницы, которые сейчас не видны, освобождаются первыми.
     *
     * @param keep - страница, ради которой рисуем: её не трогаем
     */
    const evict = (keep: number): void => {
      while (canvases.size > PREVIEW_MAX_LIVE_PAGES) {
        let farthest: number | null = null;

        for (const index of canvases.keys()) {
          if (visible.has(index)) {
            continue;
          }

          if (farthest === null || Math.abs(index - keep) > Math.abs(farthest - keep)) {
            farthest = index;
          }
        }

        if (farthest === null) {
          return;
        }

        canvases.get(farthest)?.remove();
        canvases.delete(farthest);
      }
    };

    /**
     * Рисует страницу.
     *
     * @param index - номер страницы
     */
    const draw = async (index: number): Promise<void> => {
      const holder = holders.get(index);

      if (holder === undefined || canvases.has(index) || requested.has(index)) {
        return;
      }

      requested.add(index);

      try {
        const bitmap = await session.render(index, devicePixelRatio * zoom);

        // Сессию закрыли, пока растр рисовался: показывать нечего
        if (bitmap === null) {
          return;
        }

        if (disposed) {
          bitmap.close();
          return;
        }

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (context === null) {
          bitmap.close();
          throw new Error('canvas не отдал контекст 2d');
        }

        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.className = 'preview__page';

        context.drawImage(bitmap, 0, 0);
        bitmap.close();

        canvases.set(index, canvas);
        holder.append(canvas);
        setPainted((count) => count + 1);

        evict(index);
      } catch {
        if (!disposed) {
          setFailed((current) => new Set(current).add(index));
        }
      } finally {
        requested.delete(index);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.page);

          if (entry.isIntersecting) {
            visible.add(index);
            void draw(index);
          } else {
            visible.delete(index);
          }
        }
      },
      { root: container, rootMargin: VIEWPORT_MARGIN }
    );

    for (const holder of holders.values()) {
      observer.observe(holder);
    }

    return () => {
      disposed = true;
      observer.disconnect();

      for (const canvas of canvases.values()) {
        canvas.remove();
      }

      canvases.clear();
    };
  }, [session, zoom, attempt]);

  const skipped = session === null ? null : describeSkipped(session.skipped);
  const changeZoom = (delta: number): void => {
    setZoom((current) => {
      const next = Math.round((current + delta) * 100) / 100;

      return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, next));
    });
  };

  return (
    <section className="panel" aria-label="Предпросмотр документа">
      <h2 className="tasks__title">Предпросмотр</h2>

      {session === null ? (
        <p className="preview__hint">
          Здесь появятся страницы документа — после нажатия «Предпросмотр»
          в строке файла.
        </p>
      ) : (
        <>
          <div className="preview__toolbar">
            <span className="field__hint">
              {fileName}
              {session.sheets !== null ? `, листов: ${session.sheets}` : ''}
              {' — '}
              {session.pageCount}{' '}
              {pluralize(session.pageCount, ['страница', 'страницы', 'страниц'])}
            </span>

            <div className="preview__zoom">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => changeZoom(-ZOOM_STEP)}
                disabled={zoom <= PREVIEW_ZOOM_MIN}
                aria-label="Уменьшить масштаб"
              >
                −
              </button>

              <span className="preview__zoom-value">{Math.round(zoom * 100)}%</span>

              <button
                type="button"
                className="button button--ghost"
                onClick={() => changeZoom(ZOOM_STEP)}
                disabled={zoom >= PREVIEW_ZOOM_MAX}
                aria-label="Увеличить масштаб"
              >
                +
              </button>
            </div>
          </div>

          {skipped === null ? null : (
            <p className="alert alert--warning" role="status">
              В скачанный PDF не переносится часть оформления: {skipped}. Такого
              движок пока не умеет — страницы предпросмотра показывают больше,
              чем окажется в файле.
            </p>
          )}

          <div className="preview__pages" ref={containerRef}>
            {session.pages.map((page, index) => (
              <div
                key={index}
                data-page={index}
                role="img"
                aria-label={`Страница ${index + 1}`}
                className="preview__sheet"
                style={{ width: `${Math.round(page.width * zoom)}px`, height: `${Math.round(page.height * zoom)}px` }}
              >
                {failed.has(index) ? (
                  <div className="preview__error" role="alert">
                    <p className="preview__hint">Страницу не удалось нарисовать.</p>

                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => {
                        setFailed((current) => {
                          const next = new Set(current);

                          next.delete(index);

                          return next;
                        });
                        setAttempt((current) => current + 1);
                      }}
                    >
                      Повторить
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {painted === 0 ? <p className="preview__hint">Страницы готовятся…</p> : null}

          <p className="field__hint">
            Это страницы той же вёрстки, из которой собирается скачанный PDF.
          </p>

          <div className="actions">
            <button type="button" className="button button--secondary" onClick={onClose}>
              Закрыть документ
            </button>
          </div>
        </>
      )}
    </section>
  );
});
