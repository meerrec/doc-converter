/**
 * Проверка содержимого файла: сигнатуры формата и архивные контейнеры.
 *
 * Единственная реализация на весь сервис. До переноса проверка была написана
 * трижды — в валидаторе запроса, в его обработчике и в `worker/processor.js`, —
 * причём результат `validateZip` разбирался только в валидаторе. Два других
 * вызова выглядели как защита, но пропускали нарушения: zip-бомба, превышение
 * числа записей и опасные имена внутри архива не отклонялись. Здесь результат
 * проверяется всегда.
 */

import { Injectable } from '@nestjs/common';
import { isErrorCode } from '@doc-converter/contract';
import { zipContainerFormatSet } from '@doc-converter/contract';
import { checkMagicBytes } from '../../security/magicBytes.js';
import { validateZip } from '../../security/zipGuard.js';
import { AppError } from '../common/app-error.js';

/** Статус ответа при несовпадении сигнатуры файла с объявленным форматом. */
const MAGIC_MISMATCH_STATUS = 415;

/** Статус ответа при нарушении ограничений архива. */
const ARCHIVE_VIOLATION_STATUS = 422;

/** Проверка содержимого загруженного файла. */
@Injectable()
export class ContentValidator {
  /**
   * Проверяет, что содержимое соответствует объявленному формату
   * и не нарушает ограничения на архивы.
   *
   * @param buffer - содержимое файла
   * @param declaredFormat - формат, объявленный клиентом
   * @throws {AppError} - если файл не прошёл проверку
   */
  async validate(buffer: Buffer, declaredFormat: string): Promise<void> {
    this.validateMagicBytes(buffer, declaredFormat);

    if (zipContainerFormatSet.has(declaredFormat.toLowerCase())) {
      await this.validateArchive(buffer);
    }
  }

  /**
   * Сверяет сигнатуру файла с объявленным форматом.
   *
   * @param buffer - содержимое файла
   * @param declaredFormat - формат, объявленный клиентом
   * @throws {AppError} - при несовпадении
   */
  private validateMagicBytes(buffer: Buffer, declaredFormat: string): void {
    const result = checkMagicBytes(buffer, declaredFormat);

    if (result.valid) {
      return;
    }

    const code = isErrorCode(result.error?.errorCode)
      ? result.error.errorCode
      : 'magic_mismatch';

    throw new AppError(
      code,
      result.error?.message ?? 'Содержимое файла не совпадает с объявленным форматом',
      MAGIC_MISMATCH_STATUS
    );
  }

  /**
   * Проверяет архивный контейнер.
   *
   * `validateZip` бросает исключение только на повреждённом архиве; нарушения
   * ограничений возвращаются в результате, и их нужно разобрать явно.
   *
   * @param buffer - содержимое архива
   * @throws {AppError} - при нарушении ограничений
   */
  private async validateArchive(buffer: Buffer): Promise<void> {
    const result = await validateZip(buffer);

    if (result.isValid) {
      return;
    }

    const violation = result.firstViolation;

    if (!violation) {
      return;
    }

    throw new AppError(
      isErrorCode(violation.code) ? violation.code : 'content_validation_failed',
      violation.message,
      ARCHIVE_VIOLATION_STATUS
    );
  }
}
