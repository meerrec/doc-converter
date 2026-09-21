/**
 * Модуль конвертации документов в PDF.
 *
 * Подключает контроллер и сервис конвертации. Зависимостей через DI нет:
 * очереди, хранилище и состояние задач — модульные синглтоны, которые
 * одинаково доступны и API, и воркеру, а провайдеры Nest сделали бы их
 * недоступными во втором процессе.
 */

import { Module } from '@nestjs/common';
import { ConversionController } from './conversion.controller.js';
import { ConversionService } from './conversion.service.js';

/** Модуль конвертации. */
@Module({
  controllers: [ConversionController],
  providers: [ConversionService],
})
export class ConversionModule {}
