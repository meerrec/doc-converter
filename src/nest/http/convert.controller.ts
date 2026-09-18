/**
 * POST /ConvertService.ashx — конвертация документа.
 *
 * Маршрут совместим с Р7-Офис, поэтому формы ответов и статусы сохранены
 * дословно: синхронный путь отвечает `{ status: 'success', fileUrl, fileType,
 * taskId }`, асинхронный — 202 `{ status: 'queued', taskId, message }`,
 * повторный запрос с тем же ключом — 202 с текущим состоянием задачи,
 * конфликт параметров — 409.
 *
 * Обработка идёт через `@Res()`: синхронный путь выставляет заголовки,
 * отвечает по таймеру и следит за обрывом соединения — это не выражается
 * декларативной формой Nest.
 */

import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import {
  conversionRequestSchema,
  type ConversionOptions,
  type ConversionRequest,
} from '@doc-converter/contract';
import { SYNC_ENABLED, SYNC_TIMEOUT_MS } from '../../config/index.js';
import {
  checkKeyConflict,
  getTaskInfo,
  reserveTaskId,
  saveTaskMetadata,
  setTaskStatus,
} from '../../queue/idempotency.js';
import { addConversionJob } from '../../queue/conversionQueue.js';
import { writeResult } from '../../storage/fileStorage.js';
import { ConversionRequestPipe } from './validation.pipe.js';
import {
  logConversionError,
  logRejection,
  logSuccess,
} from '../common/audit-log.js';
import {
  ConversionService,
  type ConversionContext,
} from '../conversion/conversion.service.js';
import type { RequestWithId } from '../common/request-id.middleware.js';

/** Срок хранения статуса задачи, установленного из API (в секундах). */
const API_STATUS_TTL_SEC = SYNC_TIMEOUT_MS / 1000;

/** Ответ асинхронного пути. */
interface QueuedResponse {
  status: string;
  taskId: string;
  message?: string;
  result?: unknown;
}

/** Ответ синхронного пути при успехе. */
interface SyncSuccessResponse {
  status: 'success';
  fileUrl: string;
  fileType: string;
  taskId: string;
}

/** Маршрут конвертации. */
@Controller('ConvertService.ashx')
export class ConvertController {
  /**
   * @param conversion - конвейер конвертации
   */
  constructor(private readonly conversion: ConversionService) {}

  /**
   * Обрабатывает запрос на конвертацию.
   *
   * @param body - разобранное тело запроса
   * @param req - входящий запрос
   * @param res - ответ
   */
  @Post()
  @HttpCode(200)
  @UsePipes(new ConversionRequestPipe(conversionRequestSchema))
  async convert(
    @Body() body: ConversionRequest,
    @Req() req: RequestWithId,
    @Res() res: Response
  ): Promise<void> {
    const requestId = req.requestId;
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    const started = Date.now();

    const source = { url: body.url, data: body.data };
    const options: ConversionOptions = {
      codePage: body.codePage,
      delimiter: body.delimiter,
      region: body.region,
      password: body.password,
      documentLayout: body.documentLayout,
      spreadsheetLayout: body.spreadsheetLayout,
      documentRenderer: body.documentRenderer,
      thumbnail: body.thumbnail,
    };

    if (body.async === false && !SYNC_ENABLED) {
      logRejection({ requestId, ip, ua, code: 'sync_disabled' });

      this.fail(res, 501, 'sync_disabled', 'Synchronous mode is disabled');
      return;
    }

    // Содержимое проверяется до обращения к очереди и хранилищу задач —
    // так же, как это делал middleware в Express-версии. Иначе запрос
    // с заведомо негодным файлом упирался бы в доступность Valkey
    const prepared = await this.conversion.checkSource(source, body.filetype);

    const taskId = body.key || randomUUID();
    const reserved = await this.reserve(taskId, body, requestId, ip, ua, res);

    if (!reserved) {
      return;
    }

    await saveTaskMetadata(taskId, {
      filetype: body.filetype,
      outputtype: body.outputtype,
      url: body.url,
      data: Boolean(body.data),
      timestamp: Date.now(),
    });

    const buffer = await this.conversion.obtainInput(source, prepared, body.filetype);

    await setTaskStatus(taskId, 'processing', API_STATUS_TTL_SEC);

    if (body.async) {
      await this.enqueue(taskId, buffer, body, options, requestId, res);
      return;
    }

    await this.convertSync(taskId, buffer, body, options, {
      requestId,
      ip,
      ua,
      started,
      res,
    });
  }

  /**
   * Резервирует идентификатор задачи, обрабатывая повторный запрос.
   *
   * @param taskId - идентификатор задачи
   * @param body - тело запроса
   * @param requestId - идентификатор запроса
   * @param ip - адрес клиента
   * @param ua - User-Agent
   * @param res - ответ
   * @returns true, если задачу нужно обрабатывать дальше
   */
  private async reserve(
    taskId: string,
    body: ConversionRequest,
    requestId: string | undefined,
    ip: string | undefined,
    ua: string | undefined,
    res: Response
  ): Promise<boolean> {
    const { reserved, existing } = await reserveTaskId(taskId);

    if (reserved) {
      return true;
    }

    const info = await getTaskInfo(taskId);

    if (!info) {
      const payload: QueuedResponse = {
        status: existing || 'processing',
        taskId,
      };

      res.status(202).json(payload);
      return false;
    }

    const conflict = await checkKeyConflict(taskId, {
      filetype: body.filetype,
      outputtype: body.outputtype,
    });

    if (conflict.conflict) {
      logRejection({ requestId, ip, ua, code: 'key_conflict', taskId });

      res.status(409).json({
        error: 'key_conflict',
        message: 'Task with same key but different parameters already exists',
        taskId,
        existingTaskId: taskId,
      });
      return false;
    }

    const payload: QueuedResponse = {
      status: info.status || 'processing',
      taskId,
    };

    if (info.result) {
      payload.result = info.result;
    }

    res.status(202).json(payload);
    return false;
  }

