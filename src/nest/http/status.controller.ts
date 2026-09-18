/**
 * GET /status/:taskId и GET /status?taskIds=… — состояние задач.
 *
 * Пакетный вариант существует ради экономии лимита частоты: один запрос
 * на всю пачку вместо запроса на задачу. Ответы повторяют прежние дословно —
 * интерфейс сопоставляет статусы по `taskId` и разбирает поля `result`,
 * `error` и `queued`.
 */

import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getTaskInfo } from '../../queue/idempotency.js';
import { getJobInfo } from '../../queue/conversionQueue.js';
import { logRejection } from '../common/audit-log.js';
import type { RequestWithId } from '../common/request-id.middleware.js';

/** Тело ответа об ошибке с привязкой к задаче. */
interface TaskErrorBody {
  error: string;
  message: string;
  taskId: string;
}

/** Маршрут состояния задач. */
@Controller('status')
export class StatusController {
  /**
   * Отдаёт состояние одной задачи.
   *
   * @param taskId - идентификатор задачи
   * @param req - входящий запрос
   * @param res - ответ
   */
  @Get(':taskId')
  async single(
    @Param('taskId') taskId: string,
    @Req() req: RequestWithId,
    @Res() res: Response
  ): Promise<void> {
    const requestId = req.requestId;
    const ip = req.ip;
    const ua = req.headers['user-agent'];

    try {
      const taskInfo = await getTaskInfo(taskId);

      if (!taskInfo) {
        const jobInfo = await getJobInfo(taskId);

        if (!jobInfo) {
          logRejection({ requestId, ip, ua, code: 'task_not_found', taskId });

          const body: TaskErrorBody = {
            error: 'task_not_found',
            message: `Task ${taskId} not found`,
            taskId,
          };

          res.status(404).json(body);
          return;
        }

        // Задача есть только в очереди: статус берётся из BullMQ
        res.json({
          taskId,
          status: jobInfo.state,
          progress: jobInfo.progress || 0,
          queued: true,
          timestamp: jobInfo.timestamp,
        });
        return;
      }

      const status: string = taskInfo.status || 'processing';
      const result = taskInfo.result as
        | { fileUrl?: string; fileType?: string; size?: number; error?: string; errorCode?: string }
        | null;

      const payload: Record<string, unknown> = {
        taskId,
        status,
        progress: status === 'completed' ? 100 : status === 'processing' ? 50 : 0,
      };

      if (result && status === 'completed') {
        payload.result = {
          fileUrl: result.fileUrl,
          fileType: result.fileType,
          size: result.size,
        };
      }

      if (result && (status === 'failed' || result.error)) {
        payload.error = {
          code: result.errorCode || 'conversion_failed',
          message: result.error || 'Unknown error',
        };
      }

      res.setHeader('X-Task-Id', taskId);
      res.json(payload);
    } catch (error) {
      const message = (error as { message?: string }).message ?? 'Status check failed';

      logRejection({
        requestId,
        ip,
        ua,
        code: 'status_check_failed',
        taskId,
        message,
      });

      const body: TaskErrorBody = {
        error: 'status_check_failed',
        message,
        taskId,
      };

      res.status(500).json(body);
    }
  }

  /**
   * Отдаёт состояния пачки задач.
   *
   * @param taskIds - идентификаторы задач
   * @param res - ответ
   */
  @Get()
  async batch(
    @Query('taskIds') taskIds: string | string[],
    @Res() res: Response
  ): Promise<void> {
    if (!taskIds) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'taskIds query parameter is required',
      });
      return;
    }

    // Повторяющийся параметр Express разбирает в массив, одиночный приходит
    // строкой. Принимаются обе формы: одиночный идентификатор — осознанное
    // расширение контракта (400 отдаётся только при отсутствии параметра).
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];

    try {
      const tasks = await Promise.all(ids.map((id) => this.describe(id)));

      res.json({ tasks });
    } catch (error) {
      res.status(500).json({
        error: 'batch_status_check_failed',
        message: (error as { message?: string }).message ?? 'Batch status check failed',
      });
    }
  }

  /**
   * Собирает описание одной задачи для пакетного ответа.
   *
   * @param taskId - идентификатор задачи
   * @returns описание задачи
   */
  private async describe(taskId: string): Promise<Record<string, unknown>> {
    try {
      const taskInfo = await getTaskInfo(taskId);

      if (taskInfo) {
        return {
          taskId,
          status: taskInfo.status,
          progress: taskInfo.status === 'completed' ? 100 : 50,
          result: taskInfo.result,
        };
      }

      const jobInfo = await getJobInfo(taskId);

      if (jobInfo) {
        return {
          taskId,
          status: jobInfo.state,
          progress: jobInfo.progress || 0,
          queued: true,
        };
      }

      return { taskId, status: 'not_found' };
    } catch {
      return { taskId, status: 'error' };
    }
  }
}
