/**
 * Модуль конвертации XLSX → PDF.
 *
 * Подключает контроллер и сервис конвертации. Зависимостей через DI нет:
 * очереди, хранилище и состояние задач — модульные синглтоны, которые
 * одинаково доступны и API, и воркеру, а провайдеры Nest сделали бы их
 * недоступными во втором процессе.
 */

import { Module } from '@nestjs/common';
import { XlsxController } from './xlsx.controller.js';
import { XlsxService } from './xlsx.service.js';

/** Модуль конвертации. */
@Module({
  controllers: [XlsxController],
  providers: [XlsxService],
})
export class XlsxModule {}
