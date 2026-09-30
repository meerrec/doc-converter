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

/**
 * Отвечает на отправленный запрос.
 *
 * Номер берётся из самого запроса: клиент присваивает его сам, и подставлять
 * своё число значило бы проверять не тот договор.
 *
 * @param worker - подставной воркер
 * @param index - номер запроса
 * @param response - ответ без номера
 */
function respond(worker, index, response) {
  worker.respond({ ...response, id: worker.sent[index].message.id });
}

/** Подставной растр: клиенту от него нужен только признак освобождения. */
function fakeBitmap() {
  return { closed: false, close() { this.closed = true; } };
}

describe('предпросмотр', () => {
  it('открывает сессию и переносит буфер файла', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const bytes = new Uint8Array([1, 2, 3]);
    const opened = client.openPreview(input(bytes));
    const sent = await waitForSend(worker);

    expect(sent.message).toMatchObject({ kind: 'preview-open', fileName: 'книга.xlsx' });
    expect(sent.transfer).toEqual([bytes.buffer]);

    respond(worker, 0, {
      kind: 'opened',
      session: 7,
      pages: [{ width: 794, height: 1123 }],
      sheets: 2,
      skipped: { shape: 1 },
    });

    const session = await opened;

    expect(session.pageCount).toBe(1);
    expect(session.sheets).toBe(2);
    expect(session.skipped).toEqual({ shape: 1 });
  });

  it('просит страницу и отдаёт растр', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const opened = client.openPreview(input());

    await waitForSend(worker);
    respond(worker, 0, { kind: 'opened', session: 7, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    const session = await opened;
    const bitmap = fakeBitmap();
    const rendered = session.render(0, 2);

    const sent = await waitForSend(worker, 1);

    expect(sent.message).toMatchObject({ kind: 'preview-page', session: 7, pageIndex: 0, scale: 2 });

    respond(worker, 1, { kind: 'page', pageIndex: 0, bitmap });

    await expect(rendered).resolves.toBe(bitmap);
    expect(bitmap.closed).toBe(false);
  });

  /**
   * Зум и прокрутка рождают гонку: страницу спрашивают заново, пока ответ
   * на прежний запрос ещё в пути. Запросы идут по одному — wasm не потокобезопасен, —
   * поэтому старый ответ приходит уже после того, как спросили новый масштаб,
   * и показывать его нельзя.
   */
  it('устаревший растр освобождается, а не показывается', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const opened = client.openPreview(input());

    await waitForSend(worker);
    respond(worker, 0, { kind: 'opened', session: 7, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    const session = await opened;
    const first = fakeBitmap();
    const second = fakeBitmap();
    const old = session.render(0, 1);
    const fresh = session.render(0, 2);

    // Первым уходит старый запрос: очередь пропускает по одному
    await waitForSend(worker, 1);
    respond(worker, 1, { kind: 'page', pageIndex: 0, bitmap: first });

    await expect(old).resolves.toBeNull();
    expect(first.closed).toBe(true);

    // …и только теперь воркер получает свежий
    await waitForSend(worker, 2);
    respond(worker, 2, { kind: 'page', pageIndex: 0, bitmap: second });

    await expect(fresh).resolves.toBe(second);
    expect(second.closed).toBe(false);
  });

  it('закрытие не ждёт воркера и гасит страницы', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const opened = client.openPreview(input());

    await waitForSend(worker);
    respond(worker, 0, { kind: 'opened', session: 7, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    const session = await opened;

    session.close();
    session.close();

    // Признак закрытия ставится сразу: растр больше не спрашивают
    await expect(session.render(0, 1)).resolves.toBeNull();

    const sent = await waitForSend(worker, 1);

    expect(sent.message).toMatchObject({ kind: 'preview-close', session: 7 });
    expect(worker.sent.filter((entry) => entry.message.kind === 'preview-close')).toHaveLength(1);
  });

  /**
   * Сессию мог закрыть воркер — например, её вытеснил новый документ.
   * Для панели это не отказ: страницу уже некому показывать.
   */
  it('отказ по закрытой сессии не поднимается наверх', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const opened = client.openPreview(input());

    await waitForSend(worker);
    respond(worker, 0, { kind: 'opened', session: 7, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    const session = await opened;
    const rendered = session.render(0, 1);

    await waitForSend(worker, 1);
    respond(worker, 1, { kind: 'failed', code: 'engine_preview_stale', message: 'сессия закрыта' });

    await expect(rendered).resolves.toBeNull();
  });

  it('второй документ закрывает первый', async () => {
    const worker = fakeWorker();
    const client = createOfficeClient({ spawn: () => worker });
    const first = client.openPreview(input());

    await waitForSend(worker);
    respond(worker, 0, { kind: 'opened', session: 1, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    const session = await first;
    const second = client.openPreview(input());

    // Закрытие прежней сессии уходит в воркер перед открытием новой
    const closed = await waitForSend(worker, 1);

    expect(closed.message).toMatchObject({ kind: 'preview-close', session: 1 });

    const opened = await waitForSend(worker, 2);

    expect(opened.message).toMatchObject({ kind: 'preview-open' });

    respond(worker, 2, { kind: 'opened', session: 2, pages: [{ width: 10, height: 10 }], sheets: null, skipped: {} });

    await second;
    await expect(session.render(0, 1)).resolves.toBeNull();
  });
});

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
