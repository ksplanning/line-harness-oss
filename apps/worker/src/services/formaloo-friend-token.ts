// =============================================================================
// 順方向 fr_id 署名 friend token (C1 / R-F4 / formaloo-sheets-roundtrip)
// -----------------------------------------------------------------------------
// LINE 導線で配る Formaloo フォーム URL に「どの friend の回答か」を埋め込むための
// HMAC-SHA256 署名トークン。値は Formaloo→Google Sheets→webhook と我々の信頼境界の外を
// 往復するため、捏造 (任意 friendId の valid token でっち上げ) を署名で拒否する。
//
// 設計 (§spec R-F4 / §plan 2):
//   - token = `friendId + '.' + base64url(HMAC-SHA256(friendId, secret))[:FRIEND_TOKEN_SIG_LEN]`。
//     friendId 部分は平文 (routing に使う) / sig 部分が改ざん検知。
//   - 専用 secret = `FORMALOO_FRIEND_TOKEN_SECRET` (既存 auth API_KEY / webhook secret とは別鍵)。
//     鍵を分離することで、fr_id 署名が既存 auth/webhook 系の権限昇格に一切使えない (別 secret)。
//   - secret 未設定/空は fail-closed = 署名不可 (null)。呼び出し側は「付与しない」で degrade する
//     (生 Formaloo URL 相当 / §plan 6 rollback)。
//   - 識別≠認証 (§spec R-F4 / F-CX1): 署名は forgery を防ぐが leaked/共有された valid token の
//     replay は防げない。これは owner が受容した識別境界の内側 (逆方向フラグは運用者が事後に立てる)。
//   - Web Crypto (crypto.subtle) のみ = Workers 標準・依存追加なし。純関数・DB 非依存 = 単体テスト可。
// =============================================================================

/**
 * 署名 (base64url) の採用長。base64url(32byte HMAC) = 43 文字のうち先頭 27 文字 (~162bit) を採用。
 * URL を短く保ちつつ総当たり/衝突耐性を確保する (切り詰めても forgery は依然計算量的に困難)。
 */
export const FRIEND_TOKEN_SIG_LEN = 27;

/** Uint8Array → base64url (padding 無し / URL-safe)。btoa/atob は Workers 標準。 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HMAC-SHA256(message, secret) の base64url を FRIEND_TOKEN_SIG_LEN で切り詰めて返す。 */
async function friendSig(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return bytesToBase64Url(sig).slice(0, FRIEND_TOKEN_SIG_LEN);
}

/**
 * friendId に署名トークンを発行。secret 未設定/空 or friendId 空は fail-closed で null (署名不可)。
 * 返り値 = `${friendId}.${sig}` (URL query 値として使う)。
 */
export async function signFriendToken(
  friendId: string,
  secret: string | undefined | null,
): Promise<string | null> {
  if (!secret || !friendId) return null;
  const sig = await friendSig(friendId, secret);
  return `${friendId}.${sig}`;
}

/**
 * 署名トークンを検証し、一致した場合のみ friendId を返す。
 * token/secret 欠落・区切り無し・別 secret・署名改ざんはすべて null (routing に使わせない)。
 * friendId は非空前提 (`.` の左辺が空なら reject)。sig は定数時間比較 (内容差をタイミングに漏らさない)。
 */
export async function verifyFriendToken(
  token: string | undefined | null,
  secret: string | undefined | null,
): Promise<string | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null; // 区切り無し / 左辺 (friendId) 空は不正
  const friendId = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!providedSig) return null;

  const expectedSig = await friendSig(friendId, secret);
  if (providedSig.length !== expectedSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= providedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  return diff === 0 ? friendId : null;
}
