/**
 * Панель предпросмотра: страницы итогового PDF.
 *
 * Браузерный движок отдаёт готовый PDF, поэтому предпросмотр — не окно
 * редактора, а его страницы, нарисованные в `<canvas>`. Рендером занимается
 * pdf.js: свой PDF-экспортёр пишет обычный PDF 1.7, и отдельного рендера
 * страниц писать незачем.
 *
 * Страницы рисуются императивно, а не в разметке React: каждая из них — это
 * canvas с выбранным pdf.js масштабом, и React не должен их пересоздавать
 * при перерисовке панели. Эффект очищает canvas и отменяет рендер при
 * смене или закрытии документа.
 *
 * Все комментарии на русском языке.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** Масштаб страниц: достаточный для чтения и экономный для вкладки. */
const PAGE_SCALE = 1.25;

interface PreviewPanelProps {
  /** Имя файла, открытого в предпросмотре; null — предпросмотра нет. */
  fileName: string | null;
  /** Число листов книги; null — не книга или документ ещё не открыт. */
  sheets: number | null;
  /** Адрес готового PDF; null — предпросмотра нет. */
  url: string | null;
  onClose: () => void;
}

export const PreviewPanel = memo(function PreviewPanel({
  fileName,
  sheets,
  url,
  onClose,
}: PreviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;

    if (url === null || container === null) {
      setBusy(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    let pdfDocument: PDFDocumentProxy | null = null;
    let task: RenderTask | null = null;

    container.replaceChildren();
    setBusy(true);
    setFailed(false);

    void (async () => {
      try {
        // pdf.js грузится лениво: страницы нужны только в предпросмотре,
        // а статический импорт положил бы рендер в основной бандл
        const [pdfjs, worker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);

        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        pdfDocument = await pdfjs.getDocument(url).promise;

        for (let number = 1; number <= pdfDocument.numPages && !cancelled; number += 1) {
          const page = await pdfDocument.getPage(number);
          const viewport = page.getViewport({ scale: PAGE_SCALE });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');

          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = 'preview__page';
          container.append(canvas);

          if (context === null) {
            throw new Error('canvas не отдал контекст 2d');
          }

          task = page.render({ canvasContext: context, viewport });
          await task.promise;
          task = null;
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      } finally {
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
      void pdfDocument?.destroy().catch(() => undefined);
    };
  }, [url]);

  return (
    <section className="panel panel--preview" aria-label="Предпросмотр документа">
      <h2 className="tasks__title">Предпросмотр</h2>

      {url === null ? (
        <p className="preview__hint">
          Здесь появятся страницы документа — после нажатия «Предпросмотр»
          в строке файла.
        </p>
      ) : (
        <>
          <div className="preview__pages" ref={containerRef} />

          {busy ? <p className="preview__hint">Страницы готовятся…</p> : null}

          {failed ? (
            <p className="preview__hint" role="alert">
              Не удалось нарисовать страницы. Скачайте PDF — файл готов и не зависит
              от предпросмотра.
            </p>
          ) : null}

          <p className="field__hint">
            {fileName}
            {sheets !== null ? `, листов: ${sheets}` : ''}
          </p>

          <div className="actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
            >
              Закрыть документ
            </button>
          </div>

          <p className="field__hint">
            Это те же страницы, что попадут в скачанный PDF.
          </p>
        </>
      )}
    </section>
  );
});
