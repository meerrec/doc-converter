/**
 * Панель офиса в браузере.
 *
 * Офис — это сборка LibreOffice, скачиваемая в вкладку (около 78 МБ сжатых
 * данных), и панель говорит об этом прямо: трафик пользовательский, и решать
 * должен он, а не страница. Отсюда же запускается загрузка, и сюда же
 * приходит её ход: сама сборка грузит свои файлы молча, и отличить работу
 * от зависания было бы нечем.
 *
 * Все комментарии на русском языке.
 */

import { memo } from 'react';
import type { OfficeState } from '@doc-converter/office';
import { ProgressBar } from './ProgressBar';

/**
 * Размер сборки, который скачивается при первом запуске, в мегабайтах.
 *
 * Оценка сжатых файлов (`docs/local-wasm.md`): распакованные — около 250 МБ,
 * по сети — около 78 МБ.
 */
const OFFICE_SIZE_MB = 78;

interface OfficePanelProps {
  state: OfficeState;
  onLoad: () => void;
}

/** Как называется файл в интерфейсе. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export const OfficePanel = memo(function OfficePanel({ state, onLoad }: OfficePanelProps) {
  return (
    <section className="panel" aria-label="Офис в браузере">
      <h2 className="tasks__title">Офис в браузере</h2>

      {state.kind === 'idle' ? (
        <>
          <p className="field__hint">
            Браузерная конвертация и предпросмотр идут сборкой LibreOffice в этой вкладке.
            Её нужно скачать один раз — около {OFFICE_SIZE_MB} МБ сжатых данных; дальше
            она останется в кеше браузера.
          </p>

          <div className="actions">
            <button type="button" className="button button--primary" onClick={onLoad}>
              Загрузить офис
            </button>
          </div>
        </>
      ) : null}

      {state.kind === 'loading' ? (
        <>
          <ProgressBar
            value={
              state.totalBytes ? (state.loadedBytes / state.totalBytes) * 100 : undefined
            }
            label="Загрузка сборки LibreOffice"
          />
          <p className="field__hint">
            Получено {formatBytes(state.loadedBytes)}
            {state.totalBytes ? ` из ${formatBytes(state.totalBytes)}` : ''}
          </p>
        </>
      ) : null}

      {state.kind === 'ready' ? (
        <p className="field__hint">
          Офис готов. Он выполняет по одной задаче: браузерные конвертации и предпросмотр
          встают в очередь. Начатую конвертацию прервать нельзя — отменить можно только
          ожидающие.
        </p>
      ) : null}

      {state.kind === 'failed' ? (
        <p className="alert alert--error" role="alert">
          Офис не запустился. Обновите страницу и попробуйте снова — в этом документе сборку
          заново не поднять.
        </p>
      ) : null}
    </section>
  );
});
