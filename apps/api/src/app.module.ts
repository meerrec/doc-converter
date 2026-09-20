/**
 * Корневой модуль NestJS-приложения.
 *
 * Собирает разбор окружения, проверку доступности и маршруты сервиса.
 *
 * Логирование настраивается в `bootstrap.ts`: там создаётся pino-логгер
 * и подключается pino-http.
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller.js';
import { XlsxModule } from './xlsx/xlsx.module.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { parseEnv } from './env.js';

/** Корневой модуль приложения. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Разбор падает на старте при некорректном значении переменной:
      // лучше не запуститься, чем отдавать 500 на первом запросе
      validate: (raw: Record<string, unknown>) =>
        parseEnv(raw as NodeJS.ProcessEnv),
    }),

    XlsxModule,
  ],
  controllers: [HealthController],
  providers: [
    // Ограничитель навешан один раз на всё приложение. Раньше стоял глобально
    // и повторно на маршруте конвертации, из-за чего один POST списывал
    // две единицы бюджета
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
