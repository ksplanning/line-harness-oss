// =============================================================================
// Formaloo webhook 認証 & payload 正規化 (F-3 / T-C1 / line-formaloo-forms)
// -----------------------------------------------------------------------------
// Formaloo が「回答 submit」で叩く outbound webhook を受ける前段の純関数群。
//   - path token 検証: 推測不能な shared-secret を URL path に持たせる (N-4)。expected 未設定 (dev) は
//     fail-closed で非承認 (推測 token を通さない)。
//   - HMAC 署名 + timestamp 窓: Formaloo が署名する場合、HMAC-SHA256 + ±5分窓で replay/spoof を拒否 (N-12)。
//     ⚠️ Formaloo が署名するか・署名スキーム (header 名 / hex or base64 / timestamp 有無) は secret 未供給の
//        dev では確定不能。本実装は「HMAC-SHA256(hex, 任意 timestamp prefix)」の fallback。live 確定は
//        closer S-1 secret 供給後の browser-evaluator 工程 (sidecar 申し送り)。署名が無い/検証できない場合は
//        route 側で「未署名隔離」(verified=0・LINE 後処理を発火しない) にする (N-12)。
//   - payload 正規化: 未知プロパティを剥がし submission id / form slug / answers / friend を whitelist 抽出 (M-21)。
// 副作用なし・DB 非依存 = 単体テスト可能 (@cloudflare/vite-plugin の 401→500 化を避ける / 地雷#3)。
// =============================================================================

/** 定数時間比較 (長さ違いは即 false・内容差はタイミングに漏らさない)。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** path token 検証。expected 未設定/空は fail-closed で false (dev では token 検証不能=非承認)。 */
export function verifyWebhookToken(provided: string, expected: string | undefined | null): boolean {
  if (!expected) return false;
  return timingSafeEqualStr(provided, expected);
}

export interface ParsedWebhookSubmission {
  /** Formaloo submission/row id (dedup キー / N-3)。 */
  submissionId: string;
  /** 対象 form slug (formaloo_forms.formaloo_slug と照合)。 */
  slug: string | null;
  /** 回答本体 (TRINA PII を含み得る / N-9)。 */
  answers: Record<string, unknown>;
  /** Formaloo 側 submit 時刻 (ISO8601)。欠落は now。 */
  submittedAt: string;
  /** LINE friend id (hidden field 由来 / 解決できなければ null → LINE 後処理対象外)。 */
  friendId: string | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return null;
}

/**
 * Formaloo webhook payload を正規化。submission id が取れなければ null (処理不能)。
 * 実 payload 形が未確定 (N-12) のため documented な候補キー chain で defensive に抽出する。
 */
export function parseWebhookPayload(payload: unknown, nowIso: string): ParsedWebhookSubmission | null {
  const root = asObject(payload);
  if (!root) return null;
  const data = asObject(root.data) ?? root;

  const submissionId = firstString(data.slug, data.id, root.slug, root.id, asObject(data.submission)?.slug, asObject(data.submission)?.id);
  if (!submissionId) return null;

  const formObj = asObject(data.form) ?? asObject(root.form);
  const slug = firstString(formObj?.slug, formObj?.address, data.form_slug, root.form_slug, data.form as unknown, root.form as unknown);

  const answersObj = asObject(data.answers) ?? asObject(data.fields) ?? asObject(root.answers) ?? {};
  const answers: Record<string, unknown> = { ...answersObj };

  const submittedAt = firstString(data.created_at, data.submitted_at, root.created_at, root.submitted_at) ?? nowIso;

  // friend は hidden field の複数キー候補から解決 (redirect が付与する ?f=/lu= 由来 / G11 と同源)。
  const friendId = firstString(
    answers.friend_id,
    answers.f,
    answers.line_friend_id,
    answers.friendId,
    data.friend_id,
    root.friend_id,
  );

  return { submissionId, slug: slug ?? null, answers, submittedAt, friendId };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60_000; // ±5 分 (replay 拒否 / N-12)

export interface VerifyHmacOptions {
  rawBody: string;
  signature: string;
  secret: string | undefined | null;
  /** timestamp header (あれば `${ts}.${rawBody}` を署名対象にし、窓検証する)。 */
  timestamp?: string;
  nowMs?: number;
  windowMs?: number;
}

/**
 * HMAC-SHA256 署名検証。secret 未設定/署名フォーマット不正/timestamp 窓外は false。
 * timestamp があれば signed message = `${timestamp}.${rawBody}`、無ければ rawBody をそのまま署名対象にする。
 */
export async function verifyHmacSignature(opts: VerifyHmacOptions): Promise<boolean> {
  const { rawBody, signature, secret } = opts;
  if (!secret || !signature) return false;
  const expectedBytes = hexToBytes(signature.trim().toLowerCase());
  if (!expectedBytes) return false;

  if (opts.timestamp) {
    const tsMs = new Date(opts.timestamp).getTime();
    if (!Number.isFinite(tsMs)) return false;
    const nowMs = opts.nowMs ?? Date.now();
    const windowMs = opts.windowMs ?? WEBHOOK_TIMESTAMP_WINDOW_MS;
    if (Math.abs(nowMs - tsMs) > windowMs) return false;
  }

  const enc = new TextEncoder();
  const message = opts.timestamp ? `${opts.timestamp}.${rawBody}` : rawBody;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const computed = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  if (computed.length !== expectedBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expectedBytes[i];
  return diff === 0;
}