  /**
   * Ставит задачу в очередь и отвечает 202.
   *
   * @param taskId - идентификатор задачи
   * @param buffer - содержимое исходного файла
   * @param body - тело запроса
   * @param options - опции конвертации
   * @param requestId - идентификатор запроса
   * @param res - ответ
   */
  private async enqueue(
    taskId: string,
    buffer: Buffer,
    body: ConversionRequest,
    options: ConversionOptions,
    requestId: string | undefined,
    res: Response
  ): Promise<void> {
    await addConversionJob({
      taskId,
      inputBuffer: buffer.toString('base64'),
      inputFormat: body.filetype,
      outputFormat: body.outputtype,
      options,
      requestId,
    });

    await setTaskStatus(taskId, 'queued', API_STATUS_TTL_SEC);

    logSuccess({ requestId, taskId, fileType: body.outputtype });

    res.setHeader('X-Task-Id', taskId);
    res.status(202).json({
      status: 'queued',
      taskId,
      message: 'Task added to queue',
    } satisfies QueuedResponse);
  }

  /**
   * Выполняет синхронную конвертацию и отдаёт результат.
   *
   * @param taskId - идентификатор задачи
   * @param buffer - содержимое исходного файла
   * @param body - тело запроса
   * @param options - опции конвертации
   * @param ctx - контекст выполнения
   */
  private async convertSync(
    taskId: string,
    buffer: Buffer,
    body: ConversionRequest,
    options: ConversionOptions,
    ctx: {
      requestId: string | undefined;
      ip: string | undefined;
      ua: string | undefined;
      started: number;
      res: Response;
    }
  ): Promise<void> {
    const { requestId, ip, ua, started, res } = ctx;
    let disconnected = false;

    // Слушаем именно ответ: у запроса событие 'close' приходит и при штатном
    // завершении, из-за чего сервер считал клиента ушедшим
    const onDisconnect = (): void => {
      if (!res.writableFinished) {
        disconnected = true;
      }
    };

    res.on('close', onDisconnect);

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        onDisconnect();

        res.status(504).json({
          error: 'sync_timeout',
          message: `Sync request timeout after ${SYNC_TIMEOUT_MS}ms`,
          taskId,
        });
      }
    }, SYNC_TIMEOUT_MS);

    const context: ConversionContext = { requestId, taskId, isSync: true };

    try {
      const outcome = await this.conversion.convert(
        buffer,
        body.filetype,
        body.outputtype,
        options,
        context
      );

      clearTimeout(timer);

      if (disconnected) {
        logRejection({ requestId, ip, ua, code: 'client_disconnected', taskId });
        return;
      }

      if (!outcome.success || !outcome.result) {
        await setTaskStatus(taskId, 'failed', API_STATUS_TTL_SEC);

        const code = outcome.error?.errorCode ?? 'conversion_failed';

        logConversionError({
          requestId,
          taskId,
          code,
          message: outcome.error?.message,
          durationMs: Date.now() - started,
        });

        this.fail(res, 500, code, outcome.error?.message ?? 'Conversion failed', taskId);
        return;
      }

      // Результат сохраняется — ссылка в ответе должна работать. Раньше
      // синхронный путь формировал fileUrl, ничего не записывая
      const saved = await writeResult(taskId, outcome.result, body.outputtype);

      await setTaskStatus(taskId, 'completed', API_STATUS_TTL_SEC);

      logSuccess({
        requestId,
        taskId,
        fileType: body.outputtype,
        size: outcome.result.length,
        durationMs: Date.now() - started,
      });

      res.setHeader('X-Task-Id', taskId);

      const payload: SyncSuccessResponse = {
        status: 'success',
        fileUrl: saved.fileUrl,
        fileType: body.outputtype,
        taskId,
      };

      res.json(payload);
    } catch (error) {
      clearTimeout(timer);

      try {
        await setTaskStatus(taskId, 'failed', API_STATUS_TTL_SEC);
      } catch {
        // Ошибку статуса не подменяем исходной
      }

      const appError = error as { errorCode?: string; statusCode?: number; message?: string };

      logConversionError({
        requestId,
        taskId,
        code: appError.errorCode ?? 'internal',
        message: appError.message,
        durationMs: Date.now() - started,
      });

      this.fail(
        res,
        appError.statusCode ?? 500,
        appError.errorCode ?? 'internal',
        appError.message ?? 'Conversion failed',
        taskId
      );
    } finally {
      res.off('close', onDisconnect);
    }
  }

  /**
   * Отдаёт ошибку в формате контракта.
   *
   * @param res - ответ
   * @param status - HTTP-статус
   * @param code - код ошибки
   * @param message - сообщение
   * @param taskId - идентификатор задачи, если известен
   */
  private fail(
    res: Response,
    status: number,
    code: string,
    message: string,
    taskId?: string
  ): void {
    const body: Record<string, unknown> = { error: code, message };

    if (taskId !== undefined) {
      body.taskId = taskId;
    }

    res.status(status).json(body);
  }
}
