/**
 * Кодирование файла в base64.
 *
 * Сервис принимает содержимое документа в поле data (base64), поэтому файл
 * приходится кодировать целиком в памяти вкладки. Чтобы не блокировать
 * главный поток на больших файлах, кодирование идёт порциями.
 */

/** Размер порции при кодировании: 32 КиБ исходных данных. */
const CHUNK_SIZE = 32 * 1024;

/**
 * Кодирует файл в base64.
 *
 * @param file - выбранный файл
 * @param signal - сигнал отмены
 * @returns содержимое файла в base64 (без префикса data:)
 * @throws {DOMException} - если операция отменена
 */
export async function fileToBase64(file: File, signal?: AbortSignal): Promise<string> {
  const buffer = await file.arrayBuffer();

  if (signal?.aborted) {
    throw new DOMException('Кодирование отменено', 'AbortError');
  }

  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) {
      throw new DOMException('Кодирование отменено', 'AbortError');
    }

    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);

    // Преобразование порции в строку: String.fromCharCode принимает
    // аргументы по одному, поэтому порция ограничена по размеру
    parts.push(String.fromCharCode(...chunk));

    // Отдаём управление главному потоку, чтобы интерфейс не подвисал
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return btoa(parts.join(''));
}
