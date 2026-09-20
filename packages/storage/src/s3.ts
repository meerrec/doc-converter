/**
 * Объектное хранилище (MinIO / S3): входные файлы и результаты конвертации.
 *
 * Зачем объектное хранилище вместо файловой системы: реплики воркеров
 * масштабируются горизонтально и могут оказаться на разных хостах, поэтому
 * «общий каталог» перестаёт быть общим. Через хранилище же отдаётся и
 * результат — presigned-ссылкой, без проксирования файла через API.
 *
 * Клиентов два: операции идут через внутренний адрес (`minio:9000` в сети
 * compose), а presigned-ссылки подписываются публичным (`localhost:9000`) —
 * подпись включает хост, и ссылка с внутренним именем у клиента не откроется.
 *
 * Все комментарии на русском языке.
 */

import { createRequire } from 'node:module';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  S3_ACCESS_KEY,
  S3_BUCKET,
  S3_ENDPOINT,
  S3_INPUT_PREFIX,
  S3_PORT,
  S3_PUBLIC_ENDPOINT,
  S3_PUBLIC_PORT,
  S3_PUBLIC_USE_SSL,
  S3_REGION,
  S3_RESULT_PREFIX,
  S3_SECRET_KEY,
  S3_USE_SSL,
  PRESIGN_EXPIRY_SEC,
} from '@doc-converter/config';

// Пакет minio поставляет CommonJS без вызываемого экспорта по умолчанию:
// при `module: NodeNext` обычный импорт даёт пространство имён, а не класс.
const require = createRequire(import.meta.url);

/** Минимальная форма клиента MinIO, которая используется в сервисе. */
interface MinioClient {
  putObject(
    bucket: string,
    objectName: string,
    stream: Buffer | NodeJS.ReadableStream,
    size?: number
  ): Promise<unknown>;
  getObject(bucket: string, objectName: string): Promise<NodeJS.ReadableStream>;
  presignedGetObject(bucket: string, objectName: string, expiry: number): Promise<string>;
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region?: string): Promise<void>;
}

/**
 * Таймаут проверки доступности хранилища.
 *
 * 5 секунд: проверка идёт из `/health` и healthcheck'а контейнера, и ответ
 * нужен быстрее, чем сработает сетевой таймаут SDK. Отдельная константа,
 * а не общий лимит операций: сама загрузка файла может идти дольше.
 */
const HEALTH_TIMEOUT_MS = 5000;

type MinioConstructor = new (options: {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
}) => MinioClient;

/** Конструктор клиента MinIO. */
const Minio = (require('minio') as { Client: MinioConstructor }).Client;

/** Клиент для операций с объектами (внутренний адрес). */
let internalClient: MinioClient | null = null;

/** Клиент для подписи ссылок (публичный адрес). */
let publicClient: MinioClient | null = null;

/**
 * Возвращает клиент для операций.
 *
 * @returns клиент MinIO
 */
function getClient(): MinioClient {
  if (!internalClient) {
    internalClient = new Minio({
      endPoint: S3_ENDPOINT,
      port: S3_PORT,
      useSSL: S3_USE_SSL,
      accessKey: S3_ACCESS_KEY,
      secretKey: S3_SECRET_KEY,
      region: S3_REGION,
    });
  }

  return internalClient;
}

/**
 * Возвращает клиент для подписи presigned-ссылок.
 *
 * @returns клиент MinIO с публичным адресом
 */
function getPublicClient(): MinioClient {
  if (!publicClient) {
    publicClient = new Minio({
      endPoint: S3_PUBLIC_ENDPOINT,
      port: S3_PUBLIC_PORT,
      useSSL: S3_PUBLIC_USE_SSL,
      accessKey: S3_ACCESS_KEY,
      secretKey: S3_SECRET_KEY,
      region: S3_REGION,
    });
  }

  return publicClient;
}

// ===========================================================================
// Ключи объектов
// ===========================================================================

/**
 * Ключ входного файла.
 *
 * @param jobId - идентификатор задачи
 * @param extension - расширение файла без точки
 * @returns ключ объекта
 */
export function inputKey(jobId: string, extension: string): string {
  return `${S3_INPUT_PREFIX}/${jobId}.${extension}`;
}

/**
 * Ключ результата.
 *
 * @param jobId - идентификатор задачи
 * @returns ключ объекта
 */
export function resultKey(jobId: string): string {
  return `${S3_RESULT_PREFIX}/${jobId}.pdf`;
}

// ===========================================================================
// Операции
// ===========================================================================

