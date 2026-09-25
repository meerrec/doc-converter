/**
 * Очередь офиса: последовательность, отмены и жизненный цикл документа.
 *
 * Офис один и держит не более одного открытого документа, поэтому очередь —
 * не оптимизация, а условие работы: параллельный запуск не ускорил бы ничего,
 * а второй документ в памяти не поместился бы. Проверяется то, что иначе
 * видно только в браузере и не с первого раза: порядок задач, что происходит
 * при отказе одной из них, когда удаляется исходник и когда прежний
 * предпросмотр перестаёт быть действительным.
 *
 * Сессия подменяется двойником: настоящая требует сборку LibreOffice на
 * 250 МБ, а проверяются здесь решения очереди, а не работа офиса.
 */

import { describe, it, expect } from 'vitest';
import { createOfficeQueue } from '@doc-converter/office';

/** Размер результата, проходящий проверку «экспортёр не вернул пустоту». */
const PDF_BYTES = 128;

/**
 * Создаёт двойника сессии офиса.
 *
 * @param options - что должно сломаться: `null` — ничего
 * @returns сессия и журнал вызовов
 */
function createSession({ failPreview = false } = {}) {
  const calls = [];
  const files = new Map();

  return {
    calls,
    files,

    writeFile(path, bytes) {
      calls.push(['writeFile', path]);
      files.set(path, bytes);
    },

    readFile(path) {
      return files.get(path) ?? new Uint8Array(PDF_BYTES);
    },

    removeFile(path) {
      calls.push(['removeFile', path]);
      files.delete(path);
    },

    async preview(path) {
      calls.push(['preview', path]);

      if (failPreview) {
        throw new Error('документ не открылся');
      }

      return { sheets: 2 };
    },

    async convert(request) {
      calls.push(['convert', request.source]);
      files.set(request.target, new Uint8Array(PDF_BYTES));
    },

    async close() {
      calls.push(['close']);
    },
  };
}

/**
 * Собирает очередь с двойником сессии.
 *
 * @param session - сессия
 * @returns очередь и записанные события
 */
function createQueue(session) {
  const events = [];

  const queue = createOfficeQueue({
    open: async () => session,
    events: {
      onPhase: (itemId, phase) => events.push(['phase', itemId, phase]),
      onDone: (itemId, outcome) => events.push(['done', itemId, outcome.kind]),
      onFailed: (itemId, error) => events.push(['failed', itemId, error.message]),
      onDocumentChanged: (itemId) => events.push(['document', itemId]),
    },
  });

  return { queue, events };
}

/**
 * Ставит задачу и ждёт её завершения.
 *
 * @param queue - очередь
 * @param events - записанные события
 * @param job - задача
 * @returns события после завершения задачи
 */
async function run(queue, events, job) {
  queue.enqueue(job);

  await new Promise((resolve) => setTimeout(resolve, 0));

  return events;
}

/** Задача конвертации. */
function convertJob(itemId, fileName) {
  return {
    kind: 'convert',
    itemId,
    fileName,
    options: { fitToOnePage: false },
    readBytes: async () => new Uint8Array([1, 2, 3]),
  };
}

/** Задача предпросмотра. */
function previewJob(itemId, fileName) {
  return {
    kind: 'preview',
    itemId,
    fileName,
    readBytes: async () => new Uint8Array([1, 2, 3]),
  };
}

describe('последовательность задач', () => {
  it('задачи выполняются по одной и в порядке постановки', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);

    queue.enqueue(convertJob('a', 'первый.xlsx'));
    queue.enqueue(convertJob('b', 'второй.xlsx'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const conversions = session.calls.filter(([name]) => name === 'convert');
    const sources = conversions.map(([, source]) => source);

    // Пути разные — значит и документы разные: переиспользование по одному
    // пути отдало бы PDF первого файла для обоих
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    expect(events.filter(([kind]) => kind === 'done')).toHaveLength(2);
  });

  it('повторная постановка той же задачи игнорируется', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);
    const job = convertJob('a', 'файл.xlsx');

    queue.enqueue(job);
    queue.enqueue(job);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.calls.filter(([name]) => name === 'convert')).toHaveLength(1);
    expect(events.filter(([kind]) => kind === 'done')).toHaveLength(1);
  });

  it('отказ одной задачи не останавливает очередь', async () => {
    // Документ, который не открывается: одна плохая книга не должна
    // блокировать остальные — иначе очередь пришлось бы разбирать вручную
    const session = createSession({ failPreview: true });
    const { queue, events } = createQueue(session);

    queue.enqueue(previewJob('bad', 'битый.xlsx'));
    queue.enqueue(convertJob('good', 'хороший.xlsx'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some(([kind, id]) => kind === 'failed' && id === 'bad')).toBe(true);
    expect(events.some(([kind, id]) => kind === 'done' && id === 'good')).toBe(true);
  });
});

describe('отмена', () => {
  it('снимает ожидающие задачи и не трогает выполняющуюся', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);

    queue.enqueue(previewJob('current', 'текущий.xlsx'));
    queue.enqueue(convertJob('waiting', 'ожидающий.xlsx'));

    expect(queue.cancelPending('waiting')).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.calls.some(([name, source]) => name === 'convert' && source.includes('source'))).toBe(
      false
    );
    expect(events.some(([kind, id]) => kind === 'done' && id === 'current')).toBe(true);
  });
});

describe('документ в окне офиса', () => {
  it('разные файлы открываются по разным путям, один и тот же — по одному', async () => {
    const session = createSession();
    const { queue } = createQueue(session);

    await run(queue, [], previewJob('a', 'книга.xlsx'));
    await run(queue, [], convertJob('a', 'книга.xlsx'));

    const previews = session.calls.filter(([name]) => name === 'preview').map(([, p]) => p);
    const conversions = session.calls.filter(([name]) => name === 'convert').map(([, p]) => p);

    // Предпросмотр и конвертация одного файла — один путь: офис откроет
    // документ один раз и переиспользует его
    expect(previews[0]).toBe(conversions[0]);
  });

  it('исходник удаляется, когда документ больше не открыт', async () => {
    const session = createSession();
    const { queue } = createQueue(session);

    await run(queue, [], convertJob('a', 'файл.xlsx'));

    const removed = session.calls.filter(([name]) => name === 'removeFile').map(([, p]) => p);

    // Путь результата и путь исходника: документ после экспорта закрыт,
    // держать его файл в памяти сборки незачем
    expect(removed).toHaveLength(2);
  });

  it('смена документа сбрасывает предпросмотр', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);

    await run(queue, events, previewJob('a', 'первый.xlsx'));
    await run(queue, events, previewJob('b', 'второй.xlsx'));

    const documents = events.filter(([kind]) => kind === 'document').map(([, id]) => id);

    // Офис открывает второй документ на месте первого: показанного ранее
    // файла в окне больше нет, и интерфейс обязан это узнать
    expect(documents).toEqual(['a', null, 'b']);
  });
});

describe('фазы задач', () => {
  it('фаза ожидания приходит до начала работы', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);

    queue.enqueue(convertJob('a', 'файл.xlsx'));

    // Ещё до первого тика: задача встала в очередь и ждёт
    expect(events[0]).toEqual(['phase', 'a', 'waiting']);

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('неподдержанный формат отклоняется без обращения к офису', async () => {
    const session = createSession();
    const { queue, events } = createQueue(session);

    await run(queue, events, convertJob('a', 'файл.odt'));

    expect(events.some(([kind]) => kind === 'failed')).toBe(true);
    expect(session.calls).toHaveLength(0);
  });
});
