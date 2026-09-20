/**
 * Отметки времени последнего снижения числа реплик.
 *
 * Хранятся в Valkey, а не в памяти процесса. Локальная отметка обнулялась при
 * каждом рестарте автоскейлера — пересборка образа, `docker compose up -d`,
 * падение, срабатывание `restart: unless-stopped`, — а `canScaleDown` при
 * нулевой отметке отвечает «можно». Первый же цикл после рестарта гасил
 * реплики немедленно и с `force=1`, то есть SIGKILL по конвертациям в полёте;
 * на тяжёлой очереди, где cooldown задуман как десять минут, это означало
 * потерю активных задач при каждом деплое.
 *
 * При недоступном Valkey отметку прочитать нельзя, и решение о снижении
 * не принимается: не погасить реплику безопаснее, чем погасить лишнюю.
 * Исключение пробрасывается наверх — там его обрабатывает цикл по уровням.
 *
 * Все комментарии на русском языке.
 */

import type { ComplexityTier } from '@doc-converter/contract';
import { AUTOSCALER_COOLDOWN_TTL_SEC, QUEUE_PREFIX } from '@doc-converter/config';
import { getRedisClient } from '@doc-converter/queue';

/**
 * Ключ отметки для уровня сложности.
 *
 * Префикс очереди в ключе — по той же причине, что и в именах очередей:
 * сервис может делить Redis с другими приложениями, и ключи не должны
 * пересекаться.
 *
 * @param tier - уровень сложности
 * @returns ключ в Redis
 */
function cooldownKey(tier: ComplexityTier): string {
  return `${QUEUE_PREFIX}.autoscaler.cooldown.${tier}`;
}

/**
 * Читает время последнего снижения числа реплик.
 *
 * @param tier - уровень сложности
 * @returns время в миллисекундах; 0 — снижения ещё не было
 * @throws {Error} - если Valkey недоступен
 */
export async function readScaleDownAt(tier: ComplexityTier): Promise<number> {
  const client = await getRedisClient();
  const raw = await client.get(cooldownKey(tier));

  if (!raw) {
    return 0;
  }

  const value = Number(raw);

  // Испорченное значение трактуется как «снижения не было»: это разрешает
  // гашение, но не отменяет проверку cooldown в целом
  return Number.isFinite(value) ? value : 0;
}

/**
 * Записывает время снижения числа реплик.
 *
 * @param tier - уровень сложности
 * @param at - время в миллисекундах
 * @throws {Error} - если Valkey недоступен
 */
export async function writeScaleDownAt(tier: ComplexityTier, at: number): Promise<void> {
  const client = await getRedisClient();

  await client.set(cooldownKey(tier), String(at), 'EX', AUTOSCALER_COOLDOWN_TTL_SEC);
}

export default { readScaleDownAt, writeScaleDownAt };
