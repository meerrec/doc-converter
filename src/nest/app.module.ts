/**
 * Корневой модуль NestJS-приложения.
 *
 * Собирает разбор окружения, проверку доступности и все маршруты сервиса:
 * конвертацию, статусы задач и отдачу результатов.
 *
 * Логирование настраивается в `bootstrap.ts`: там создаётся pino-логгер
 * и подключается pino-http.
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller.js';
import { ConvertController } from './http/convert.controller.js';
import { ResultsController } from './http/results.controller.js';
import { StatusController } from './http/status.controller.js';
import { ConversionModule } from './conversion/conversion.module.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { parseEnv } from './config/env.js';

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

    ConversionModule,
  ],
  controllers: [
    HealthController,
    ConvertController,
    StatusController,
    ResultsController,
  ],
  providers: [
    // Ограничитель навешан один раз на всё приложение. В Express-версии он
    // стоял глобально и повторно на маршруте конвертации, из-за чего один
    // POST списывал две единицы бюджета
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
