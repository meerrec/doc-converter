/**
 * Подготовка изображений документа к встраиванию в PDF.
 *
 * PDF умеет ровно две вещи, которые здесь нужны: поток zlib с построчными
 * фильтрами (это и есть PNG) и JPEG как есть (`/DCTDecode`). Поэтому JPEG
 * не перекодируется — он попадает в файл исходными байтами, а PNG
 * раскладывается на цвет и прозрачность: альфа-канала в PDF нет, вместо него
 * отдельный объект-маска (`/SMask`).
 *
 * Все комментарии на русском языке.
 */

import { decode as decodePng } from 'fast-png';

/** Цвет и прозрачность картинки, разложенные по отдельным каналам. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** Байты RGB, по три на пиксель. */
  readonly rgb: Uint8Array;
  /** Байты прозрачности, по одному на пиксель; `null` — картинка непрозрачна. */
  readonly alpha: Uint8Array | null;
}

/** JPEG, готовый к встраиванию без перекодирования. */
export interface JpegImage {
  readonly width: number;
  readonly height: number;
  /** Число компонент: 1 — оттенки серого, 3 — RGB, 4 — CMYK. */
  readonly components: number;
  readonly bytes: Uint8Array;
}

/** Что удалось разобрать. */
export type DecodedImage = { readonly kind: 'raster'; readonly image: RasterImage } | { readonly kind: 'jpeg'; readonly image: JpegImage };

/**
 * Определяет формат по сигнатуре.
 *
 * По сигнатуре, а не по расширению или mime из `data:`-ссылки: и то и другое
 * приходит из документа, а документ — чужой. Ошибка здесь не косметическая:
 * байты JPEG, объявленные PNG, попали бы в PDF как поток zlib и превратились
 * в мусор.
 *
 * @param bytes - байты картинки
 * @returns формат или `null`, если он не поддержан
 */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }

  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  return null;
}

/**
 * Разбирает картинку.
 *
 * @param bytes - байты картинки
 * @returns разобранная картинка
 */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  const format = sniffImage(bytes);

  if (format === 'jpeg') {
    return { kind: 'jpeg', image: readJpeg(bytes) };
  }

  if (format === 'png') {
    return { kind: 'raster', image: readPng(bytes) };
  }

  throw new Error('картинка не распознана: ни PNG, ни JPEG');
}

/**
 * Раскладывает PNG на цвет и прозрачность.
 *
 * @param bytes - байты PNG
 * @returns цвет и прозрачность
 */
function readPng(bytes: Uint8Array): RasterImage {
  const png = decodePng(bytes);
  const { width, height, depth } = png;
  const pixels = width * height;
  const source = png.data;

  // Палитровые PNG приходят индексами: цвет лежит отдельной таблицей.
  // Разворачиваем здесь, потому что в PDF палитра — отдельный цветовой
  // подход со своей таблицей, а картинок таких в документах мало
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let transparent = false;

  for (let index = 0; index < pixels; index += 1) {
    let red: number;
    let green: number;
    let blue: number;
    let opacity = 255;

    if (png.palette !== undefined) {
      const entry = png.palette[source[index] ?? 0] ?? [0, 0, 0];

      [red = 0, green = 0, blue = 0, opacity = 255] = entry;
    } else {
      const stride = png.channels;
      // Глубина 16 бит на канал: PDF ждёт 8, и старший байт — та же
      // яркость с точностью, которую видно глазом
      const step = depth === 16 ? 2 : 1;
      const at = index * stride;
      const read = (channel: number): number => source[at + channel * step] ?? 0;

      if (stride === 1) {
        red = green = blue = read(0);
      } else {
        red = read(0);
        green = read(1);
        blue = read(2);

        if (stride === 4) {
          opacity = read(3);
        }
      }
    }

    rgb[index * 3] = red;
    rgb[index * 3 + 1] = green;
    rgb[index * 3 + 2] = blue;
    alpha[index] = opacity;

    if (opacity !== 255) {
      transparent = true;
    }
  }

  return { width, height, rgb, alpha: transparent ? alpha : null };
}

/**
 * Читает из JPEG размеры и число компонент.
 *
 * Нужен разбор заголовков: `/DCTDecode` встраивает байты как есть, но словарь
 * картинки обязан объявить ширину, высоту и цветовое пространство, а взять
 * их больше неоткуда.
 *
 * @param bytes - байты JPEG
 * @returns размеры и число компонент
 */
function readJpeg(bytes: Uint8Array): JpegImage {
  let offset = 2; // сигнатура SOI

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);

    // SOF0…SOF15 — заголовок кадра; SOF4, SOF8 и SOF12 зарезервированы,
    // а SOF14 встречается в арифметическом кодировании, которое здесь не нужно
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
        components: bytes[offset + 9] ?? 3,
        bytes,
      };
    }

    // Маркеры без полезной нагрузки: у них нет поля длины
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    offset += 2 + length;
  }

  throw new Error('в JPEG не найден заголовок кадра');
}
