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

import { verifyFriendToken } from './formaloo-friend-token.js';

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
  /**
   * 弾M (form-post-edit / T-A3): Formaloo row 編集の addressable identifier (ROW slug)。
   * real payload (live-confirm 2026-07-12) は top-level `slug` が ROW slug・top-level `form`(string) が form slug。
   * ゆえ **submit_code present ∧ top-level slug が form slug と distinct** のときのみ root.slug を rowSlug に採る。
   * fallback 形 (top-level slug が form-slug に消費される) / legacy (submit_code 不在) は null → rows-list resolver に委譲。
   */
  rowSlug: string | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return null;
}

/**
 * rendered_data から署名 alias (既定 fr_id) の値を取り出す。**実 Formaloo serialization は配列**
 *   `[{ slug, alias, value }, ...]` (S-1 live-confirm 2026-07-12 実測) ゆえ alias 直引き object 前提の
 *   `rendered_data[alias]` では取れない。配列は alias 一致 (無ければ slug 一致) の value を、object 形
 *   (fixture/legacy) は alias 直引きを返す。どちらでもない/該当無しは null (fail-safe / 候補 chain 継続)。
 */
function renderedAliasValue(rendered: unknown, alias: string): string | null {
  if (Array.isArray(rendered)) {
    for (const entry of rendered) {
      const e = asObject(entry);
      if (e && (e.alias === alias || e.slug === alias)) {
        const v = e.value ?? e.rendered_value;
        if (typeof v === 'string' && v) return v;
      }
    }
    return null;
  }
  const obj = asObject(rendered);
  if (obj) {
    const v = obj[alias];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** 既定の署名 friend token alias (hidden field の alias ID / URL param 名 = fr_id / §spec 2.1)。 */
export const FRIEND_TOKEN_ALIAS = 'fr_id';

export interface ParseWebhookOptions {
  /**
   * 署名 fr_id 検証用の専用 secret (FORMALOO_FRIEND_TOKEN_SECRET)。供給時のみ rendered_data[alias] の
   * 署名トークンを verify して friendId を復元する。未供給は署名 fr_id を無視し legacy 候補 chain に落ちる。
   */
  friendTokenSecret?: string | null;
  /** 署名 fr_id の alias (既定 fr_id)。 */
  friendTokenAlias?: string;
}

/**
 * Formaloo webhook payload を正規化。submission id が取れなければ null (処理不能)。
 * 実 payload 形が未確定 (N-12) のため documented な候補キー chain で defensive に抽出する。
 *
 * 順方向 (T-A6): rendered_data[alias] (alias/slug キー) に載る署名 fr_id を verifyFriendToken で復元し
 * friendId とする (改ざんは reject=null=誤タグ防止 / R-F4)。secret 未供給 or 署名不一致 or fr_id 欠落
 * (= HP 経由) は既存の unsigned 候補 chain に fallback する (回帰安全)。crypto 検証のため async。
 */
export async function parseWebhookPayload(
  payload: unknown,
  nowIso: string,
  opts?: ParseWebhookOptions,
): Promise<ParsedWebhookSubmission | null> {
  const root = asObject(payload);
  if (!root) return null;
  const data = asObject(root.data) ?? root;

  // 実 payload (F-3 / spec §2.3): row(submission) = top-level submit_code / form = top-level slug /
  //   data = field-id map。submit_code を submissionId の最優先候補にし、form-slug への誤代入を防ぐ。
  //   submit_code 不在 (fixture/legacy 形) では従来 chain (data.slug 等) にそのまま落ちる。
  const submitCode = firstString(root.submit_code, data.submit_code);
  const submissionId = firstString(submitCode, data.slug, data.id, root.slug, root.id, asObject(data.submission)?.slug, asObject(data.submission)?.id);
  if (!submissionId) return null;

  const formObj = asObject(data.form) ?? asObject(root.form);
  // 実 Formaloo serialization (S-1 live-confirm 2026-07-12): `form` は **文字列の form slug**・top-level
  //   `slug` は ROW(submission) slug。ゆえ文字列 `form` を `submitCode ? root.slug` より先に採り、ROW slug を
  //   form slug に誤代入して台帳照合を落とす事故を防ぐ。`form` が object の仮定 payload 形は formObj.slug が先勝ち。
  //   `submitCode ? root.slug` は「form 欠落 + top-level slug=form slug」の仮定 payload 形への fallback として残置。
  const slug = firstString(
    formObj?.slug, formObj?.address, data.form_slug, root.form_slug,
    data.form as unknown, root.form as unknown,
    submitCode ? root.slug : null,
  );

  // answers 抽出: legacy 形は data.answers / data.fields / root.answers。実 payload 形 (submit_code present)
  // は top-level data 自体が field-id map = answers 本体ゆえ data を採る (未 mapping で answers_json が空の
  // まま upsert される blank submission を防ぐ / CX-2 / S-1 blocker)。data がラッパの legacy 形では
  // submitCode が無いので data 全体を混ぜない (slug/form 等の構造キーが answers に漏れない = 回帰なし)。
  const answersObj =
    asObject(data.answers) ?? asObject(data.fields) ?? asObject(root.answers) ?? (submitCode ? asObject(data) : null) ?? {};
  const answers: Record<string, unknown> = { ...answersObj };

  const submittedAt = firstString(data.created_at, data.submitted_at, root.created_at, root.submitted_at) ?? nowIso;

  // 順方向 friend 解決: 署名 fr_id を最優先 (rendered_data[alias] = /fo/:id が付与した alias 事前充填)。
  // F-2 (R-F4 / R-R7): 署名 field が present の時は verify 成功のみ採用し、invalid / 検証不能 (secret 未供給)
  //   は fail-closed で null 確定する。ここで legacy 未署名 chain に落とすと、攻撃者が『改ざん fr_id +
  //   別 friendId (legacy field)』を注入して別人へ tag/scenario を発火できる (署名の forgery 耐性が無効化)。
  //   legacy 未署名 chain は署名 field が完全に absent の時のみ許可 (後方互換 / HP 経由・旧 hidden field)。
  const alias = opts?.friendTokenAlias ?? FRIEND_TOKEN_ALIAS;
  // 実 Formaloo は rendered_data が配列 [{slug,alias,value}] (S-1 live-confirm)。renderedAliasValue が
  //   配列/object の両形から alias 値を取り出す。取れなければ answers[alias]/data[alias] へ (回帰安全)。
  const signedToken = firstString(
    renderedAliasValue(root.rendered_data, alias),
    renderedAliasValue(data.rendered_data, alias),
    answers[alias],
    data[alias],
  );
  let friendId: string | null;
  if (signedToken) {
    friendId = opts?.friendTokenSecret ? await verifyFriendToken(signedToken, opts.friendTokenSecret) : null;
  } else {
    friendId = firstString(
      answers.friend_id,
      answers.f,
      answers.line_friend_id,
      answers.friendId,
      data.friend_id,
      root.friend_id,
    );
  }

  // 弾M (T-A3): ROW slug capture。real 形は top-level `slug`(=ROW slug) が resolved form slug と distinct。
  //   fallback 形 (form キー無し) では slug 自身が root.slug 経由の form slug ゆえ両者一致 → row slug 不明 = null。
  //   submit_code 不在 (legacy) も null。null は edit endpoint の rows-list submit_code resolver が救済する。
  const rowSlugCandidate = firstString(root.slug);
  const rowSlug = submitCode && rowSlugCandidate && rowSlugCandidate !== slug ? rowSlugCandidate : null;

  return { submissionId, slug: slug ?? null, answers, submittedAt, friendId, rowSlug };
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
