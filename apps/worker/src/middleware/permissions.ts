import { FEATURE_KEYS, isFeatureKey, type FeatureKey } from '@line-crm/shared';
import { getAllowedFeatures } from '@line-crm/db';

// =============================================================================
// built-in preset + 権限解決 (G64)
// -----------------------------------------------------------------------------
// built-in owner/admin/staff は「コード定数」= 全 feature allow。
//   根拠: 現状 worker では 3 role とも全 route に到達でき、唯一の差は 16 の requireRole('owner') gate。
//   その 16 は permissionMiddleware の後段にそのまま残す。よって permission 層で built-in を全許可に
//   すれば「認証さえ通れば全機能」の現状を 1 バイトも変えない (T-A4 / D-1 = byte-identical)。
//   admin/staff の UI 上の出し分け (/staff は owner のみ等) は sidebar の UX であって enforcement ではない。
// =============================================================================

export const BUILTIN_ROLE_PRESETS: Record<'owner' | 'admin' | 'staff', ReadonlySet<FeatureKey>> = {
  owner: new Set(FEATURE_KEYS),
  admin: new Set(FEATURE_KEYS),
  staff: new Set(FEATURE_KEYS),
};

export interface ResolvedPermissions {
  /** role_id NULL の built-in preset で解決したか (未マップ path の fail-closed 判定に使う)。 */
  isBuiltin: boolean;
  /** feature が許可されているか。 */
  allows(feature: FeatureKey): boolean;
  /** 許可 feature 集合 (/api/staff/me が返す / UI 出し分けの素材)。 */
  features: FeatureKey[];
}

interface StaffLike {
  id: string;
  role: 'owner' | 'admin' | 'staff';
  roleId?: string | null;
}

/**
 * staff の実効権限を解決する。
 *   - env-owner or role_id NULL → BUILTIN_ROLE_PRESETS[role] (owner 全権 / break-glass 保全 / 回帰ゼロ)
 *   - role_id あり (custom role) → role_permissions の allowed=1 のみ許可。**行が無い feature は deny**
 *     (base_role へ fallback しない = 厳格 allowlist / Codex CRITICAL-1)。後から追加された新 feature も
 *     custom role には deny (fail-closed = 安全側)。
 */
export async function resolvePermissions(
  db: D1Database,
  staff: StaffLike,
): Promise<ResolvedPermissions> {
  if (staff.id === 'env-owner' || !staff.roleId) {
    const preset = BUILTIN_ROLE_PRESETS[staff.role] ?? BUILTIN_ROLE_PRESETS.staff;
    return {
      isBuiltin: true,
      allows: (f) => preset.has(f),
      features: [...preset],
    };
  }

  const allowed = new Set(
    (await getAllowedFeatures(db, staff.roleId)).filter(isFeatureKey),
  );
  return {
    isBuiltin: false,
    allows: (f) => allowed.has(f),
    features: [...allowed],
  };
}
