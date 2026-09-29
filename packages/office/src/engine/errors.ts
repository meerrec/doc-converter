/**
 * Отказы своего движка (BetterOffice): коды и тексты.
 *
 * Коды отделены от кодов сборки LibreOffice (`protocol.ts`) намеренно: причины
 * отказов у путей разные — там не поднялась сборка, здесь не разложился
 * документ, — и общий список заставлял бы искать причину не в том движке.
 * Общее у обоих путей одно: ни один из этих кодов не встречается на сервере,
 * поэтому в журнале браузерный отказ отличим от серверного.
 *
 * Все комментарии на русском языке.
 */

/** Коды отказов своего движка. */
export const ENGINE_ERROR_CODES = [
  /** Модуль движка не загрузился: wasm, шрифты или память вкладки. */
  'engine_load_failed',
  /** Документ не разобран или не разложен по страницам. */
  'engine_convert_failed',
  /** Формат или параметр, которых движок не умеет. */
  'engine_unsupported',
] as const;

/** Код отказа своего движка. */
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/** Что показать пользователю при отказе. */
export const ENGINE_ERROR_MESSAGES: Readonly<Record<EngineErrorCode, string>> = {
  engine_load_failed: 'Не удалось загрузить движок конвертации. Обновите страницу и попробуйте снова.',
  engine_convert_failed: 'Документ не удалось разложить по страницам: возможно, файл повреждён.',
  engine_unsupported: 'Этот документ или выбранные параметры браузерный движок пока не поддерживает.',
};

/** Отказ своего движка с кодом причины. */
export class EngineError extends Error {
  /** Код отказа. */
  readonly code: EngineErrorCode;

  /**
   * @param code - код отказа
   * @param message - описание для журнала
   */
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
