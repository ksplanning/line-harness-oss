// =============================================================================
// LIFF 復路 URL への LINE userId 付与 (F-1 / formaloo-sheets-roundtrip)
// -----------------------------------------------------------------------------
// LIFF client (client/main.ts) が ?redirect= で戻る先が worker の追跡経路 (/t/:id / /fo/:id) の時、
// 解決した LINE userId を ?lu= で carry する。これがないと /fo/:id は friend 未解決のまま LINE in-app で
// 再び LIFF 分岐を踏み無限ループし、主配布 URL が Formaloo へ到達しない (reviewer F-1 critical)。
// 純関数・DOM/liff 非依存 = client からも import 可 + vitest 単体テスト可 (src/lib 規約 = safe-redirect と同源)。
// =============================================================================

/**
 * redirectUrl が worker 追跡経路 (/t/:id または /fo/:id) なら ?lu=<lineUserId> を付与して返す。
 * それ以外の URL は無改変 (不要な lu を付けない)。既存 query があれば & で連結・lineUserId は encode。
 * redirectUrl / lineUserId が空なら無改変 (fail-safe)。
 */
export function appendLineUserToReturnUrl(redirectUrl: string, lineUserId: string): string {
  if (!redirectUrl || !lineUserId) return redirectUrl;
  const isTrackingReturn = redirectUrl.includes('/t/') || redirectUrl.includes('/fo/');
  if (!isTrackingReturn) return redirectUrl;
  const sep = redirectUrl.includes('?') ? '&' : '?';
  return `${redirectUrl}${sep}lu=${encodeURIComponent(lineUserId)}`;
}
