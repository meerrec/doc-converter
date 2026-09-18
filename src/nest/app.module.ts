/**
 * Корневой модуль NestJS-приложения.
 *
 * Собирает проверку доступности и разбор окружения. Маршруты конвертации,
 * статусов и результатов подключаются на следующем этапе переноса; до тех пор
 * запросы к ним обслуживает существующее Express-приложение.
 *
 * Логирование настраивается в `bootstrap.ts`: там создаётся pino-логгер
 * и подключается pino-http — так же, как это устроено в Express-версии.
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller.js';
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
  ],
  controllers: [HealthController],
  providers: [
    // Ограничитель навешан один раз на всё приложение. В Express-версии он
    // стоял глобально и повторно на маршруте конвертации, из-за чего один
    // POST списывал две единицы бюджета
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
