// =============================================================================
// LIFF 復路 URL への LINE userId 付与 (F-1 / formaloo-sheets-roundtrip)
// -----------------------------------------------------------------------------
// LIFF client (client/main.ts) が ?redirect= で戻る先が worker の追跡経路 (/t/:id / /fo/:id) の時、
// 解決した LINE userId を ?lu= で carry する。これがないと /fo/:id は friend 未解決のまま LINE in-app で
// 再び LIFF 分岐を踏み無限ループし、主配布 URL が Formaloo へ到達しない (reviewer F-1 critical)。
// 純関数・DOM/liff 非依存 = client からも import 可 + vitest 単体テスト可 (src/lib 規約 = safe-redirect と同源)。
// =============================================================================

/** worker 追跡経路の pathname 前方一致 (/t/:id または /fo/:id)。query/fragment の /fo/ を拾わない。 */
const TRACKING_PATHNAME = /^\/(?:t|fo)\//;

/**
 * redirectUrl が worker 追跡経路 (/t/:id または /fo/:id) なら ?lu=<lineUserId> を付与して返す。
 * それ以外は無改変 (不要な lu を付けない)。既存 query があれば & で連結・lineUserId は encode。
 *
 * CX-1 (LINE userId 漏出防止): substring 一致 (`includes('/fo/')`) は攻撃者 URL
 *   (`https://evil.com/fo/x` や `?next=/fo/`) にも lu を付けてしまう。判定は URL を parse した
 *   **pathname の前方一致** + (selfOrigin 指定時) **same-origin** に限定する。selfOrigin には呼び出し側の
 *   自 origin (client: window.location.origin) を渡す = 別 origin へ LINE userId を carry しない。
 * @param selfOrigin 追跡経路が属する自 origin。相対 redirectUrl はこれを基準に解決する。省略時は
 *   同 origin 検査を行わず pathname のみで判定 (後方互換 / 呼び出し側が origin を持てない場合)。
 */
export function appendLineUserToReturnUrl(redirectUrl: string, lineUserId: string, selfOrigin?: string): string {
  if (!redirectUrl || !lineUserId) return redirectUrl;

  let target: URL;
  try {
    // 相対 (root-relative) は selfOrigin を基準に解決。selfOrigin 無 + 相対は解析不能 → 無改変。
    target = new URL(redirectUrl, selfOrigin || undefined);
  } catch {
    return redirectUrl;
  }

  // same-origin ガード (selfOrigin 指定時): 別 origin へは lu を付けない (LINE userId 非漏出 / CX-1)。
  if (selfOrigin) {
    let self: URL;
    try {
      self = new URL(selfOrigin);
    } catch {
      return redirectUrl; // selfOrigin 不正は fail-safe で無改変
    }
    if (target.origin !== self.origin) return redirectUrl;
  }

  // pathname 前方一致 (/t/ or /fo/) の時のみ。query/fragment の /fo/ 詐称を排除。
  if (!TRACKING_PATHNAME.test(target.pathname)) return redirectUrl;

  const sep = redirectUrl.includes('?') ? '&' : '?';
  return `${redirectUrl}${sep}lu=${encodeURIComponent(lineUserId)}`;
}
