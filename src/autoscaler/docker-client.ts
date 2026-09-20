/**
 * Минимальный клиент Docker API для управления репликами воркеров.
 *
 * Реализован на `node:http` поверх unix-сокета: Docker CLI в образе нет,
 * а ради четырёх вызовов тянуть библиотеку (`dockerode` и её зависимости)
 * незачем.
 *
 * Клиент намеренно умеет только то, что нужно масштабированию: перечислить
 * свои контейнеры, создать, запустить и удалить. Ни `exec`, ни сборка
 * образов, ни работа с томами не поддерживаются — доступ к сокету и без
 * того равносилен root-правам на хосте, и расширять его поверхность
 * без необходимости не следует.
 *
 * Все комментарии на русском языке.
 */

import http from 'node:http';
import {
  AUTOSCALER_NETWORK,
  AUTOSCALER_WORKER_IMAGE,
  DOCKER_SOCKET_PATH,
  S3_ACCESS_KEY,
  S3_BUCKET,
  S3_ENDPOINT,
  S3_PORT,
  S3_SECRET_KEY,
  TIER_CONVERSION_TIMEOUTS,
  UNO_PORT,
  WORKER_MEMORY_LIMIT_MB,
} from '../config/index.js';

/** Метка, по которой autoscaler находит созданные им контейнеры. */
export const WORKER_LABEL = 'doc-converter.role=uno-worker';

/** Описание контейнера, как его отдаёт Docker API. */
interface ContainerSummary {
  /** Идентификатор контейнера. */
  Id: string;
  /** Имена (с ведущим слешем). */
  Names: string[];
  /** Состояние: running, exited и т. д. */
  State: string;
  /** Метки контейнера. */
  Labels: Record<string, string>;
}

/** Ответ Docker API на создание контейнера. */
interface CreateContainerResponse {
  /** Идентификатор созданного контейнера. */
  Id: string;
}

/** Результат HTTP-вызова. */
interface DockerResponse<T> {
  /** Код ответа. */
  status: number;
  /** Разобранное тело. */
  body: T | null;
  /** Текст тела, если JSON разобрать не удалось. */
  raw: string;
}

/**
 * Выполняет запрос к Docker API.
 *
 * @param method - HTTP-метод
 * @param path - путь вида `/containers/json`
 * @param body - тело запроса (сериализуется в JSON)
 * @returns код ответа и тело
 */
function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<DockerResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });

        res.on('end', () => {
          let parsed: T | null = null;

          try {
            parsed = raw ? (JSON.parse(raw) as T) : null;
          } catch {
            // Docker отвечает текстом на часть ошибок, например на 404
          }

          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`Docker API недоступен (${DOCKER_SOCKET_PATH}): ${err.message}`));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

/**
 * Проверяет доступность Docker API.
 *
 * @returns true, если демон отвечает
 */
