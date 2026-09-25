/**
 * Предзагрузка файлов сборки в память браузера.
 *
 * Сборка умеет загружать свои файлы сама, но делает это молча: браузер
 * тянет 154 МБ wasm и 95 МБ образа файловой системы, а страница не знает
 * ни их размера, ни хода загрузки. Пользователь в это время видит пустой
 * экран и не может отличить работу от зависания.
 *
 * Поэтому файлы скачиваются заранее — здесь, — и передаются сборке уже
 * готовыми ссылками на blob. Это даёт две вещи: прогресс по байтам
 * (единственное, что можно показать) и гарантию, что каждый файл скачан
 * один раз. Если бы сборка грузила их сама, а страница считала прогресс
 * отдельным запросом, файлы скачались бы дважды — 250 МБ вместо 250 МБ
 * дважды, и всё это на пользовательском канале.
 *
 * Освобождать blob-адреса не нужно и нельзя: сборка может запросить файл
 * в любой момент, а вкладка с запущенным офисом и так занимает память
 * в размере модуля.
 *
 * Все комментарии на русском языке.
 */

/**
 * Что скачивается заранее.
 *
 * `soffice.js` в списке нет: он подключается обычным тегом `<script>`,
 * и перехватить его загрузку прогрессом всё равно не выйдет. Метаданные
 * образа файловой системы, наоборот, нужны сборке в самом начале — и они
 * единственные из мелких, кому предзагрузка что-то даёт.
 */
const PRELOAD_FILES = ['soffice.wasm', 'soffice.data', 'soffice.data.js.metadata'];

/** Типы содержимого: сборка запрашивает файлы по имени и типу не доверяет. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  'soffice.wasm': 'application/wasm',
};

/** Ход загрузки. */
export interface PreloadProgress {
  /** Сколько байт получено. */
  readonly loadedBytes: number;
  /**
   * Сколько всего ожидается.
   *
   * `null` — сервер не сообщил размер: так бывает при сжатии на лету.
   * В этом случае показывается только объём полученного.
   */
  readonly totalBytes: number | null;
}

/** Скачанные файлы: имя файла — адрес его копии в памяти браузера. */
export type PreloadedAssets = ReadonlyMap<string, string>;

/**
 * Скачивает файлы сборки.
 *
 * @param assetsUrl - каталог сборки
 * @param onProgress - вызывается по мере загрузки
 * @param signal - отмена (например, уход со страницы)
 * @returns адреса скачанных файлов
 */
export async function preloadAssets(
  assetsUrl: string,
  onProgress: (progress: PreloadProgress) => void,
  signal?: AbortSignal
): Promise<PreloadedAssets> {
  const urls = new Map<string, string>();
  let loadedBytes = 0;
  let expectedBytes = 0;
  let unknownSize = false;

  for (const name of PRELOAD_FILES) {
    const response = await fetch(new URL(name, assetsUrl).toString(), { signal });

    if (!response.ok) {
      throw new Error(`${name}: сервер ответил ${response.status}`);
    }

    const declared = Number(response.headers.get('content-length'));

    if (Number.isFinite(declared) && declared > 0) {
      expectedBytes += declared;
    } else {
      unknownSize = true;
    }

    const chunks: BlobPart[] = [];
    const reader = response.body?.getReader();

    if (reader === undefined) {
      throw new Error(`${name}: сервер не отдал поток данных`);
    }

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Приведение типа: `BlobPart` требует `ArrayBufferView<ArrayBuffer>`,
      // а поток отдаёт `Uint8Array<ArrayBufferLike>`. На практике это всегда
      // обычный буфер — SharedArrayBuffer в ответе fetch взяться неоткуда,
      // — и копировать ради этого 154 МБ было бы дороже, чем объяснить
      chunks.push(value as Uint8Array<ArrayBuffer>);
      loadedBytes += value.byteLength;

      onProgress({
        loadedBytes,
        totalBytes: unknownSize ? null : expectedBytes,
      });
    }

    urls.set(
      name,
      URL.createObjectURL(
        new Blob(chunks, { type: CONTENT_TYPES[name] ?? 'application/octet-stream' })
      )
    );
  }

  return urls;
}
