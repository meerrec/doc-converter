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
 * Бюджет непрерывной работы между уступками главному потоку (мс).
 *
 * Обоснование: 50 мс — граница, после которой задача считается длинной и
 * портит отзывчивость (INP). Уступаем управление, как только бюджет выбран.
 */
const YIELD_BUDGET_MS = 50;

/**
 * Уступает управление главному потоку.
 *
 * scheduler.yield() возвращает управление, сохраняя приоритет продолжения
 * этой работы, — в отличие от setTimeout, который вдобавок получает
 * минимальную задержку в 4 мс после нескольких вложенных вызовов.
 * Safari API пока не поддерживает, поэтому для него остаётся setTimeout.
 */
async function yieldToMainThread(): Promise<void> {
  // lib.dom описывает scheduler.yield() не во всех версиях TypeScript,
  // поэтому наличие метода проверяется вручную
  const scheduler = (
    globalThis as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;

  if (typeof scheduler?.yield === 'function') {
    await scheduler.yield();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
  let deadline = performance.now() + YIELD_BUDGET_MS;

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) {
      throw new DOMException('Кодирование отменено', 'AbortError');
    }

    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);

    // Преобразование порции в строку: String.fromCharCode принимает
    // аргументы по одному, поэтому порция ограничена по размеру
    parts.push(String.fromCharCode(...chunk));

    // Уступаем управление, только когда исчерпан бюджет времени: уступка
    // на каждой порции означала бы сотни пробуждений на файл, каждое с
    // минимальной задержкой таймера, — это секунды простоя на 30 МиБ
    if (performance.now() >= deadline) {
      await yieldToMainThread();
      deadline = performance.now() + YIELD_BUDGET_MS;
    }
  }

  return btoa(parts.join(''));
}
