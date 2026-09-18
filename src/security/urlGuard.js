/**
 *Защита от SSRF (Server-Side Request Forgery) атак.
 *
 * Этот модуль проверяет URL на безопасность перед выполнением HTTP-запросов.
 * Основные угрозы:
 * 1. Доступ к внутренним ресурсам (127.0.0.1, 169.254.169.254)
 * 2. DoS через медленные DNS резолвы
 * 3. Утечка данных через external URLs
 * 4. Обход через редиректы
 *
 * Все комментарии на русском языке.
 */

import dns from 'dns/promises';
import net from 'net';
import {
  MAX_URL_LENGTH,
  MAX_REDIRECTS,
  DNS_RESOLVE_TIMEOUT_MS
} from './limits.js';

/**
 * Ошибки, которые может выбрасывать urlGuard.
 */
export class UrlGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = code;
  }
}

/**
 * Приватные IP-диапазоны IPv4 (RFC 1918, RFC 5737, RFC 6598, и др.)
 * Источник: https://en.wikipedia.org/wiki/Private_network
 */
const PRIVATE_IPV4_RANGES = [
  // 0.0.0.0/8
  { start: '0.0.0.0', end: '0.255.255.255' },
  // 10.0.0.0/8
  { start: '10.0.0.0', end: '10.255.255.255' },
  // 100.64.0.0/10 (Shared Address Space, RFC 6598)
  { start: '100.64.0.0', end: '100.127.255.255' },
  // 127.0.0.0/8 (loopback)
  { start: '127.0.0.0', end: '127.255.255.255' },
  // 169.254.0.0/16 (link-local)
  { start: '169.254.0.0', end: '169.254.255.255' },
  // 172.16.0.0/12
  { start: '172.16.0.0', end: '172.31.255.255' },
  // 192.0.0.0/24 (IETF Protocol Assignments)
  { start: '192.0.0.0', end: '192.0.0.255' },
  // 192.0.2.0/24 (TEST-NET-1)
  { start: '192.0.2.0', end: '192.0.2.255' },
  // 192.88.99.0/24 (6to4 relay anycast, RFC 3068)
  { start: '192.88.99.0', end: '192.88.99.255' },
  // 192.168.0.0/16
  { start: '192.168.0.0', end: '192.168.255.255' },
  // 198.18.0.0/15 (Benchmarking, RFC 2544)
  { start: '198.18.0.0', end: '198.19.255.255' },
  // 198.51.100.0/24 (TEST-NET-2)
  { start: '198.51.100.0', end: '198.51.100.255' },
  // 203.0.113.0/24 (TEST-NET-3)
  { start: '203.0.113.0', end: '203.0.113.255' },
  // 224.0.0.0/4 (Multicast)
  { start: '224.0.0.0', end: '239.255.255.255' },
  // 240.0.0.0/4 (Reserved)
  { start: '240.0.0.0', end: '255.255.255.254' },
  // 255.255.255.255 (broadcast)
  { start: '255.255.255.255', end: '255.255.255.255' }
];

/**
 * Приватные IP-диапазоны IPv6
 * Источник: RFC 4291, RFC 4193
 */
