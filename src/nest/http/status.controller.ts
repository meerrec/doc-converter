/**
 * GET /status/:taskId и GET /status?taskIds=… — состояние задач.
 *
 * Пакетный вариант существует ради экономии лимита частоты: один запрос
 * на всю пачку вместо запроса на задачу. Ответы повторяют прежние дословно —
 * интерфейс сопоставляет статусы по `taskId` и разбирает поля `result`,
 * `error` и `queued`.
 *
 * Пачка читается одной командой MGET на весь запрос: опрос статусов — самый
 * частый запрос к Valkey, и раньше он обходился в четыре команды на задачу.
 */

import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getTaskInfo, getTasksInfo, type TaskInfo } from '../../queue/idempotency.js';
import { MAX_STATUS_BATCH_IDS } from '../../config/index.js';
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

    // Потолок на размер пачки: она превращается в один MGET на 2×N ключей,
    // и без ограничения один запрос забирал бы несоразмерно много ресурсов
    // Valkey при том, что лимит частоты считает запросы, а не идентификаторы
    if (ids.length > MAX_STATUS_BATCH_IDS) {
      res.status(400).json({
        error: 'invalid_request',
        message: `Слишком много идентификаторов: не более ${MAX_STATUS_BATCH_IDS} за запрос`,
      });
      return;
    }

    try {
      // Одна команда на всю пачку; состояние каждой задачи уже прочитано
      const infos = await getTasksInfo(ids);

      const tasks = await Promise.all(
        infos.map((info, index) => this.describe(ids[index] as string, info))
      );

      res.json({ tasks });
    } catch {
      // Valkey недоступен. Раньше каждая задача деградировала по отдельности,
      // и запрос оставался успешным — поведение сохранено: иначе один обрыв
      // связи превращал бы опрос пачки в 500, а клиент не отличал бы
      // недоступность хранилища от собственной ошибки запроса
      res.json({
        tasks: ids.map((taskId) => ({ taskId, status: 'error' })),
      });
    }
  }

  /**
   * Собирает описание одной задачи для пакетного ответа.
   *
   * @param taskId - идентификатор задачи
   * @param taskInfo - состояние из Valkey (null, если задачи там нет)
   * @returns описание задачи
   */
  private async describe(
    taskId: string,
    taskInfo: TaskInfo | null
  ): Promise<Record<string, unknown>> {
    try {
      if (taskInfo) {
        const status = taskInfo.status;
        const result = taskInfo.result as
          | { error?: string; errorCode?: string }
          | null;

        const payload: Record<string, unknown> = {
          taskId,
          status,
          progress: status === 'completed' ? 100 : status === 'processing' ? 50 : 0,
        };

        // Поле `result` сохраняется как было: интерфейс читает из него fileUrl.
        // Ошибка дополнительно раскрывается в `error` — раньше в пакетном
        // ответе его не было, и текст ошибки до интерфейса не доходил
        if (result) {
          payload.result = result;

          if (status === 'failed' || result.error) {
            payload.error = {
              code: result.errorCode || 'conversion_failed',
              message: result.error || 'Unknown error',
            };
          }
        }

        return payload;
      }

      // В Valkey задачи нет: она могла не дойти до очереди либо её состояние
      // уже истекло. BullMQ — единственный оставшийся источник сведений
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
