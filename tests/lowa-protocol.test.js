/**
 * Протокол обмена между страницей и офисом в воркере.
 *
 * Страница и воркер — разные потоки, и всё, что между ними проходит,
 * проверяется гардами вручную: схемы контракта сюда не годятся, потому что
 * притащили бы в браузерный бандл валидатор. Проверить гарды иначе, чем
 * тестом, нечем — ошибка в них проявится уже в браузере, и не там, где
 * сделана: сообщение неизвестной формы молча отбросится, а ожидание ответа
 * провисит до таймаута.
 *
 * Отдельно проверяется, что коды отказов браузерного пути не пересекаются
 * с серверными: одинаковый код в двух путях означал бы, что клиент
 * не может отличить отказ сервера от отказа вкладки.
 */

import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@doc-converter/contract';
import {
  LOCAL_ERROR_CODES,
  isBridgeRequest,
  isBridgeResponse,
} from '../apps/web/src/local/lowa/protocol.js';

describe('протокол браузерного офиса: ответы', () => {
  it('принимает сообщение о готовности', () => {
    expect(isBridgeResponse({ kind: 'ready' })).toBe(true);
  });

  it('принимает успешный ответ с результатом', () => {
    expect(isBridgeResponse({ kind: 'done', id: 1, result: { outputBytes: 1281 } })).toBe(true);

    // Результат допускается и пустой: у закрытия документа его нет
    expect(isBridgeResponse({ kind: 'done', id: 2, result: null })).toBe(true);
  });

  it('принимает отказ с известным кодом', () => {
    expect(isBridgeResponse({ kind: 'failed', id: 3, code: 'lowa_oom', message: 'память' })).toBe(
      true
    );
  });

  it('отбрасывает сообщения неизвестного вида', () => {
    for (const value of [
      null,
      undefined,
      42,
      'ready',
      {},
      { kind: 'unknown' },
      // Сообщение сборки, которое воркер может получить в свой порт
      { cmd: 'ZetaHelper::run_thr_script' },
    ]) {
      expect(isBridgeResponse(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('отбрасывает ответ без идентификатора запроса', () => {
    expect(isBridgeResponse({ kind: 'done' })).toBe(false);
    expect(isBridgeResponse({ kind: 'done', id: '1' })).toBe(false);
    expect(isBridgeResponse({ kind: 'done', id: -1 })).toBe(false);
  });

  it('отбрасывает отказ с чужим кодом', () => {
    // Серверный код в браузерном ответе — признак того, что стороны
    // разошлись: такого кода здесь быть не может
    expect(isBridgeResponse({ kind: 'failed', id: 1, code: 'storage_unavailable', message: '' })).toBe(
      false
    );
    expect(isBridgeResponse({ kind: 'failed', id: 1, code: 'lowa_oom' })).toBe(false);
  });
});

describe('протокол браузерного офиса: запросы', () => {
  /** Запрос на конвертацию — самая объёмная форма, у неё больше всего полей. */
  const CONVERT = {
    kind: 'convert',
    id: 1,
    source: '/tmp/input.xlsx',
    target: '/tmp/output.pdf',
    filterName: 'calc_pdf_Export',
    filterData: [{ name: 'SelectPdfVersion', value: 2 }],
    scaleToPages: true,
  };

  it('принимает все виды запросов', () => {
    expect(isBridgeRequest(CONVERT)).toBe(true);
    expect(isBridgeRequest({ kind: 'preview', id: 2, source: '/tmp/input.xlsx' })).toBe(true);
    expect(isBridgeRequest({ kind: 'close', id: 3 })).toBe(true);
    expect(isBridgeRequest({ kind: 'memory', id: 4 })).toBe(true);
  });

  it('принимает конвертацию без параметров экспорта', () => {
    // Пустой FilterData допустим: экспорт без параметров — это базовый PDF
    expect(isBridgeRequest({ ...CONVERT, filterData: [] })).toBe(true);
  });

  it('требует идентификатор у любого запроса', () => {
    const { id, ...withoutId } = CONVERT;

    expect(id).toBe(1);
    expect(isBridgeRequest(withoutId)).toBe(false);
  });

  it('отбрасывает запрос с неполными полями', () => {
    for (const field of ['source', 'target', 'filterName', 'filterData', 'scaleToPages']) {
      const broken = { ...CONVERT, [field]: undefined };

      expect(isBridgeRequest(broken), `без поля ${field}`).toBe(false);
    }
  });

  it('отбрасывает запросы неизвестного вида', () => {
    expect(isBridgeRequest({ kind: 'delete-everything', id: 1 })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
  });
});

describe('коды отказов браузерного пути', () => {
  it('не пересекаются с серверными', () => {
    const server = new Set(ERROR_CODES);

    for (const code of LOCAL_ERROR_CODES) {
      expect(server.has(code), `код ${code} есть и на сервере`).toBe(false);
    }
  });

  it('названы с общим префиксом', () => {
    // Префикс — единственное, что отличает код браузерного пути в журнале
    // от серверного, когда они попадают в одно место
    for (const code of LOCAL_ERROR_CODES) {
      expect(code.startsWith('lowa_'), code).toBe(true);
    }
  });
});