const PRIVATE_IPV6_RANGES = [
  // ::1/128 (loopback)
  { start: '::1', end: '::1' },
  // fc00::/7 (Unique Local Address)
  { start: 'fc00::', end: 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' },
  // fe80::/10 (Link-Local Address)
  { start: 'fe80::', end: 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff' },
  // IPv4-mapped IPv6 addresses (::ffff:0:0/96)
  { start: '::ffff:0:0', end: '::ffff:255.255.255.255' }
];

/**
 * Все приватные диапазоны (IPv4 + IPv6) — для документации и внешних проверок.
 */
export const PRIVATE_IP_RANGES = [
  ...PRIVATE_IPV4_RANGES,
  ...PRIVATE_IPV6_RANGES
];

/**
 * Публичный алиас для проверки приватности IP-адреса.
 *
 * @param {string} ip - IP-адрес (IPv4 или IPv6)
 * @returns {boolean} - true, если IP приватный
 */
export function checkPrivateIp(ip) {
  return isPrivateIP(ip);
}

/**
 * Разрешенные схемы URL.
 */
const ALLOWED_SCHEMES = new Set(['http', 'https']);

/**
 * Запрещённые схемы URL.
 */
const FORBIDDEN_SCHEMES = new Set([
  'file', 'ftp', 'gopher', 'data', 'javascript', 'mailto', 'tel', 'ssh'
]);

/**
 * Проверяет, является ли IP-адрес приватным.
 *
 * @param {string} ip - IP-адрес (IPv4 или IPv6)
 * @returns {boolean} - true, если IP приватный
 */
function isPrivateIP(ip) {
  // IPv4
  if (net.isIPv4(ip)) {
    const num = ipToNumber(ip);
    for (const range of PRIVATE_IPV4_RANGES) {
      const startNum = ipToNumber(range.start);
      const endNum = ipToNumber(range.end);
      if (num >= startNum && num <= endNum) {
        return true;
      }
    }
    return false;
  }

  // IPv6
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // ::1/128 (loopback) и :: (unspecified)
    if (normalized === '::1' || normalized === '::') {
      return true;
    }

    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — проверяем вложенный IPv4
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isPrivateIP(mapped[1]);
    }

    // Проверяем диапазоны по первой группе адреса
    const firstGroup = normalized.split(':')[0];
    if (firstGroup.length === 0) {
      return false;
    }

    const first = parseInt(firstGroup, 16);
    if (Number.isNaN(first)) {
      return false;
    }

    // fc00::/7 — Unique Local Address
    if ((first & 0xfe00) === 0xfc00) {
      return true;
    }

    // fe80::/10 — Link-Local Address
    if ((first & 0xffc0) === 0xfe80) {
      return true;
    }

    // ff00::/8 — Multicast
    if ((first & 0xff00) === 0xff00) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Преобразует IPv4 в число для сравнения.
 *
 * @param {string} ip - IPv4 адрес
 * @returns {number} - числовое представление
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(part => parseInt(part, 10));
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/**
 * Резолвит хост и проверяет все A/AAAA записи на приватные диапазоны.
 *
 * @param {string} hostname - хост для проверки
 * @returns {Promise<boolean>} - true, если все IP приватные
 */
async function resolveAndCheckPrivate(hostname) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DNS_RESOLVE_TIMEOUT_MS);
    
    try {
      const addresses = await dns.resolve(hostname, { all: true }, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      for (const addr of addresses) {
        if (isPrivateIP(addr.address)) {
          return true; // Найден приватный IP
        }
      }
      
      return false; // Все IP публичные
    } catch (err) {
      clearTimeout(timeout);
      // Если DNS не резолвится, считаем URL небезопасным
      return true; // Fail-safe: блокируем если не можем проверить
    }
  } catch (err) {
    return true; // Fail-safe
  }
}

/**
 * Резолвит хост и проверяет его адреса на приватность.
 *
 * Публичная обёртка над внутренней проверкой — используется, когда хост
 * нужно проверить отдельно от полной валидации URL.
 *
 * @param {string} hostname - хост для проверки
 * @returns {Promise<{isValid: boolean, error?: string, code?: string}>}
 */
export async function validateDns(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    return {
      isValid: false,
      error: 'Hostname is empty or not a string',
      code: 'url_no_host'
    };
  }

  // IP-литералы не требуют резолва
  if (net.isIP(hostname)) {
    return isPrivateIP(hostname)
      ? {
          isValid: false,
          error: `Private IP address not allowed: ${hostname}`,
          code: 'url_private_ip'
        }
      : { isValid: true };
  }

  const hasPrivateIP = await resolveAndCheckPrivate(hostname);

  return hasPrivateIP
    ? {
        isValid: false,
        error: `Hostname resolves to private IP: ${hostname}`,
        code: 'url_private_ip'
      }
    : { isValid: true };
}

/**
 * Проверяет URL на безопасность.
 *
 * @param {string} url - URL для проверки
 * @param {Object} [options] - опции проверки
 * @param {boolean} [options.allowPrivate=false] - разрешить приватные IP (для тестов)
 * @returns {Promise<{isValid: boolean, error?: string, code?: string}>} - результат проверки
 */
