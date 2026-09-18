/**
 * Маршрут получения статуса задачи
 * 
 * Отвечает за:
 * - Получение статуса задачи по taskId
 * - Возврат информации о задаче
 * - Поддержка long polling (в будущем)
 * 
 * Endpoint: GET /status/:taskId
 * 
 * Ответ:
 * - 200 OK: информация о задаче
 * - 404 Not Found: задача не найдена
 * 
 * Пример ответа:
 * {
 *   "taskId": "task-123",
 *   "status": "completed",
 *   "progress": 100,
 *   "result": {
 *     "fileUrl": "/storage/results/task-123.pdf",
 *     "fileType": "pdf",
 *     "size": 12345
 *   }
 * }
 */

import express from 'express';
import { getJobInfo, getJobStatus, getJobProgress } from '../../queue/conversionQueue.js';
import { getTaskInfo, getTaskStatus, getTaskResult } from '../../queue/idempotency.js';
import { getRequestId } from '../middleware/requestId.js';
import { logRejection } from '../middleware/auditLog.js';

const router = express.Router();

/**
 * Получает статус задачи
 * 
 * @route GET /status/:taskId
 */
router.get('/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const requestId = getRequestId(req);
  const ip = req.ip || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  
  try {
    // Проверяем задачу в Valkey (идемпотентность)
    const taskInfo = await getTaskInfo(taskId);
    
    if (!taskInfo) {
      // Проверяем задачу в очереди BullMQ
      const jobInfo = await getJobInfo(taskId);
      
      if (!jobInfo) {
        logRejection({
          requestId,
          ip,
          ua,
          code: 'task_not_found',
          taskId,
        });
        
        return res.status(404).json({
          error: 'task_not_found',
          message: `Task ${taskId} not found`,
          taskId,
        });
      }
      
      // Задача в очереди
      return res.json({
        taskId,
        status: jobInfo.state,
        progress: jobInfo.progress || 0,
        queued: true,
        timestamp: jobInfo.timestamp,
      });
    }
    
    // Задача в Valkey
    const status = taskInfo.status || 'processing';
    const result = taskInfo.result || null;
    
    // Формируем ответ
    const response = {
      taskId,
      status,
      progress: status === 'completed' ? 100 : (status === 'processing' ? 50 : 0),
    };
    
    // Если есть результат - добавляем его
    if (result && status === 'completed') {
      response.result = {
        fileUrl: result.fileUrl,
        fileType: result.fileType,
        size: result.size,
      };
    }
    
    // Если есть ошибка
    if (result && (status === 'failed' || result.error)) {
      response.error = {
        code: result.errorCode || 'conversion_failed',
        message: result.error || 'Unknown error',
      };
    }
    
    // Устанавливаем заголовки
    res.setHeader('X-Task-Id', taskId);
    
    res.json(response);
  } catch (err) {
    logRejection({
      requestId,
      ip,
      ua,
      code: 'status_check_failed',
      taskId,
      message: err.message,
    });
    
    res.status(500).json({
      error: 'status_check_failed',
      message: err.message,
      taskId,
    });
  }
});

/**
 * Получает статусы нескольких задач
 * 
 * @route GET /status
 * @query {string[]} taskIds - массив идентификаторов задач
 */
router.get('/', async (req, res) => {
  const requestId = getRequestId(req);
  const taskIds = req.query.taskIds;
  
  if (!taskIds || !Array.isArray(taskIds)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'taskIds query parameter is required and must be an array',
    });
  }
  
  try {
    const tasks = [];
    
    for (const taskId of taskIds) {
      try {
        const taskInfo = await getTaskInfo(taskId);
        
        if (taskInfo) {
          tasks.push({
            taskId,
            status: taskInfo.status,
            progress: taskInfo.status === 'completed' ? 100 : 50,
            result: taskInfo.result,
          });
        } else {
          const jobInfo = await getJobInfo(taskId);
          
          if (jobInfo) {
            tasks.push({
              taskId,
              status: jobInfo.state,
              progress: jobInfo.progress || 0,
              queued: true,
            });
          } else {
            tasks.push({
              taskId,
              status: 'not_found',
            });
          }
        }
      } catch {
        tasks.push({
          taskId,
          status: 'error',
        });
      }
    }
    
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({
      error: 'batch_status_check_failed',
      message: err.message,
    });
  }
});

export default router;
