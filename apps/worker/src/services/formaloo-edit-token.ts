// =============================================================================
// 署名付き編集トークン (form-edit-mail-link / 弾L / T-B1)
// -----------------------------------------------------------------------------
// 埋込式フォーム回答者へメールで届ける「編集用 URL」に載せる HMAC-SHA256 署名トークン。
// 最重要 failure = 「編集 URL が他人の回答を開ける」を封じる芯 (署名/期限/行束縛の検証)。
//
// 設計 (§spec R3 / §plan / OD-1/OD-2):
//   - token = `base64url(JSON payload)` + '.' + `sig`。sig = HMAC-SHA256(payloadB64, secret) の base64url 切詰め。
//     payload = { f: formId, r: rowRef(=submission_id), e: epoch(失効世代), x: exp(unix 秒) }。
//     **formId/rowRef/epoch/exp を全て署名対象 (payloadB64) に焼く** = 1 行だけを指す・改ざんは sig 不一致で reject。
//   - 専用鍵 `FORMALOO_EDIT_TOKEN_SECRET`。既存 friend token / webhook secret / auth API_KEY とは別鍵で分離
//     (編集トークンが署名/認証系の権限昇格に一切使えない境界)。secret 未設定/空は fail-closed = 発行/検証不可 (null)。
//   - 期限 (exp): verify で now >= exp を厳格拒否 (期限切れ URL を通さない)。
//   - 失効 epoch (e): stateless 署名は失効できないため、per-form の失効世代を payload に焼く。開封時 live gate で
//     token.epoch === form.edit_link_epoch を照合し、bump で当該 form の既発行 token を一括失効する (route 側で照合)。
//   - 定数時間比較 (sig 内容差をタイミングに漏らさない)。Web Crypto (crypto.subtle) のみ = Workers 標準・依存追加なし。
//   - 純関数・DB 非依存 = 単体テスト可 (認証源に非依存)。
//   作法は formaloo-friend-token.ts を踏襲 (署名/base64url/fail-closed/定数時間比較) しつつ、期限 + 構造化 payload を追加。
// =============================================================================

/** 署名 (base64url) の採用長。base64url(32byte HMAC)=43 文字のうち先頭 27 文字 (~162bit) を採用 (friend token と同基準)。 */
export const EDIT_TOKEN_SIG_LEN = 27;

/** 編集 URL の既定 TTL (日)。OD-2 = 30 日 (owner 最終確定は Phase B ゲート・Phase A 既定として採用)。 */
export const EDIT_TOKEN_DEFAULT_TTL_DAYS = 30;

/** 検証済み payload (verify が返す構造)。 */
export interface EditTokenPayload {
  /** 対象 form の harness id (別 form の token を route が拒否する束縛)。 */
  formId: string;
  /** 編集対象 row の addressing (弾M row addressing に合わせ submission_id を焼く / OD-1)。 */
  rowRef: string;
  /** 失効世代 (per-form edit_link_epoch。開封時 live gate で form 側と照合)。 */
  epoch: number;
  /** 有効期限 (unix 秒)。verify で now >= exp を拒否。 */
  exp: number;
}

/** 発行入力。exp は絶対時刻 (unix 秒)。epoch 未指定は 0。 */
export interface SignEditTokenInput {
  formId: string;
  rowRef: string;
  exp: number;
  epoch?: number;
}

/** now(unix 秒) + ttlDays から exp(unix 秒) を計算 (既定 TTL=30 日)。 */
export function editTokenExp(nowSec: number, ttlDays: number = EDIT_TOKEN_DEFAULT_TTL_DAYS): number {
  return nowSec + Math.round(ttlDays * 86400);
}

/** Uint8Array → base64url (padding 無し / URL-safe)。btoa は Workers 標準。 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 文字列 → base64url。 */
function strToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

/** base64url → UTF-8 文字列。不正入力は例外 (呼び出し側で catch → null)。 */
function base64UrlToStr(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** HMAC-SHA256(message, secret) の base64url を EDIT_TOKEN_SIG_LEN で切り詰めて返す。 */
async function editSig(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return bytesToBase64Url(sig).slice(0, EDIT_TOKEN_SIG_LEN);
}

/** 定数時間文字列比較 (長さ不一致は即 false・内容差はタイミングに漏らさない)。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 編集トークンを発行。secret 未設定/空 or formId/rowRef 空は fail-closed で null (発行不可)。
 * 返り値 = `${base64url(payload)}.${sig}`。
 */
export async function signEditToken(
  input: SignEditTokenInput,
  secret: string | undefined | null,
): Promise<string | null> {
  if (!secret) return null;
  if (!input.formId || !input.rowRef) return null;
  const payloadObj = { f: input.formId, r: input.rowRef, e: input.epoch ?? 0, x: input.exp };
  const payloadB64 = strToBase64Url(JSON.stringify(payloadObj));
  const sig = await editSig(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * 編集トークンを検証し、(a)署名一致 (定数時間) ∧ (b)exp > now を両方満たす時のみ payload を返す。
 * token/secret 欠落・区切り無し・別鍵・改ざん (formId/rowRef 書換 = sig 不一致)・期限切れ・壊れ payload は全て null。
 * epoch (失効世代) の照合は DB を要するため本純関数では行わず、route の live gate が payload.epoch を照合する。
 */
export async function verifyEditToken(
  token: string | undefined | null,
  secret: string | undefined | null,
  nowSec: number,
): Promise<EditTokenPayload | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null; // 区切り無し / 左辺 (payload) 空は不正
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!providedSig) return null;

  // 署名検証を先に (payload 改ざんは sig 不一致で reject / decode 前に落とす)。
  const expectedSig = await editSig(payloadB64, secret);
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  // 署名一致した payload のみ decode (信頼できる payload)。
  let obj: unknown;
  try {
    obj = JSON.parse(base64UrlToStr(payloadB64));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const p = obj as Record<string, unknown>;
  const formId = p.f;
  const rowRef = p.r;
  const epoch = p.e;
  const exp = p.x;
  if (typeof formId !== 'string' || !formId) return null;
  if (typeof rowRef !== 'string' || !rowRef) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (nowSec >= exp) return null; // 期限切れ (exp > now を要求)
  const epochNum = typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0;
  return { formId, rowRef, epoch: epochNum, exp };
}