export async function ping(): Promise<boolean> {
  try {
    const response = await request<unknown>('GET', '/_ping');
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Проверяет, что образ воркера существует локально.
 *
 * Без этого первая же попытка поднять реплику падает с «No such image»,
 * и причина видна только в логе autoscaler'а. Проверка на старте переводит
 * это в понятное предупреждение.
 *
 * @param image - имя образа с тегом
 * @returns true, если образ есть в локальном хранилище
 */
export async function imageExists(image: string): Promise<boolean> {
  try {
    const response = await request<unknown>('GET', `/images/${encodeURIComponent(image)}/json`);
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Перечисляет контейнеры воркеров, созданные autoscaler'ом.
 *
 * @returns список контейнеров с метками
 */
export async function listWorkerContainers(): Promise<ContainerSummary[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [WORKER_LABEL] }));
  const response = await request<ContainerSummary[]>(
    'GET',
    `/containers/json?all=1&filters=${filters}`
  );

  return response.body ?? [];
}

/**
 * Собирает переменные окружения для контейнера-воркера.
 *
 * Autoscaler не читает окружение API напрямую: он передаёт воркеру то, что
 * нужно для подключения к Redis и хранилищу. Значения берутся из его
 * собственного окружения — в compose это те же переменные, что у сервисов.
 *
 * @param tier - уровень сложности (он же очередь)
 * @returns список строк вида `KEY=value`
 */
function buildEnv(tier: 'light' | 'medium' | 'heavy'): string[] {
  const env: string[] = [
    `WORKER_QUEUE=${tier}`,
    `UNO_PORT=${UNO_PORT}`,
    `S3_ENDPOINT=${S3_ENDPOINT}`,
    `S3_PORT=${S3_PORT}`,
    `S3_ACCESS_KEY=${S3_ACCESS_KEY}`,
    `S3_SECRET_KEY=${S3_SECRET_KEY}`,
    `S3_BUCKET=${S3_BUCKET}`,
    // Бюджет конвертации зависит от уровня: у тяжёлой очереди он вдвое
    // больше. Без этого реплика, поднятая autoscaler'ом, обрывала бы
    // длинные конвертации, которые стартовая реплика доводит до конца
    `CONVERSION_TIMEOUT_MS=${TIER_CONVERSION_TIMEOUTS[tier]}`,
    // Домашний каталог в tmpfs: fontconfig пишет кэш шрифтов в ~/.cache,
    // а корневая ФС контейнера только для чтения. Без этого каждая
    // конвертация ругается на недоступный кэш и пересканирует шрифты
    'HOME=/tmp',
  ];

  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;

  if (redisHost) {
    env.push(`REDIS_HOST=${redisHost}`);
  }

  if (redisPort) {
    env.push(`REDIS_PORT=${redisPort}`);
  }

  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  if (publicEndpoint) {
    env.push(`S3_PUBLIC_ENDPOINT=${publicEndpoint}`);
  }

  const publicPort = process.env.S3_PUBLIC_PORT;

  if (publicPort) {
    env.push(`S3_PUBLIC_PORT=${publicPort}`);
  }

  return env;
}

/**
 * Создаёт и запускает контейнер-воркер.
 *
 * @param tier - уровень сложности
 * @param index - порядковый номер реплики (входит в имя)
 * @returns идентификатор контейнера
 * @throws {Error} - если контейнер не создался или не запустился
 */
export async function createWorkerContainer(
  tier: 'light' | 'medium' | 'heavy',
  index: number
): Promise<string> {
  const name = `doc-converter-uno-${tier}-${index}-${Date.now().toString(36)}`;

  const created = await request<CreateContainerResponse>(
    'POST',
    `/containers/create?name=${encodeURIComponent(name)}`,
    {
      Image: AUTOSCALER_WORKER_IMAGE,
      Env: buildEnv(tier),
      Labels: {
        'doc-converter.role': 'uno-worker',
        'doc-converter.tier': tier,
        // Метка «этой репликой управляет autoscaler». Стартовые реплики
        // compose её не имеют: их нельзя удалять, иначе `restart: unless-stopped`
        // вернёт контейнер обратно и autoscaler будет бороться с compose
        'doc-converter.managed': 'autoscaler',
        // Метка с образом помогает при разборе: реплики из старого образа
        // видно сразу
        'doc-converter.image': AUTOSCALER_WORKER_IMAGE,
      },
      HostConfig: {
        NetworkMode: AUTOSCALER_NETWORK,
        AutoRemove: false,
        // Реплика живёт до решения autoscaler'а; память ограничена, чтобы
        // «убежавший» LibreOffice не выел хост целиком
        Memory: WORKER_MEMORY_LIMIT_MB * 1024 * 1024,
        // Профиль LibreOffice пишется в /tmp — корневая ФС только для чтения
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'size=1g,mode=1777' },
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        PidsLimit: 256,
      },
    }
  );

  if (created.status !== 201 || !created.body?.Id) {
    throw new Error(`Не удалось создать контейнер: ${created.raw}`);
  }

  const started = await request<unknown>('POST', `/containers/${created.body.Id}/start`);

  // 304 означает «уже запущен» — для нас это успех
  if (started.status !== 204 && started.status !== 304) {
    throw new Error(`Не удалось запустить контейнер: ${started.raw}`);
  }

  return created.body.Id;
}

/**
 * Останавливает и удаляет контейнер.
 *
 * @param id - идентификатор контейнера
 */
export async function removeWorkerContainer(id: string): Promise<void> {
  // force=1: реплика может не отвечать на SIGTERM, если зависла в LibreOffice
  await request<unknown>('DELETE', `/containers/${id}?force=1&v=0`);
}

export default {
  ping,
  imageExists,
  listWorkerContainers,
  createWorkerContainer,
  removeWorkerContainer,
  WORKER_LABEL,
};
