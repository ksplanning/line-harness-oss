// =============================================================================
// LP 閲覧 friend 紐付けトークン (harness-lp-hosting / S-1 / §spec 5.1 候補1)
// -----------------------------------------------------------------------------
// LP を「誰が見たか」を可能な範囲で friend 紐付けするための AES-GCM opaque envelope。
// 生 friendId を URL に載せず (PII ゼロ)、改ざん・期限切れ・別 secret を fail-closed で拒否する。
//
// 設計 (spec §5.1 候補1 / OD-LP-3 推奨):
//   - token = base64url(iv || AES-GCM(key, {fid, lp, exp}))。
//     friendId / lpSlug / exp は暗号文の中 = URL に平文で出ない (PII 非可視・改ざん不能)。
//   - key = SHA-256(secret) の 32byte を AES-GCM 256bit 鍵に import (WebCrypto のみ・依存追加なし)。
//     secret は既存 FORMALOO_FRIEND_TOKEN_SECRET を再利用 (新規 provisioning ゼロ) or 専用鍵 (OD-LP-3)。
//   - iv = 12byte ランダム (呼び出しごとに new = nonce 再利用なし)。
//   - fail-closed: secret 未設定/空・friendId/lpSlug 空・改ざん・期限切れ・壊れた token = すべて null。
//     呼び出し側 (route) は null なら「匿名記録」に degrade する (§spec J / 記録自体は必ず残す)。
//   - 識別≠認証: 署名は forgery を防ぐが leaked token の replay は防げない (exp で窓を絞る)。
//   - 純関数・DB 非依存 = 単体テスト可 (formaloo-friend-token.ts と同型)。
// =============================================================================

/** AES-GCM の標準 nonce 長 (12byte)。 */
const IV_LEN = 12;

/** Uint8Array → base64url (padding 無し / URL-safe)。btoa は Workers 標準。 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → Uint8Array。不正な入力は null (fail-closed / crash させない)。 */
function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** SHA-256(secret) の 32byte を AES-GCM 鍵に import。 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface LpViewClaims {
  friendId: string;
  lpSlug: string;
  /** 絶対失効時刻 (epoch ms)。 */
  exp: number;
}

/**
 * 閲覧トークンを発行。secret 未設定/空 or friendId/lpSlug 空は fail-closed で null (署名不可)。
 * @param expMs 絶対失効時刻 (epoch ms)。呼び出し側で Date.now() + 7d 等を渡す。
 * @returns base64url トークン or null。
 */
export async function signLpViewToken(
  friendId: string,
  lpSlug: string,
  expMs: number,
  secret: string | undefined | null,
): Promise<string | null> {
  if (!secret || !friendId || !lpSlug) return null;
  try {
    const key = await deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const payload = new TextEncoder().encode(
      JSON.stringify({ fid: friendId, lp: lpSlug, exp: expMs }),
    );
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    return bytesToBase64Url(combined);
  } catch {
    // 署名失敗 (crypto エラー等) は fail-closed で null → 呼び出し側で匿名 degrade。
    return null;
  }
}

/**
 * トークンを検証し、有効なら claims を返す。
 * token/secret 欠落・base64url 不正・iv 未満の短さ・改ざん (auth tag 不一致)・別 secret・期限切れ =
 * すべて null (誤 friend 紐付けを作らない / fail-closed)。
 * @param nowMs 期限判定の基準時刻 (省略時 Date.now())。exp <= now は失効。
 */
export async function verifyLpViewToken(
  token: string | undefined | null,
  secret: string | undefined | null,
  nowMs: number = Date.now(),
): Promise<LpViewClaims | null> {
  if (!token || !secret) return null;
  const raw = base64UrlToBytes(token);
  if (!raw || raw.length <= IV_LEN) return null;
  try {
    const iv = raw.slice(0, IV_LEN);
    const ct = raw.slice(IV_LEN);
    const key = await deriveKey(secret);
    // 復号は改ざん / 別 secret で throw する (AES-GCM auth tag) → catch で null。
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const claims = JSON.parse(new TextDecoder().decode(ptBuf)) as {
      fid?: unknown;
      lp?: unknown;
      exp?: unknown;
    };
    if (
      typeof claims.fid !== 'string' ||
      typeof claims.lp !== 'string' ||
      typeof claims.exp !== 'number' ||
      !claims.fid ||
      !claims.lp
    ) {
      return null;
    }
    if (nowMs >= claims.exp) return null; // exp ちょうども失効 (境界は fail-closed 側)
    return { friendId: claims.fid, lpSlug: claims.lp, exp: claims.exp };
  } catch {
    return null;
  }
}
