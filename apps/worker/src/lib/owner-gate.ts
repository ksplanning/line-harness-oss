import type { Context } from 'hono';
import type { Env } from '../index.js';

// =============================================================================
// 共有 owner-gate helper (F6-1 / Codex gap #6)
// -----------------------------------------------------------------------------
// permission-middleware は built-in role (owner/admin/staff = role_id NULL) を byte-identical に
// **全許可** する非対称 fail-closed。よって「built-in の admin/staff でも非 owner は不可」を強制するには
// route ハンドラ内の owner-gate が **真の enforcement** になる (§ROLLOUT_PLAN 自己訂正[修正7])。
//
// 元は forms-advanced.ts 内の非 export ローカル関数だったものを共有化し、キー管理 route (GET 含む全 route)
// からも流用する。既存 forms-advanced の 4 呼出は default メッセージで byte-equivalent を維持する。
// =============================================================================

/** owner (built-in owner role) 限定。非 owner (built-in staff/admin + custom role) は 403 Response を返す。 */
export function ownerGate(
  c: Context<Env>,
  message = 'この操作にはオーナー権限が必要です（個人情報保護）',
): Response | null {
  const staff = c.get('staff');
  if (!staff || staff.role !== 'owner') {
    return c.json({ success: false, error: message }, 403);
  }
  return null;
}
