/**
 * Ограничитель частоты запросов на IP.
 *
 * ## Почему не @nestjs/throttler
 *
 * Конфигурация сервиса описывает **две** величины: `RATE_PER_SEC` —
 * поддерживаемую скорость и `RATE_BURST` — допустимый всплеск. Это ровно
 * модель «ведра с токенами»: ёмкость `RATE_BURST`, пополнение `RATE_PER_SEC`
 * в секунду. Всплеск из двух десятков запросов проходит сразу, но устойчивая
 * скорость ограничена пятью в секунду.
 *
 * `@nestjs/throttler` считает запросы в скользящем окне. Чтобы выразить обе
 * величины, пришлось бы завести два независимых окна, и срабатывало бы
 * строгое из них — то есть `RATE_BURST` не значил бы ничего. Взять одно окно
 * на `RATE_BURST` — значит потерять ограничение устойчивой скорости.
 * Поэтому ведро реализовано здесь явно: так обе константы сохраняют смысл,
 * заложенный в них при обосновании.
 *
 * ## Что исправлено по сравнению с прежней реализацией
 *
 * В прежней реализации (Express-слой) условие было записано как
 * `count < RATE_PER_SEC || count <= RATE_BURST`, и при `RATE_BURST=20` вторая
 * ветка перекрывала первую всегда: фактический потолок составлял 21 запрос
 * в секунду, а `RATE_PER_SEC` не влиял ни на что. Счётчик к тому же
 * увеличивался уже после проверки, то есть отставал на один запрос.
 */

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AppError } from './app-error.js';

/** Состояние ведра для одного адреса. */
interface Bucket {
  /** Доступные токены. */
  tokens: number;
  /** Момент последнего пополнения (мс). */
  updatedAt: number;
  /** Когда ведро последний раз запрашивали — для очистки. */
  seenAt: number;
}

/**
 * Период очистки неиспользуемых ведёр (мс).
 *
 * Обоснование: ведро без запросов полностью восстанавливается за
 * `RATE_BURST / RATE_PER_SEC` секунд, поэтому хранение дольше пяти минут
 * не имеет смысла и только занимает память.
 */
const CLEANUP_INTERVAL_MS = 300000;

/** Возраст ведра, после которого оно удаляется (мс). */
const BUCKET_TTL_MS = 300000;

/** Результат попытки взять токен. */
interface TakeResult {
  /** Разрешён ли запрос. */
  allowed: boolean;
  /** Сколько токенов осталось. */
  remaining: number;
  /** Через сколько секунд повторять, если запрос отклонён. */
  retryAfterSec: number;
  /** Когда ведро снова наполнится целиком (unix-время в секундах). */
  resetAtSec: number;
}

/** Ограничитель частоты на IP. */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  /**
   * @param config - конфигурация с параметрами ограничителя
   */
  constructor(config: ConfigService) {
    // Значения читаются при создании приложения, а не при импорте модуля:
    // тесты выставляют лимиты в beforeAll, и чтение на уровне модуля
    // происходило бы раньше — настройка терялась бы
    this.capacity = config.get<number>('RATE_BURST') ?? 20;
    this.refillPerMs = (config.get<number>('RATE_PER_SEC') ?? 5) / 1000;

    // unref: таймер не должен удерживать процесс живым. Прежняя реализация
    // вешала обычный setInterval и не снимала его, из-за чего тесты
    // завершались только через --forceExit
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Снимает таймер очистки при остановке приложения. */
  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Проверяет, можно ли пропустить запрос.
   *
   * @param context - контекст выполнения
   * @returns true, если запрос разрешён
   * @throws {AppError} - при превышении лимита
   */
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Предварительные запросы CORS не расходуют бюджет
    if (request.method === 'OPTIONS') {
      return true;
    }

    const result = this.take(this.clientIp(request));

    this.setHeaders(response, result);

    if (!result.allowed) {
      throw new AppError(
        'rate_limited',
        `Слишком много запросов. Повторите через ${result.retryAfterSec} с`,
        429
      );
    }

    return true;
  }

  /**
   * Определяет адрес клиента с учётом прокси.
   *
   * @param request - входящий запрос
   * @returns адрес клиента
   */
  private clientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    // Заголовок может прийти как массив, если прокинут несколько раз
    const firstForwarded = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded?.split(',')[0]?.trim();

    return request.ip ?? firstForwarded ?? request.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * Пытается взять токен из ведра адреса.
   *
   * @param ip - адрес клиента
   * @returns результат попытки
   */
  private take(ip: string): TakeResult {
    const now = Date.now();
    let bucket = this.buckets.get(ip);

    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now, seenAt: now };
      this.buckets.set(ip, bucket);
    }

    // Пополняем пропорционально прошедшему времени
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    bucket.seenAt = now;

    // Время до появления одного токена и до полного ведра
    const msToNextToken = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
    const msToFull = Math.ceil((this.capacity - bucket.tokens) / this.refillPerMs);
    const resetAtSec = Math.floor((now + msToFull) / 1000);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;

      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSec: 0,
        resetAtSec,
      };
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(msToNextToken / 1000)),
      resetAtSec,
    };
  }

  /**
   * Проставляет заголовки ограничителя.
   *
   * @param response - ответ
   * @param result - результат попытки
   */
  private setHeaders(response: Response, result: TakeResult): void {
    response.setHeader('X-RateLimit-Limit', String(this.capacity));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetAtSec));

    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSec));
    }
  }

  /** Удаляет ведра, к которым давно не обращались. */
  private cleanup(): void {
    const now = Date.now();

    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.seenAt > BUCKET_TTL_MS) {
        this.buckets.delete(ip);
      }
    }
  }
}
