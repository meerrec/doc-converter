/**
 * Клиент движка: договор со страницей и поведение на отказах.
 *
 * Воркер подставной: проверяется не конвертация, а то, что вокруг неё, —
 * форма сообщений, перенос буфера вместо копии и правильная реакция
 * на отказ. Настоящий воркер в Node не поднять, а цена ошибки здесь высока:
 * зависший запрос оставляет страницу на фазе загрузки навсегда.
 *
 * Все комментарии на русском языке.
 */

import { describe, it, expect } from 'vitest';
import { buildXlsx } from './helpers/ooxmlFixtures.js';
import { createOfficeClient } from '../packages/office/src/engine/client.js';

/** Параметры конвертации: значения те же, что в контракте. */
const OPTIONS = {
  watermarkMode: 'single',
  fitToOnePage: true,
  pdfVersion: 'default',
  quality: 90,
  reduceImageResolution: true,
  maxImageResolution: 300,
  exportBookmarks: true,
  taggedPdf: false,
  restrictPermissions: false,
  allowPrinting: true,
  allowChanges: false,
};

/**
 * Подставной воркер: записывает отправленное и умеет отвечать.
 *
 * @returns воркер с рычагами для ответов
 */
function fakeWorker() {
  const sent = [];
  const listeners = { message: [], error: [] };

  return {
    sent,
    postMessage(message, transfer) {
      sent.push({ message, transfer });
    },
    addEventListener(type, listener) {
      listeners[type]?.push(listener);
    },
    terminate() {},
    respond(response) {
      for (const listener of listeners.message) {
        listener({ data: response });
      }
    },
    crash() {
      for (const listener of listeners.error) {
        listener(new Error('воркер упал'));
      }
    },
  };
}

/** Задание конвертации. */
function input(bytes = new Uint8Array([1, 2, 3])) {
  return { bytes, fileName: 'книга.xlsx', options: OPTIONS };
}

/**
 * Ждёт, пока воркер получит запрос.
 *
 * Клиент отправляет запросы по очереди, поэтому они уходят не в тот же такт,
 * что и вызов, — и проверять `sent` сразу после вызова нельзя.
 *
 * @param worker - подставной воркер
 * @param index - номер запроса
 * @returns отправленное сообщение и список переносимых буферов
 */
async function waitForSend(worker, index = 0) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (worker.sent[index] !== undefined) {
      return worker.sent[index];
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error('воркер не получил запрос');
}

describe('клиент движка', () => {
  it('прогревается отдельным запросом', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const warmup = client.warmup();
    const sent = await waitForSend(worker);

    expect(sent.message).toMatchObject({ kind: 'warmup' });

    worker.respond({ kind: 'ready', id: sent.message.id });

    await expect(warmup).resolves.toBeUndefined();
  });

  it('передаёт буфер книги без копии', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const bytes = new Uint8Array([1, 2, 3]);
    const converted = client.convert(input(bytes));
    const { message, transfer } = await waitForSend(worker);

    expect(message).toMatchObject({ kind: 'convert', fileName: 'книга.xlsx' });
    expect(message.bytes).toBe(bytes);
    expect(transfer).toEqual([bytes.buffer]);

    worker.respond({ kind: 'done', id: message.id, bytes: new Uint8Array([37]), pageCount: 1, sheets: 1 });

    await expect(converted).resolves.toMatchObject({ pageCount: 1, sheets: 1 });
  });

  it('отдаёт отказ движка как EngineError с кодом', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const converted = client.convert(input());
    const sent = await waitForSend(worker);

    worker.respond({
      kind: 'failed',
      id: sent.message.id,
      code: 'engine_unsupported',
      message: 'водяной знак не поддержан',
    });

    await expect(converted).rejects.toMatchObject({ code: 'engine_unsupported' });
  });

  it('не повторяет запрос после отказа загрузки', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const converted = client.convert(input());
    const sent = await waitForSend(worker);

    worker.respond({
      kind: 'failed',
      id: sent.message.id,
      code: 'engine_load_failed',
      message: 'wasm не поднялся',
    });

    await expect(converted).rejects.toMatchObject({ code: 'engine_load_failed' });

    // Повторять загрузку мегабайт в этой же вкладке незачем — второй запрос
    // не должен уйти в воркер вовсе
    await expect(client.convert(input())).rejects.toMatchObject({ code: 'engine_load_failed' });
    expect(worker.sent).toHaveLength(1);
  });

  it('продолжает работу после отказа на одном файле', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const first = client.convert(input());
    const sent = await waitForSend(worker);

    worker.respond({
      kind: 'failed',
      id: sent.message.id,
      code: 'engine_convert_failed',
      message: 'файл повреждён',
    });

    await expect(first).rejects.toMatchObject({ code: 'engine_convert_failed' });

    const second = client.convert(input());
    const next = await waitForSend(worker, 1);

    worker.respond({ kind: 'done', id: next.message.id, bytes: new Uint8Array([37]), pageCount: 2, sheets: 2 });

    await expect(second).resolves.toMatchObject({ pageCount: 2 });
    expect(worker.sent).toHaveLength(2);
  });

  /**
   * В Node воркера нет, и клиент обязан работать без него: иначе тесты
   * проверяли бы не тот путь, который исполняется на странице. Проверка
   * сквозная — книга действительно конвертируется.
   */
  it('работает без воркера там, где его нет', async () => {
    const client = createOfficeClient();
    const bytes = new Uint8Array(await buildXlsx({ sheets: 1, rows: 2 }));

    await client.warmup();

    const result = await client.convert({ bytes, fileName: 'книга.xlsx', options: OPTIONS });

    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.sheets).toBe(1);
  }, 120000);

  it('отклоняет ожидающие запросы, если воркер упал', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const converted = client.convert(input());

    await waitForSend(worker);
    worker.crash();

    await expect(converted).rejects.toMatchObject({ code: 'engine_load_failed' });
  });
});
