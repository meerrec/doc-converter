/**
 * Очередь своего движка (BetterOffice): последовательность и предпросмотр.
 *
 * Движок один и держит память вкладки, поэтому задачи идут по одной; проверки
 * здесь те же, что у очереди сборки LibreOffice, — порядок, отказ одной задачи
 * без остановки остальных, отмена ожидающих, — но конвертер подменён: живой
 * движок тянет wasm и шрифты, а проверяются решения очереди, а не его работа.
 *
 * Отдельно проверяется то, чего у сборки нет: предпросмотр — это готовый PDF,
 * и он приходит из той же функции, что и результат.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { createLocalQueue } from '@doc-converter/office';

/** Размер результата, проходящий проверку «экспортёр не вернул пустоту». */
const PDF_BYTES = 128;

/**
 * Собирает конвертер-двойник.
 *
 * @param options - что должно сломаться: `null` — ничего
 * @returns конвертер и журнал вызовов
 */
function createConverter({ failOn = null, delayMs = 0 } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,

    /** Сколько задач выполнялось одновременно: больше одной быть не должно. */
    get maxActive() {
      return maxActive;
    },

    async convert(input) {
      calls.push(input.fileName);

      active += 1;
      maxActive = Math.max(maxActive, active);

      try {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        if (input.fileName === failOn) {
          throw new Error('движок не осилил документ');
        }

        return {
          bytes: new Uint8Array(PDF_BYTES),
          pageCount: 1,
          sheets: input.fileName.endsWith('.xlsx') ? 2 : null,
        };
      } finally {
        active -= 1;
      }
    },
  };
}

/**
 * Создаёт очередь с записью событий.
 *
 * @param converter - конвертер-двойник
 * @returns очередь и журнал событий
 */
function createQueue(converter) {
  const events = [];

  const queue = createLocalQueue({
    convert: (input) => converter.convert(input),
    events: {
      onPhase: (itemId, phase) => events.push(['phase', itemId, phase]),
      onDone: (itemId, outcome) => events.push(['done', itemId, outcome]),
      onFailed: (itemId, error) => events.push(['failed', itemId, error.message]),
      onDocumentChanged: (itemId) => events.push(['document', itemId]),
    },
  });

  return { queue, events };
}

/** Задача конвертации. */
function convertJob(itemId, fileName = 'документ.docx') {
  return {
    kind: 'convert',
    itemId,
    fileName,
    options: { fitToOnePage: false },
    readBytes: async () => new Uint8Array([1, 2, 3]),
  };
}

/** Задача предпросмотра. */
function previewJob(itemId, fileName = 'документ.docx') {
  return {
    kind: 'preview',
    itemId,
    fileName,
    options: { fitToOnePage: false },
    readBytes: async () => new Uint8Array([1, 2, 3]),
  };
}

/**
 * Ждёт, пока очередь выполнит все задачи.
 *
 * @param events - журнал событий
 * @param count - сколько задач должно завершиться
 */
async function settle(events, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const finished = events.filter(([kind]) => kind === 'done' || kind === 'failed').length;

    if (finished >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('последовательность задач', () => {
  it('выполняет задачи по одной и в порядке постановки', async () => {
    const converter = createConverter();
    const { queue, events } = createQueue(converter);

    queue.enqueue(convertJob('a', 'первый.docx'));
    queue.enqueue(convertJob('b', 'второй.docx'));

    await settle(events, 2);

    expect(converter.calls).toEqual(['первый.docx', 'второй.docx']);
    expect(converter.maxActive).toBe(1);

    // Фазы идут от ожидания к работе: вторая задача встаёт в ожидание уже
    // во время первой — очередь не ждёт, пока освободится
    const phases = events.filter(([kind]) => kind === 'phase').map(([, , phase]) => phase);

    expect(phases).toEqual(['waiting', 'converting', 'waiting', 'converting']);
  });

  it('игнорирует повторную постановку той же задачи', async () => {
    const converter = createConverter({ delayMs: 5 });
    const { queue, events } = createQueue(converter);

    queue.enqueue(convertJob('a'));
    queue.enqueue(convertJob('a'));

    await settle(events, 1);

    expect(converter.calls).toHaveLength(1);
  });
});

describe('отказы', () => {
  it('продолжает очередь после отказа одной задачи', async () => {
    const converter = createConverter({ failOn: 'плохой.docx' });
    const { queue, events } = createQueue(converter);

    queue.enqueue(convertJob('a', 'плохой.docx'));
    queue.enqueue(convertJob('b', 'хороший.docx'));

    await settle(events, 2);

    const failed = events.find(([kind]) => kind === 'failed');
    const done = events.find(([kind, itemId]) => kind === 'done' && itemId === 'b');

    expect(failed?.[1]).toBe('a');
    expect(failed?.[2]).toContain('не осилил');
    expect(done?.[2]).toMatchObject({ kind: 'converted' });
  });

  it('отвергает пустой результат экспортёра', async () => {
    const { queue, events } = createQueue({ convert: async () => ({ bytes: new Uint8Array(1), pageCount: 1, sheets: null }) });

    queue.enqueue(convertJob('a'));

    await settle(events, 1);

    expect(events.find(([kind]) => kind === 'failed')?.[2]).toContain('пустой файл');
  });

  it('отвергает формат, которого движок не принимает', async () => {
    const converter = createConverter();
    const { queue, events } = createQueue(converter);

    queue.enqueue(convertJob('a', 'таблица.xls'));

    await settle(events, 1);

    expect(converter.calls).toHaveLength(0);
    expect(events.find(([kind]) => kind === 'failed')?.[2]).toContain('формат не поддержан');
  });
});

describe('отмена', () => {
  it('снимает ожидающие задачи, не трогая идущую', async () => {
    const converter = createConverter({ delayMs: 10 });
    const { queue, events } = createQueue(converter);

    queue.enqueue(convertJob('a'));
    queue.enqueue(convertJob('b'));
    queue.enqueue(convertJob('c'));

    expect(queue.cancelPending()).toBe(2);

    await settle(events, 1);

    expect(converter.calls).toEqual(['документ.docx']);
  });
});

describe('предпросмотр', () => {
  it('отдаёт готовый PDF и число листов', async () => {
    const converter = createConverter();
    const { queue, events } = createQueue(converter);

    queue.enqueue(previewJob('a', 'книга.xlsx'));

    await settle(events, 1);

    const done = events.find(([kind]) => kind === 'done');

    expect(done?.[2]).toMatchObject({ kind: 'previewed', sheets: 2 });
    expect(done?.[2].pdf.byteLength).toBe(PDF_BYTES);

    // Документ помечен открытым до того, как пришёл исход: иначе панель
    // показала бы файл, которого в движке уже нет
    const document = events.findIndex(([kind]) => kind === 'document');
    const finished = events.findIndex(([kind]) => kind === 'done');

    expect(document).toBeGreaterThanOrEqual(0);
    expect(document).toBeLessThan(finished);
  });

  it('закрытие документа очищает показанное', async () => {
    const converter = createConverter();
    const { queue, events } = createQueue(converter);

    queue.enqueue(previewJob('a'));
    await settle(events, 1);

    await queue.closeDocument();

    expect(events.at(-1)).toEqual(['document', null]);
  });
});