export async function validateUrl(url, options = {}) {
  const { allowPrivate = false } = options;
  
  // Проверка на пустой URL
  if (!url || typeof url !== 'string') {
    return { 
      isValid: false, 
      error: 'URL is empty or not a string',
      code: 'url_malformed'
    };
  }

  // Проверка длины URL
  if (url.length > MAX_URL_LENGTH) {
    return { 
      isValid: false, 
      error: `URL length ${url.length} exceeds maximum ${MAX_URL_LENGTH}`,
      code: 'url_too_long'
    };
  }

  // Парсим URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    // Отделяем «нет хоста» от прочего мусора: new URL('http://') бросает,
    // но по смыслу это именно отсутствие хоста
    if (/^https?:\/\/(\/|$)/i.test(url)) {
      return {
        isValid: false,
        error: 'URL has no hostname',
        code: 'url_no_host'
      };
    }

    return {
      isValid: false,
      error: `Invalid URL: ${err.message}`,
      code: 'url_malformed'
    };
  }

  // WHATWG URL возвращает IPv6-хост в квадратных скобках — нормализуем
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Проверка схемы
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { 
      isValid: false, 
      error: `Forbidden URL scheme: ${scheme}. Only http/https allowed.`,
      code: 'url_scheme_forbidden'
    };
  }

  // Проверка на credentials в URL
  if (parsed.username || parsed.password) {
    return { 
      isValid: false, 
      error: 'Credentials in URL are not allowed',
      code: 'url_credentials_forbidden'
    };
  }

  // Проверка на пустой хост
  if (!hostname) {
    return {
      isValid: false,
      error: 'URL has no hostname',
      code: 'url_no_host'
    };
  }

  // Проверка на localhost
  if (hostname.toLowerCase() === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1') {
    return {
      isValid: false,
      error: `Localhost/loopback address not allowed: ${hostname}`,
      code: 'url_private_ip'
    };
  }

  // Проверка на приватный IP в хосте (если хост — IP, а не домен)
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return {
        isValid: false,
        error: `Private IP address not allowed: ${hostname}`,
        code: 'url_private_ip'
      };
    }

    // Проверяем IPv4-mapped IPv6
    if (hostname.startsWith('::ffff:')) {
      const ipv4 = hostname.slice(7);
      if (isPrivateIP(ipv4)) {
        return {
          isValid: false,
          error: `Private IPv4-mapped IPv6 address not allowed: ${hostname}`,
          code: 'url_private_ip'
        };
      }
    }
  }

  // Проверка на известные приватные хосты
  const privateHosts = ['localhost', 'local', 'internal', 'private', 'intranet'];
  if (privateHosts.some(host => hostname.toLowerCase().includes(host))) {
    return {
      isValid: false,
      error: `Private hostname detected: ${hostname}`,
      code: 'url_private_ip'
    };
  }

  // Резолвим хост и проверяем на приватные IP.
  // Пропускаем, если allowPrivate=true (для тестов).
  // IP-литералы уже проверены выше — резолв для них не нужен.
  if (!allowPrivate && !net.isIP(hostname)) {
    const hasPrivateIP = await resolveAndCheckPrivate(hostname);
    if (hasPrivateIP) {
      return {
        isValid: false,
        error: `Hostname resolves to private IP: ${hostname}`,
        code: 'url_private_ip'
      };
    }
  }

  return { isValid: true };
}

/**
 * Проверяет URL синхронно (без DNS резолва).
 * Используется для быстрого отклонения явно опасных URL.
 *
 * @param {string} url - URL для проверки
 * @returns {{isValid: boolean, error?: string, code?: string}} - результат проверки
 */
export function quickUrlCheck(url) {
  if (!url || typeof url !== 'string') {
    return { isValid: false, error: 'URL is empty', code: 'url_malformed' };
  }

  if (url.length > MAX_URL_LENGTH) {
    return { isValid: false, error: 'URL too long', code: 'url_too_long' };
  }

  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    
    if (!ALLOWED_SCHEMES.has(scheme)) {
      return { isValid: false, error: 'Forbidden scheme', code: 'url_scheme_forbidden' };
    }

    if (parsed.username || parsed.password) {
      return { isValid: false, error: 'Credentials forbidden', code: 'url_credentials_forbidden' };
    }

    if (!parsed.hostname) {
      return { isValid: false, error: 'No hostname', code: 'url_no_host' };
    }

    // Быстрая проверка на очевидные приватные IP
    if (parsed.hostname === 'localhost' || 
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1') {
      return { isValid: false, error: 'Localhost not allowed', code: 'url_private_ip' };
    }

    // Проверка на IPv4-mapped IPv6
    if (parsed.hostname.startsWith('::ffff:')) {
      const ipv4 = parsed.hostname.slice(7);
      if (ipv4 === '127.0.0.1' || ipv4.startsWith('192.168.') || 
          ipv4.startsWith('10.') || ipv4.startsWith('172.16.')) {
        return { isValid: false, error: 'Private IP not allowed', code: 'url_private_ip' };
      }
    }

    return { isValid: true };
  } catch (err) {
    return { isValid: false, error: 'Invalid URL', code: 'url_malformed' };
  }
}

/**
 * Проверяет, что URL использует только разрешённые схемы.
 *
 * @param {string} url - URL для проверки
 * @returns {boolean} - true, если схема разрешена
 */
export function isAllowedScheme(url) {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    return ALLOWED_SCHEMES.has(scheme);
  } catch (err) {
    return false;
  }
}

export default {
  validateUrl,
  validateDns,
  quickUrlCheck,
  isAllowedScheme,
  isPrivateIP,
  checkPrivateIp,
  PRIVATE_IP_RANGES,
  UrlGuardError
};
