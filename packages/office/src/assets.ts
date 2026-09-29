/**
 * Загрузка wasm-ассетов движка в браузере и в Node.
 *
 * Ассеты подставляются бандлером (`?url` в Vite): в браузере по такому импорту
 * приходит адрес файла, который можно получить `fetch`. В Node (тесты vitest)
 * Vite отдаёт по тому же импорту путь, а не адрес, и `fetch` по нему
 * не работает — файл нужно прочитать с диска. Оба случая скрыты здесь,
 * чтобы загрузчикам движка не приходилось знать, где они исполняются.
 *
 * Все комментарии на русском языке.
 */

/** Признак исполнения в Node: браузерная сборка этого пути не содержит. */
export function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

/**
 * Читает ассет движка в массив байтов.
 *
 * @param asset - адрес ассета из `?url` (в браузере) или путь (в Node)
 * @returns байты ассета
 */
export async function readAsset(asset: string): Promise<ArrayBuffer> {
  if (isNodeRuntime()) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    // В vitest `?url` отдаёт путь от корня проекта с ведущим `/`: сняв
    // его, получаем путь относительно рабочего каталога — им и запускаются
    // тесты. `file:`-адрес же приходит от настоящего `import.meta.url`.
    const filePath = asset.startsWith('file:')
      ? fileURLToPath(asset)
      : path.resolve(process.cwd(), asset.replace(/^\/+/, ''));
    const buffer = await readFile(filePath);

    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  const response = await fetch(asset);

  if (!response.ok) {
    throw new Error(`не удалось загрузить ассет движка: ${response.status}`);
  }

  return response.arrayBuffer();
}
