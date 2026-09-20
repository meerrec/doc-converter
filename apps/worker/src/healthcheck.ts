/**
 * Проверка готовности UNO-бриджа — healthcheck контейнера воркера.
 *
 * Запускается как отдельный процесс и завершается кодом 0 или 1. Проверка
 * идёт через тот же Python-скрипт с флагом `--ping`: подключиться к UNO
 * из Node нельзя, это отдельный протокол, а проверять «порт открыт» смысла
 * не имеет — сокет принимает соединения раньше, чем бридж готов обслуживать
 * вызовы, и healthcheck проходил бы на ещё не поднявшемся LibreOffice.
 */

import { spawn } from 'node:child_process';
import { PYTHON_BIN, UNO_SCRIPT_PATH, UNO_CONNECT_TIMEOUT_MS } from '@doc-converter/config';

/**
 * Проверяет бридж и завершает процесс соответствующим кодом.
 */
function runHealthCheck(): void {
  const child = spawn(PYTHON_BIN, [UNO_SCRIPT_PATH, '--ping'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    console.error('Проверка UNO превысила таймаут');
    process.exit(1);
  }, UNO_CONNECT_TIMEOUT_MS);

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    console.error('Не удалось запустить проверку:', err.message);
    process.exit(1);
  });

  child.on('close', (code) => {
    clearTimeout(timer);

    if (code === 0) {
      console.log('UNO bridge is ready');
      process.exit(0);
    }

    console.error('UNO bridge недоступен:', stderr.trim().split('\n').pop() ?? `код ${code}`);
    process.exit(1);
  });
}

runHealthCheck();