/**
 * Загружает входной файл в хранилище.
 *
 * @param key - ключ объекта
 * @param data - содержимое файла
 * @throws {Error} - если загрузка не удалась
 */
export async function putObject(key: string, data: Buffer): Promise<void> {
  try {
    await getClient().putObject(S3_BUCKET, key, data, data.length);
  } catch (err) {
    // Бакет мог не успеть создаться (сервис minio-init ещё работает) или его
    // удалили. Создаём и пробуем один раз: иначе первая же задача падает
    // с невнятной ошибкой хранилища
    if (!isMissingBucketError(err)) {
      throw err;
    }

    await ensureBucket();
    await getClient().putObject(S3_BUCKET, key, data, data.length);
  }
}

/**
 * Проверяет, что ошибка означает отсутствующий бакет.
 *
 * MinIO отдаёт `NoSuchBucket` в поле `code`, S3 — тот же код; у некоторых
 * совместимых реализаций он приходит только в тексте сообщения.
 *
 * @param err - ошибка операции
 * @returns true, если бакета нет
 */
function isMissingBucketError(err: unknown): boolean {
  const error = err as { code?: string; message?: string };

  return error?.code === 'NoSuchBucket' || Boolean(error?.message?.includes('does not exist'));
}

/**
 * Загружает в хранилище файл с диска.
 *
 * Читается потоком: PDF большого документа — десятки мегабайт, и держать
 * его целиком в памяти воркера незачем, тем более что рядом живёт
 * LibreOffice, которому память нужнее.
 *
 * @param key - ключ объекта
 * @param filePath - путь к файлу на диске
 * @returns размер загруженного файла в байтах
 */
export async function putFile(key: string, filePath: string): Promise<number> {
  const stats = await stat(filePath);

  await getClient().putObject(S3_BUCKET, key, createReadStream(filePath), stats.size);

  return stats.size;
}

/**
 * Скачивает объект в локальный файл.
 *
 * Пишем потоком, а не в память: файл до 100 МБ на каждой задаче — заметная
 * доля памяти воркера, а UNO всё равно работает с путём, а не с буфером.
 *
 * @param key - ключ объекта
 * @param destination - путь к файлу на диске
 */
export async function downloadToFile(key: string, destination: string): Promise<void> {
  const stream = await getClient().getObject(S3_BUCKET, key);
  await pipeline(stream, createWriteStream(destination));
}

/**
 * Проверяет, доступно ли хранилище и существует ли бакет.
 *
 * @returns true, если хранилище отвечает и бакет на месте
 */
export async function checkStorageHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    // Проверка вызывается из /health и из healthcheck контейнера, то есть
    // раз в 30 секунд. Без собственного таймаута недоступное хранилище
    // подвешивало бы ответ на время сетевого таймаута SDK
    const exists = await withTimeout(getClient().bucketExists(S3_BUCKET), HEALTH_TIMEOUT_MS);

    if (!exists) {
      return { healthy: false, error: `Бакет ${S3_BUCKET} не найден` };
    }

    return { healthy: true };
  } catch (err) {
    return { healthy: false, error: (err as Error).message };
  }
}

/**
 * Ограничивает ожидание промиса.
 *
 * @param promise - ожидаемая операция
 * @param timeoutMs - предельное время ожидания
 * @returns результат операции
 * @throws {Error} - если операция не завершилась вовремя
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Превышен таймаут обращения к хранилищу (${timeoutMs} мс)`)),
      timeoutMs
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Создаёт presigned-ссылку на результат.
 *
 * @param key - ключ объекта
 * @returns ссылка и момент её истечения
 */
export async function presignedResultUrl(
  key: string
): Promise<{ url: string; expiresAt: string }> {
  const url = await getPublicClient().presignedGetObject(S3_BUCKET, key, PRESIGN_EXPIRY_SEC);

  return {
    url,
    expiresAt: new Date(Date.now() + PRESIGN_EXPIRY_SEC * 1000).toISOString(),
  };
}

/**
 * Создаёт бакет, если его нет.
 *
 * Вызывается сервисом `minio-init` в compose и при старте API: `putObject`
 * в отсутствующий бакет падает с невнятной ошибкой, а «создать при первом
 * обращении» в многопоточном API — гонка.
 */
export async function ensureBucket(): Promise<void> {
  const client = getClient();

  if (!(await client.bucketExists(S3_BUCKET))) {
    await client.makeBucket(S3_BUCKET, S3_REGION);
  }
}

export default {
  inputKey,
  resultKey,
  putObject,
  putFile,
  downloadToFile,
  presignedResultUrl,
  checkStorageHealth,
  ensureBucket,
};
