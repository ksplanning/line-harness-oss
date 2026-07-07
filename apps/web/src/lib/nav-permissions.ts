'use client'

import { useState, useEffect } from 'react'

// =============================================================================
// nav / ダッシュボードの権限出し分け (G64) — 単一正典
// -----------------------------------------------------------------------------
// href → feature_key。custom role の人はここに載る feature が許可されていない導線を隠す。
// 未掲載 (ダッシュボード等) は常に表示。built-in role は従来どおり全表示 (byte-identical)。
// sidebar / dashboard の両方がこの map を参照する (2 箇所コピーで drift させない / M-7)。
// =============================================================================

export const NAV_FEATURE: Record<string, string> = {
  '/friends': 'friend',
  '/chats': 'chat',
  '/friend-add-settings': 'broadcast',
  '/scenarios': 'scenario',
  '/broadcasts': 'broadcast',
  '/campaigns': 'broadcast',
  '/templates': 'template',
  '/template-packs': 'template',
  '/media': 'media',
  '/rich-menus': 'rich_menu',
  '/reminders': 'booking',
  '/inflow-links': 'analytics',
  '/tracked-links': 'analytics',
  '/tags': 'friend',
  '/conversions': 'analytics',
  '/ad-conversions': 'analytics',
  '/scoring': 'analytics',
  '/form-submissions': 'form',
  '/duplicates': 'friend',
  '/automations': 'scenario',
  '/auto-replies': 'auto_reply',
  '/faqs': 'faq',
  '/webhooks': 'account',
  '/notifications': 'chat',
  '/booking/bookings': 'booking',
  '/booking/menus': 'booking',
  '/booking/staff': 'booking',
  '/booking/calendar': 'booking',
  '/events': 'event',
  '/canned-responses': 'chat',
  '/staff': 'staff_admin',
  '/accounts': 'account',
  '/pools': 'account',
  '/users': 'friend',
  '/health': 'system_update',
  '/updates': 'system_update',
  '/emergency': 'system_update',
}

export interface NavPermissionCtx {
  permissions: string[] | null
  hasCustomRole: boolean
}

/**
 * href が現在のユーザーに見えるか。
 *   - custom role (hasCustomRole) かつ permissions 取得済 → 該当 feature が許可されていない導線を隠す
 *   - built-in role / 未取得 / 未掲載 href → 常に表示 (byte-identical)
 * ⚠️ enforcement は worker (permissionMiddleware) が正典。ここは UX の出し分けのみ。
 */
export function isNavVisible(href: string, ctx: NavPermissionCtx): boolean {
  if (ctx.hasCustomRole && ctx.permissions) {
    const feature = NAV_FEATURE[href]
    if (feature && !ctx.permissions.includes(feature)) return false
  }
  return true
}

/** /api/staff/me を読み、custom role の権限出し分けに必要な状態 + isVisible(href) を返す。 */
export function useNavPermissions(): {
  permissions: string[] | null
  hasCustomRole: boolean
  role: string | null
  isVisible: (href: string) => boolean
} {
  const [permissions, setPermissions] = useState<string[] | null>(null)
  const [hasCustomRole, setHasCustomRole] = useState(false)
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { api } = await import('@/lib/api')
        const res = await api.staff.me()
        if (!cancelled && res.success) {
          setPermissions(res.data.permissions ?? null)
          setHasCustomRole(Boolean(res.data.roleId))
          setRole(res.data.role ?? null)
        }
      } catch {
        // 取得失敗時は built-in フォールバック (全表示)。
      }
    })()
    return () => { cancelled = true }
  }, [])

  return {
    permissions,
    hasCustomRole,
    role,
    isVisible: (href: string) => isNavVisible(href, { permissions, hasCustomRole }),
  }
}
