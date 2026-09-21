/**
 * Маршруты конвертации в PDF.
 *
 * `POST /convert/to-pdf` принимает файл в multipart/form-data вместе
 * с необязательными параметрами конвертации; `GET /convert/status/:id`
 * отдаёт состояние задачи и ссылку на готовый PDF.
 *
 * Маршрут один на оба входных формата: расширение из имени файла — подсказка,
 * а не доказательство, и выбирать по нему способ конвертации значило бы
 * доверять клиенту там, где содержимое можно проверить.
 *
 * Все комментарии на русском языке.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  conversionOptionsSchema,
  type ConversionOptions,
  type ConvertAccepted,
  type JobStatusResponse,
} from '@doc-converter/contract';
import { AppError } from '../common/app-error.js';
import { ConversionService } from './conversion.service.js';
import { MAX_FILE_BYTES } from '@doc-converter/config';

/** Шаблон идентификатора задачи: сервис выдаёт UUID v4. */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Разбирает параметры конвертации из полей формы.
 *
 * Поля multipart приходят строками, поэтому схема контракта разбирает
 * булевы и числовые значения явно. Сообщение об ошибке собирается из всех
 * замечаний сразу: клиенту полезнее увидеть полный список, чем править
 * параметры по одному.
 *
 * @param body - тело запроса
 * @returns разобранные параметры
 * @throws {AppError} - если параметры некорректны
 */
function parseOptions(body: unknown): ConversionOptions {
  const result = conversionOptionsSchema.safeParse(body ?? {});

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'параметр'}: ${issue.message}`)
      .join('; ');

    throw new AppError('invalid_option_value', `Некорректные параметры: ${details}`, 400);
  }

  return result.data;
}

/** Контроллер конвертации. */
@Controller('convert')
export class ConversionController {
  /**
   * @param conversionService - сервис конвертации
   */
  constructor(private readonly conversionService: ConversionService) {}

  /**
   * Принимает файл и ставит задачу на конвертацию.
   *
   * @param file - загруженный файл
   * @param body - параметры конвертации
   * @returns идентификатор задачи и её характеристики
   */
  @Post('to-pdf')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_BYTES,
        files: 1,
      },
    })
  )
  async convert(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown
  ): Promise<ConvertAccepted> {
    if (!file) {
      throw new AppError('file_required', 'В запросе нет файла в поле «file»', 400);
    }

    const options = parseOptions(body);

    // Имя без расширения — не ошибка: формат определяется по содержимому,
    // а расширение из имени нужно только для сверки с ним
    return this.conversionService.submit(file.buffer, file.originalname ?? 'document', options);
  }

  /**
   * Отдаёт состояние задачи.
   *
   * @param id - идентификатор задачи
   * @returns состояние и ссылка на результат
   */
  @Get('status/:id')
  async status(@Param('id') id: string): Promise<JobStatusResponse> {
    if (!JOB_ID_PATTERN.test(id)) {
      throw new AppError('invalid_request', 'Идентификатор задачи имеет неверный формат', 400);
    }

    return this.conversionService.getStatus(id);
  }
}
