/**
 * Модуль конвейера конвертации.
 *
 * Импортируется обоими приложениями: API (синхронный путь) и воркером
 * (асинхронный). Логика подготовки и проверок здесь одна на двоих.
 */

import { Module } from '@nestjs/common';
import { ContentValidator } from './content-validator.js';
import { ConversionService } from './conversion.service.js';
import { UrlSource } from './url-source.js';

/** Модуль конвейера конвертации. */
@Module({
  providers: [ContentValidator, UrlSource, ConversionService],
  exports: [ConversionService],
})
export class ConversionModule {}
