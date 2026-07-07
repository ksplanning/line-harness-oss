import type { Context, Next } from 'hono';
import { FEATURE_LABELS } from '@line-crm/shared';
import type { Env } from '../index.js';
import { mapPathToFeature } from './permission-map.js';
import { resolvePermissions } from './permissions.js';

/**
 * 機能単位 ON/OFF 権限の enforcement (G64 / failure_observable #1 の要)。
 * index.ts の authMiddleware **直後** に app.use('*', permissionMiddleware) で 1 箇所挿入し、
 * 全 /api route を 1 点で gate する (per-router に散らさない = drift 回避)。
 *
 * 非対称 fail-closed が「既存挙動 byte-identical」と「custom role は確実に締める」を両立させる要:
 *   - built-in role (role_id NULL) の未マップ path → allow (現状 byte-identical / 回帰ゼロ)
 *   - custom role (role_id あり) の未マップ path   → deny  (新 route の足し忘れも安全側で締める)
 *
 * UI 非表示は UX のみ。ここ (worker) が唯一の enforcement 正典 (直 URL / API 直叩きも 403)。
 */
export async function permissionMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const staff = c.get('staff');
  // 公開 route は authMiddleware が staff を set せず素通ししている → permission 対象外。
  if (!staff) return next();

  const path = new URL(c.req.url).pathname;
  const feature = mapPathToFeature(path);

  // 権限対象外 (staff/me, capabilities, auth 等) → 常に許可。
  if (feature === null) return next();

  const perms = await resolvePermissions(c.env.DB, staff);

  // 未マップ path: built-in=allow (byte-identical) / custom=deny (fail-closed)。
  if (feature === undefined) {
    if (perms.isBuiltin) return next();
    return c.json({ success: false, error: 'この操作の権限がありません' }, 403);
  }

  if (perms.allows(feature)) return next();
  return c.json(
    { success: false, error: `この操作の権限がありません（${FEATURE_LABELS[feature]}）` },
    403,
  );
}
