/**
 * Типы контракта API конвертера.
 *
 * Повторяют схему запроса из src/api/middleware/validate.js и ответы
 * маршрутов convert.js / status.js. Все поля, кроме перечисленных
 * в ConversionRequest, сервер отвергает с ошибкой unknown_field,
 * поэтому лишние свойства добавлять нельзя.
 */

/** Статус задачи в жизненном цикле конвертации. */
export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  /** Задача зарезервирована, но статус ещё не записан. */
  | 'unknown'
  /** В пакетном ответе: задачи нет ни в Valkey, ни в очереди. */
  | 'not_found';

/** Результат успешной конвертации. */
export interface TaskResult {
  fileUrl: string;
  fileType: string;
  size?: number;
}

/** Ошибка обработки задачи. */
export interface TaskError {
  code: string;
  message: string;
}

/** Ответ GET /status/:taskId и элемент пакетного ответа. */
export interface TaskStatusResponse {
  taskId: string;
  status: TaskStatus;
  progress: number;
  result?: TaskResult;
  error?: TaskError;
  /** true, если задача найдена только в очереди BullMQ. */
  queued?: boolean;
}

/** Ответ GET /status?taskIds=... */
export interface BatchStatusResponse {
  tasks: TaskStatusResponse[];
}

/** Тело ошибки API: единый формат { error, message, taskId? }. */
export interface ApiErrorBody {
  error: string;
  message: string;
  taskId?: string;
  requestId?: string;
}

/** Параметры отрисовки документа (поле documentLayout). */
export interface DocumentLayout {
  drawPlaceHolders?: boolean;
  drawFormHighlight?: boolean;
}

/** Параметры листа (поле spreadsheetLayout). */
export interface SpreadsheetLayout {
  pageSize?: { width?: string; height?: string };
  margins?: { left?: string; right?: string; top?: string; bottom?: string };
  fitToWidth?: number;
  fitToHeight?: number;
  orientation?: 'portrait' | 'landscape';
}

/** Опции конвертации, которые пользователь задаёт в интерфейсе. */
export interface ConversionOptions {
  codePage?: number;
  delimiter?: number;
  region?: string;
  password?: string;
  documentLayout?: DocumentLayout;
  spreadsheetLayout?: SpreadsheetLayout;
}

/** Тело запроса POST /ConvertService.ashx. */
export interface ConversionRequest extends ConversionOptions {
  filetype: string;
  outputtype: string;
  data: string;
  key: string;
  title?: string;
  /**
   * Интерфейс всегда работает через очередь: синхронный путь не сохраняет
   * файл результата, поэтому скачать его afterwards было бы нельзя.
   */
  async: true;
}

/** Ответ POST /ConvertService.ashx в асинхронном режиме. */
export interface ConversionAcceptedResponse {
  status: 'queued';
  taskId: string;
  message?: string;
  /** Присутствует, если по этому key задача уже была выполнена ранее. */
  result?: TaskResult;
}

/** Ответ GET /health. */
export interface HealthResponse {
  status: string;
  wasm: boolean;
  version: string;
}
