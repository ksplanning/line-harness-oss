import { Hono } from 'hono';
import {
  getFormalooForm,
  getFormalooFormBySlug,
  getFormalooSubmission,
  getFormalooFieldMap,
  updateSubmissionRowSlug,
  recordSubmissionEdit,
  upsertFormalooSubmission,
  claimFormalooLineProcessing,
  incrementFormalooSubmitCount,
  addTagToFriend,
  enrollFriendInScenario,
  getFriendById,
  getFriendByLineUserId,
  getFriendLatestSubmission,
  getLineAccountById,
  jstNow,
  type FormalooForm,
  type FormalooSubmissionRow,
} from '@line-crm/db';
import { isDecorationType } from '@line-crm/shared';
import { isBuilderStatus, buildPublicUrl } from '../services/formaloo-publish-gate.js';
import { verifyWebhookToken, verifyHmacSignature, parseWebhookPayload } from '../services/formaloo-webhook.js';
import { signFriendToken } from '../services/formaloo-friend-token.js';
import {
  isPostEditEnabled,
  isEditableFieldType,
  buildFlatRowPatchBody,
  findEmptyRequired,
  resolveRowSlug,
  makeRowsListRowSlugResolver,
} from '../services/formaloo-row-edit.js';
import { verifyEditToken, type EditTokenPayload } from '../services/formaloo-edit-token.js';
import { resolveFormalooClient } from '../services/formaloo-client.js';
import type { Env } from '../index.js';

// 弾M (form-post-edit / T-C1): ②本人再入場 prefill の上限 (URL 長制限対策 / R2)。
const MAX_PREFILL_FIELDS = 20;
const MAX_PREFILL_VALUE_LEN = 200;

/**
 * ②本人再入場: 解決済 friendId の**最新 row** answers を field-slug query prefill 用の map に射影する。
 * 取り違え防止 = getFriendLatestSubmission (friend_id 完全一致) のみ引く。scalar (string/number) の非空・短値のみ
 * (file/multi の配列は除外・URL 長制限で件数/長さを上限)。予約 param (fr_id/fr_name) は署名を守るため除外。
 */
async function buildFriendPrefillParams(
  db: D1Database,
  formId: string,
  friendId: string,
): Promise<Record<string, string>> {
  const row = await getFriendLatestSubmission(db, formId, friendId);
  if (!row) return {};
  let answers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.answers_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    answers = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  let n = 0;
  for (const [slug, val] of Object.entries(answers)) {
    if (n >= MAX_PREFILL_FIELDS) break;
    if (slug === 'fr_id' || slug === 'fr_name') continue; // 署名 fr_id/fr_name を answer が上書きしない
    if (typeof val !== 'string' && typeof val !== 'number') continue; // scalar のみ (file/multi 除外)
    const s = String(val);
    if (!s || s.length > MAX_PREFILL_VALUE_LEN) continue; // 空/長文 除外
    out[slug] = s;
    n++;
  }
  return out;
}

/** definition_json から公開フォーム address を取り出す (表示用キャッシュ / forms-advanced と同源)。 */
function formalooAddressOf(definitionJson: string): string | null {
  try {
    const d = JSON.parse(definitionJson) as { formalooAddress?: unknown };
    return typeof d.formalooAddress === 'string' ? d.formalooAddress : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Formaloo 公開 route (F-3) — 認証除外 + 自前 token 検証 (landmine#4)。
// -----------------------------------------------------------------------------
// /formaloo/webhook/:token  回答 webhook 受信 (T-C1 / T-C3)。path token + 任意 HMAC 署名で自前認証。
//                           冪等 upsert (N-3) + 未署名隔離 (N-12) + published のみ LINE 後処理 (N-7)。
// /fo/:id                   開封リダイレクト (T-C2 / commit 3 で追加)。
// これらは /api/ 配下でない = permissionMiddleware 対象外。authMiddleware は index.ts の除外リストで skip。
// tracked-links の /t/:id と同じ「公開・自前検証」パターン。
// =============================================================================

export const formalooPublic = new Hono<Env>();

const SIG_HEADER = 'x-formaloo-signature';
const TS_HEADER = 'x-formaloo-timestamp';

// POST /formaloo/webhook/:token — Formaloo 回答 webhook (T-C1 + T-C3)
formalooPublic.post('/formaloo/webhook/:token', async (c) => {
  // 1) path token 検証 (推測不能 shared-secret / N-4)。expected 未設定 dev は fail-closed で 401。
  if (!verifyWebhookToken(c.req.param('token'), c.env.FORMALOO_WEBHOOK_TOKEN)) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  // 2) 生 body (HMAC は生バイト対象 → text() を先に読む)
  const rawBody = await c.req.text();

  // 3) 署名検証 (N-12): 署名 header があれば必ず検証し不正なら 401 (spoof/replay 拒否)。
  //    署名が無ければ verified=false で後段隔離 (LINE 後処理を発火しない)。
  const sigHeader = c.req.header(SIG_HEADER);
  let verified = false;
  if (sigHeader) {
    verified = await verifyHmacSignature({
      rawBody,
      signature: sigHeader,
      secret: c.env.FORMALOO_WEBHOOK_SECRET,
      timestamp: c.req.header(TS_HEADER),
    });
    if (!verified) return c.json({ success: false, error: 'invalid signature' }, 401);
  }

  // 4) payload 正規化 (壊れ/照合不能は ack のみ = Formaloo retry storm 回避 / N-6)
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ success: true });
  }
  const parsed = await parseWebhookPayload(payload, new Date().toISOString(), {
    friendTokenSecret: c.env.FORMALOO_FRIEND_TOKEN_SECRET,
  });
  if (!parsed || !parsed.slug) return c.json({ success: true });

  // 5) 台帳照合 (どの harness form の回答か)
  const form = await getFormalooFormBySlug(c.env.DB, parsed.slug);
  if (!form) return c.json({ success: true });

  // 6) 冪等 upsert (N-3 / 順序非依存)。弾M (T-A4): rowSlug を additive で渡す (COALESCE 保持 = 再送で
  //    null が既存 row_slug を落とさない)。既存の submissionId/friendId/answers/verified 経路は byte 不変。
  await upsertFormalooSubmission(c.env.DB, {
    id: parsed.submissionId,
    formId: form.id,
    formalooSlug: parsed.slug,
    friendId: parsed.friendId,
    answersJson: JSON.stringify(parsed.answers),
    submittedAt: parsed.submittedAt,
    verified,
    rowSlug: parsed.rowSlug,
  });

  // 7) LINE 後処理 (T-C3): published + verified のときだけ、claim 成功で 1 回だけ発火 (N-7・N-3)。
  //    ⚠️ consume-at-receipt (R1 F1): 受信時点で発火不適格 (draft/in_review or 未署名隔離) の回答は、
  //    発火せず line_processed=1 で **消費確定** する。これにより後で form が published になってから
  //    同一 submission が再配信/リプレイされても claim できず、draft 回答が実顧客処理へ昇格する経路を
  //    封鎖する (TRINA 実顧客への誤送信を防ぐ = failure_observable 回避)。昇格が必要なら (署名採用 or
  //    pull-verify) は「新規 submission id での再受信」経路で行う (同一 id の後日昇格はしない)。
  const status = isBuilderStatus(form.builder_status) ? form.builder_status : 'draft';
  const eligible = verified && status === 'published';
  const claimed = await claimFormalooLineProcessing(c.env.DB, parsed.submissionId);
  if (eligible && claimed) {
    await fireFormalooSubmitSideEffects(c, form, parsed.friendId);
    await incrementFormalooSubmitCount(c.env.DB, form.id);
  }
  // eligible=false のときは claim (0→1 消費) のみ = 発火なし・以後昇格不可。

  return c.json({ success: true });
});

/**
 * 回答後の LINE 後処理 (既存 forms.ts ロジック流用): tag 付与 / シナリオ開始 / 任意メッセージ push。
 * friend が解決できない回答は対象外 (誤 tag/誤送信を出さない)。すべて best-effort (fail-soft / N-6)。
 */
async function fireFormalooSubmitSideEffects(
  c: { env: Env['Bindings'] },
  form: FormalooForm,
  friendId: string | null,
): Promise<void> {
  const db = c.env.DB;
  if (!friendId) return;

  const tasks: Promise<unknown>[] = [];
  if (form.on_submit_tag_id) tasks.push(addTagToFriend(db, friendId, form.on_submit_tag_id));
  if (form.on_submit_scenario_id) tasks.push(enrollFriendInScenario(db, friendId, form.on_submit_scenario_id));
  if (tasks.length > 0) {
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') console.error('formaloo submit side-effect failed:', r.reason);
  }

  // 任意メッセージ push (best-effort): submit_message 設定 + friend の line_user_id が要る。
  // 未設定 / 未解決 (dev/test) は skip = fail-soft。LineClient は動的 import (テストで network を触らない)。
  if (form.submit_message) {
    try {
      const friend = await getFriendById(db, friendId);
      const lineUserId = (friend as unknown as Record<string, string | null> | null)?.line_user_id;
      if (friend && lineUserId) {
        const { LineClient } = await import('@line-crm/line-sdk');
        const client = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        await client.pushMessage(lineUserId, [{ type: 'text', text: form.submit_message }]);
      }
    } catch (err) {
      console.error('formaloo submit message push failed (fail-soft):', err);
    }
  }
}

// GET /fo/:id — 開封リダイレクト (T-C2)。form_opens へ記録 → 302 で Formaloo hosted form へ。
// 既存 opened_form セグメント (segment-query.ts) が form_opens を無改修で参照し続ける (G11 / G-5 既知限界:
//   HP 埋め込み・直接共有・hosted 直アクセスは本 route を通らず開封を取りこぼす)。
formalooPublic.get('/fo/:id', async (c) => {
  const id = c.req.param('id');
  const form = await getFormalooForm(c.env.DB, id);
  if (!form || form.deleted) return c.json({ success: false, error: 'Form not found' }, 404);

  // N-7: published + address のときだけ公開先へ飛ばす (draft/未 push の公開リンクは配布されない前提)。
  const status = isBuilderStatus(form.builder_status) ? form.builder_status : 'draft';
  const url = buildPublicUrl(status, formalooAddressOf(form.definition_json));
  if (!url) return c.json({ success: false, error: 'このフォームは現在ご利用いただけません' }, 404);

  // friend 解決 (?lu= line user id / ?f= friend id) — tracked-links /t/:id と同源。
  const lineUserId = c.req.query('lu') ?? null;
  let friendId = c.req.query('f') ?? null;

  // LIFF 識別 (R-F2 / /t/:id と同型): LINE in-app browser で開かれ friend 未解決なら、LIFF へ飛ばして
  // line_user_id を取得し ?lu= 付きで /fo/:id に戻す。これで broadcast は単一 /fo/:id リンクを配れば
  // per-recipient で識別が付く (メッセージ本文の個別化不要)。friend 未特定の段階では form_opens に記録しない。
  const ua = c.req.header('user-agent') || '';
  const isLineApp = /\bLine\b/i.test(ua);
  if (!lineUserId && !friendId && isLineApp) {
    // form の account 固有 LIFF を優先解決 (F-5): secondary account の form では返る LINE userId が
    // provider-scoped ゆえ global LIFF だと当該 account に存在しない ID になり得る。未束縛 (line_account_id
    // NULL) / 未登録 / liff_id 無し / 解決 throw は global LIFF_URL へ fallback。
    let liffBase = c.env.LIFF_URL;
    let resolvedLiffId: string | null = null;
    if (form.line_account_id) {
      try {
        const account = await getLineAccountById(c.env.DB, form.line_account_id);
        const liffId = (account as unknown as { liff_id?: string | null } | null)?.liff_id;
        if (liffId) { liffBase = `https://liff.line.me/${liffId}`; resolvedLiffId = liffId; }
      } catch (err) {
        console.error(`/fo/${id} per-account LIFF resolve failed (fallback global):`, err);
      }
    }
    if (liffBase) {
      const directUrl = `${c.env.WORKER_URL || new URL(c.req.url).origin}/fo/${id}`;
      // CX-3 (per-account LIFF 実効化): 解決済み per-account liffId を復路 URL に同梱する。共有 LIFF client の
      //   detectLiffId() は ?liffId= を最優先で読むため、secondary account でも当該 account の LIFF で liff.init
      //   でき、default VITE_LIFF_ID(=primary) への誤 fallback (wrong LIFF context) を防ぐ。これにより LINE
      //   console/API での endpoint ?liffId= provisioning (owner立会) 無しで per-account 解決が成立する。global
      //   fallback (resolvedLiffId null = 未束縛/liff_id 無し) は付与せず client の VITE_LIFF_ID(default) に委ねる。
      const liffIdParam = resolvedLiffId ? `&liffId=${encodeURIComponent(resolvedLiffId)}` : '';
      return c.redirect(`${liffBase}?redirect=${encodeURIComponent(directUrl)}${liffIdParam}`, 302);
    }
  }

  let friendName: string | null = null;
  try {
    if (!friendId && lineUserId) {
      const fr = await getFriendByLineUserId(c.env.DB, lineUserId);
      if (fr) { friendId = fr.id; friendName = fr.display_name ?? null; }
    } else if (friendId) {
      const fr = await getFriendById(c.env.DB, friendId);
      friendName = fr?.display_name ?? null;
      if (!fr) friendId = null; // 実在しない friend id は記録しない (opened_form の EXISTS 結合が無効になるため)
    }
  } catch (err) {
    // 解決失敗 (transient D1 等) は未検証 ?f= を確定させない: friend を null 化 (fail-closed / F-4)。
    // 未検証 ID を form_opens に記録せず・署名 fr_id も発行しない (誤 attribution 防止)。
    console.error(`/fo/${id} friend resolve failed (non-blocking):`, err);
    friendId = null;
    friendName = null;
  }

  // 開封計測 (非ブロッキング / fail-soft): form_opens へ INSERT (既存テーブル・既存スキーマ無改変 / D-1)。
  try {
    await c.env.DB.prepare(
      'INSERT INTO form_opens (id, form_id, friend_id, friend_name, opened_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), id, friendId, friendName, jstNow()).run();
  } catch (err) {
    console.error(`/fo/${id} form_opens insert failed (non-blocking):`, err);
  }

  // 順方向 prefill 合成 (R-F1): friend 解決済 + 専用 secret 設定時のみ、転送先 Formaloo URL に署名付き
  // fr_id (改ざん検知) と URL エンコード表示名 fr_name を付与 → Formaloo hidden field 経由で Google Sheets 列に
  // 「どの LINE アカウントか」が出る。secret 未設定 / friend 未解決 (HP 経由相当) は付与しない (生 URL へ degrade)。
  let redirectUrl = url;
  if (friendId) {
    const signed = await signFriendToken(friendId, c.env.FORMALOO_FRIEND_TOKEN_SECRET);
    // 弾M (T-C1 / F-H1): 回答 answer prefill は **署名 (signed) と同一の fail-closed 条件** に gate する。
    //   署名不可 (FORMALOO_FRIEND_TOKEN_SECRET 未設定 / 署名失敗) = friend identity を署名できない = PII を
    //   redirect URL に載せない (生 URL へ degrade・prefill 一切無し)。署名 fr_id が付かない経路で回答 PII だけ
    //   漏らす fail-open を塞ぐ (done_condition T-C1『署名 fr_id 検証失敗は prefill を付与しない』)。
    if (signed) {
      // allow_post_edit=1 かつ env 有効時のみ、本人の**最新 row** answers を field-slug query prefill で付与
      //   (②本人再入場)。OFF/env 未設定 = null = 現状 (fr_id/fr_name のみ) と byte 同等。friendId は解決済
      //   (実在検証済) ゆえ getFriendLatestSubmission が friend 厳密一致で本人 row のみ引く (取り違え防止)。
      const postEditPrefill =
        form.allow_post_edit === 1 && isPostEditEnabled(c.env.FORM_POST_EDIT_ENABLED)
          ? await buildFriendPrefillParams(c.env.DB, id, friendId)
          : null;
      try {
        const u = new URL(url);
        // answer prefill を先に付与 → 署名 fr_id/fr_name を後で set (予約 param を answer が上書きしない)。
        if (postEditPrefill) for (const [slug, val] of Object.entries(postEditPrefill)) u.searchParams.set(slug, val);
        u.searchParams.set('fr_id', signed);
        if (friendName) u.searchParams.set('fr_name', friendName);
        redirectUrl = u.toString();
      } catch (err) {
        // 転送先 address が不正 URL の場合は prefill を諦めて生 url へ (fail-soft / 誤 404 を出さない)。
        console.error(`/fo/${id} prefill compose failed (non-blocking):`, err);
      }
    }
  }

  return c.redirect(redirectUrl, 302);
});

// =============================================================================
// 弾L 公開編集 route (form-edit-mail-link / T-B2·T-B3·T-B4·T-C2)
// -----------------------------------------------------------------------------
// GET  /fe/:token       署名付き編集トークンで開く公開編集ページ (worker-rendered HTML / 器=OD-5)。
// PATCH /fe/:token/save 編集保存 (弾M 純関数流用 → flat PATCH → persist 確認 → mirror 更新)。
// 最重要 = 「編集 URL が他人の回答を開けない」(AC-1)。token は 1 submission に束縛・enumeration 不能 (HMAC)。
// static export 制約回避 + same-origin (外部 referer 漏洩なし) で web 側 dynamic route を持たない (S-2 確定)。
// 認証除外 route (/api/ 配下でない = permissionMiddleware 対象外 / authMiddleware は index.ts 除外リストで skip)。
// =============================================================================

/** token を log/エラーに残さない redaction (path token 漏洩面の抑制 / T-B4b)。先頭 6 文字 + 省略記号のみ。 */
function redactToken(token: string | undefined | null): string {
  if (!token) return '(none)';
  return `${token.slice(0, 6)}…(${token.length})`;
}

/** HTML エスケープ (回答値/ラベルの XSS 防止)。 */
function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** no-store + no-referrer 応答ヘッダ (token 漏洩面抑制 / T-B4b)。 */
const FE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
};

interface PublicEditField {
  slug: string;
  label: string;
  type: string;
  required: boolean;
  editable: boolean;
}

/** definition_json から編集画面用の field メタ (id/type/label/required) を取り出す (装飾/壊れは除外)。 */
function parsePublicDefFields(definitionJson: string): Array<{ id: string; type: string; label: string; required: boolean }> {
  try {
    const d = JSON.parse(definitionJson) as { fields?: unknown };
    if (!Array.isArray(d.fields)) return [];
    return d.fields
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({ id: String(f.id ?? ''), type: String(f.type ?? ''), label: String(f.label ?? ''), required: f.required === true }))
      .filter((f) => f.id && f.type);
  } catch {
    return [];
  }
}

/**
 * 現行 form 定義 (編集時点 / T-B4d) から編集対象 field メタを組む。field_map の slug を harness id で join。
 * 装飾 (section/page_break) と未 push (slug=null) は除外。free-value のみ editable = true。
 * この list が **server-side allowlist の単一正本** (T-B3): 保存は本 list の free-value slug だけを PATCH する。
 */
async function buildPublicEditFields(db: D1Database, form: FormalooForm): Promise<PublicEditField[]> {
  const defFields = parsePublicDefFields(form.definition_json);
  const fieldMap = await getFormalooFieldMap(db, form.id);
  const slugById = new Map<string, string | null>();
  for (const r of fieldMap) slugById.set(r.id, r.formaloo_field_slug);
  return defFields
    .filter((f) => !isDecorationType(f.type))
    .map((f) => ({
      slug: (slugById.get(f.id) ?? null) as string | null,
      label: f.label,
      type: f.type,
      required: f.required,
      editable: isEditableFieldType(f.type),
    }))
    .filter((f): f is PublicEditField => f.slug != null);
}

type EditResolve =
  | { ok: true; form: FormalooForm; mirror: FormalooSubmissionRow; payload: EditTokenPayload }
  | { ok: false; status: number; reason: string };

/**
 * token 検証 + 開封時 live gate 再チェック (T-B4a) を 1 箇所に集約 (GET/save 共通)。
 * (a) 署名/期限 (verifyEditToken) (b) form 存在 (c) allow_post_edit=1 ∧ allow_edit_mail=1 が今も真
 * (d) 失効 epoch 一致 (bump 済なら無効) (e) row 存在 ∧ token の form に属する。
 * いずれか欠ければ ok=false = 編集画面を出さない/保存しない (署名有効でも失効・他人の回答を絶対 load しない)。
 */
async function resolveEditContext(env: Env['Bindings'], token: string): Promise<EditResolve> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = await verifyEditToken(token, env.FORMALOO_EDIT_TOKEN_SECRET, nowSec);
  if (!payload) return { ok: false, status: 403, reason: 'invalid_or_expired' };
  const form = await getFormalooForm(env.DB, payload.formId);
  if (!form || form.deleted) return { ok: false, status: 404, reason: 'form_gone' };
  // 開封時 live gate 再チェック (署名は stateless ゆえ失効できない → ここで現況を照合)。
  if (form.allow_post_edit !== 1 || form.allow_edit_mail !== 1) return { ok: false, status: 403, reason: 'disabled' };
  if (payload.epoch !== form.edit_link_epoch) return { ok: false, status: 403, reason: 'revoked' };
  const mirror = await getFormalooSubmission(env.DB, payload.rowRef);
  // token は 1 submission に束縛。form 不一致 (別 form の row) も拒否 = 他 submission を絶対 load しない。
  if (!mirror || mirror.form_id !== payload.formId) return { ok: false, status: 404, reason: 'row_gone' };
  return { ok: true, form, mirror, payload };
}

/** 正直なエラーページ (無効/期限切れ/失効)。回答値は一切載せない。 */
function renderErrorPage(): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>リンクが無効です</title>
<style>body{margin:0;font-family:-apple-system,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif;background:#f6f7f9;color:#333}.wrap{max-width:520px;margin:0 auto;padding:56px 20px}.card{background:#fff;border-radius:14px;padding:32px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06);text-align:center}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;color:#666;margin:0}</style></head>
<body><div class="wrap"><div class="card"><h1>このリンクは使用できません</h1><p>編集用リンクの有効期限が切れているか、無効になっています。<br>お手数ですが、フォームの管理者へお問い合わせください。</p></div></div></body></html>`;
}

/** 編集ページ (worker-rendered)。free-value は編集可・choice/file は read-only 表示。保存は fetch PATCH。 */
function renderEditPage(form: FormalooForm, fields: PublicEditField[], answers: Record<string, unknown>, token: string, version: string): string {
  const rows = fields
    .map((f) => {
      const cur = answers[f.slug];
      if (f.editable) {
        if (f.type === 'textarea') {
          return `<label class="fld"><span class="lbl">${escapeHtml(f.label)}${f.required ? ' <em>*</em>' : ''}</span><textarea name="${escapeHtml(f.slug)}" rows="4" ${f.required ? 'data-required="1"' : ''}>${escapeHtml(cur)}</textarea></label>`;
        }
        const inputType = f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'phone' ? 'tel' : f.type === 'date' ? 'date' : 'text';
        return `<label class="fld"><span class="lbl">${escapeHtml(f.label)}${f.required ? ' <em>*</em>' : ''}</span><input type="${inputType}" name="${escapeHtml(f.slug)}" value="${escapeHtml(cur)}" ${f.required ? 'data-required="1"' : ''}></label>`;
      }
      // read-only (choice/dropdown/multiple_select/file)。編集対象にしない (name を持たない = 保存対象外)。
      const shown = Array.isArray(cur) ? cur.join(', ') : String(cur ?? '');
      return `<div class="fld"><span class="lbl">${escapeHtml(f.label)}</span><div class="ro">${escapeHtml(shown) || '<span class="empty">（変更できません）</span>'}</div></div>`;
    })
    .join('\n');

  // token は URL path に既にあるため JS 変数に literal 埋め込みしない (save URL は現在の pathname から導出)。
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>回答の編集</title>
<style>
body{margin:0;font-family:-apple-system,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif;background:#f6f7f9;color:#1f2933}
.wrap{max-width:560px;margin:0 auto;padding:32px 18px 64px}
h1{font-size:19px;margin:0 0 4px}.sub{font-size:13px;color:#7b8794;margin:0 0 22px}
.card{background:#fff;border-radius:14px;padding:22px 20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.fld{display:block;margin-bottom:18px}
.lbl{display:block;font-size:13px;font-weight:600;margin-bottom:6px}.lbl em{color:#e0245e;font-style:normal}
input,textarea{width:100%;box-sizing:border-box;font-size:15px;padding:11px 12px;border:1px solid #d3dae0;border-radius:9px;background:#fff;font-family:inherit}
input:focus,textarea:focus{outline:none;border-color:#4a7bd6;box-shadow:0 0 0 3px rgba(74,123,214,.15)}
.ro{font-size:15px;padding:10px 12px;background:#f2f4f6;border-radius:9px;color:#52606d}.ro .empty{color:#9aa5b1}
.actions{margin-top:8px;display:flex;gap:10px}
button{flex:1;font-size:15px;font-weight:600;padding:12px;border-radius:10px;border:0;cursor:pointer}
.save{background:#2f6fed;color:#fff}.save:disabled{opacity:.5;cursor:default}
.msg{margin-top:14px;font-size:14px;text-align:center;min-height:20px}
.msg.ok{color:#0f9d58}.msg.err{color:#e0245e}
</style></head>
<body><div class="wrap">
<h1>回答の編集</h1>
<p class="sub">${escapeHtml(form.title)}</p>
<form id="fe-form" class="card" novalidate>
${rows}
<div class="actions"><button type="submit" class="save">保存する</button></div>
<div id="fe-msg" class="msg" role="status"></div>
</form>
</div>
<script>
(function(){
  var form=document.getElementById('fe-form'), msg=document.getElementById('fe-msg');
  var version=${JSON.stringify(version)};
  var saveUrl=location.pathname.replace(/\\/$/,'')+'/save';
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var answers={}, missing=false;
    form.querySelectorAll('input[name],textarea[name]').forEach(function(el){
      if(el.getAttribute('data-required')==='1' && !String(el.value).trim()) missing=true;
      answers[el.name]=el.value;
    });
    if(missing){ msg.className='msg err'; msg.textContent='必須項目を入力してください。'; return; }
    var btn=form.querySelector('button.save'); btn.disabled=true; msg.className='msg'; msg.textContent='保存中…';
    fetch(saveUrl,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:answers,version:version})})
      .then(function(r){return r.json().then(function(j){return {status:r.status,json:j};});})
      .then(function(res){
        btn.disabled=false;
        if(res.status===200 && res.json && res.json.success){ msg.className='msg ok'; msg.textContent='保存しました。'; if(res.json.version) version=res.json.version; }
        else if(res.status===409){ msg.className='msg err'; msg.textContent='この回答は別の場所で更新されました。ページを再読み込みしてください。'; }
        else { msg.className='msg err'; msg.textContent=(res.json&&res.json.error)||'保存できませんでした。'; }
      })
      .catch(function(){ btn.disabled=false; msg.className='msg err'; msg.textContent='通信に失敗しました。'; });
  });
})();
</script>
</body></html>`;
}

/** GET /fe/:token — 公開編集ページ (token 検証 + live gate → 編集画面 / 無効は正直エラー)。 */
formalooPublic.get('/fe/:token', async (c) => {
  const token = c.req.param('token');
  try {
    const ctx = await resolveEditContext(c.env, token);
    if (!ctx.ok) {
      return c.html(renderErrorPage(), ctx.status as 403 | 404, FE_HEADERS);
    }
    const fields = await buildPublicEditFields(c.env.DB, ctx.form);
    let answers: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(ctx.mirror.answers_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = parsed as Record<string, unknown>;
    } catch { /* 壊れ answers は空で描画 (fail-soft) */ }
    // 楽観的排他の version = mirror.synced_at (編集/管理者編集のたび更新される / T-B4c)。
    return c.html(renderEditPage(ctx.form, fields, answers, token, ctx.mirror.synced_at), 200, FE_HEADERS);
  } catch (err) {
    console.error(`/fe GET failed token=${redactToken(token)}:`, err);
    return c.html(renderErrorPage(), 500, FE_HEADERS);
  }
});

/**
 * PATCH /fe/:token/save — 公開編集の保存 (弾M form-post-edit の純関数を流用)。
 *   token 再検証 + live gate → 楽観的排他 → server-side allowlist (現行 def 可視 free-value のみ) →
 *   row_slug 解決 → Formaloo flat PATCH → **persist 確認** 成功時のみ D1 mirror 更新。
 *   非 persist / row_slug 不能 / client null / 必須空 は D1 を書かず正直エラー (soft-200 で成功偽装しない)。
 */
formalooPublic.patch('/fe/:token/save', async (c) => {
  const token = c.req.param('token');
  try {
    const ctx = await resolveEditContext(c.env, token);
    if (!ctx.ok) return c.json({ success: false, error: 'このリンクは使用できません' }, ctx.status as 403 | 404);
    const { form, mirror } = ctx;

    const body = await c.req.json<{ answers?: unknown; version?: unknown }>().catch(() => ({} as { answers?: unknown; version?: unknown }));
    const answers =
      body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? (body.answers as Record<string, unknown>)
        : null;
    if (!answers || Object.keys(answers).length === 0) {
      return c.json({ success: false, error: '編集内容がありません' }, 400);
    }

    // 楽観的排他 (T-B4c / G-7): load 時 version (synced_at) と現況を照合。不一致は上書きせず 409。
    if (body.version !== undefined && String(body.version) !== String(mirror.synced_at)) {
      return c.json({ success: false, error: 'この回答は別の場所で更新されました' }, 409);
    }

    // server-side allowlist = 現行 form 定義の可視 free-value slug のみ (T-B3 / T-B4d)。client 送信 field は信用しない。
    const editFields = (await buildPublicEditFields(c.env.DB, form)).map((f) => ({
      id: '', // buildFlatRowPatchBody は slug を第一に使う (id は harness-id keyed answer 用 / 公開編集は slug-keyed)
      slug: f.slug,
      fieldType: f.type,
      required: f.required,
    }));
    // slug→id map は不要 (公開編集の answers は slug-keyed)。buildFlatRowPatchBody が知らない/非 free-value を drop。
    const patchBody = buildFlatRowPatchBody(answers, editFields);
    if (Object.keys(patchBody).length === 0) {
      return c.json({ success: false, error: '編集できる項目がありません（選択式・ファイルは対象外です）' }, 400);
    }
    const requiredSlugs = new Set(editFields.filter((f) => f.required && f.slug).map((f) => f.slug as string));
    const missing = findEmptyRequired(patchBody, requiredSlugs);
    if (missing.length > 0) {
      return c.json({ success: false, error: '必須項目を空にできません' }, 400);
    }

    // Formaloo client (多鍵)。null (未登録/復号失敗/未接続) は誤送信防止契約継承 → D1 を書かず正直エラー。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (!client || !form.formaloo_slug) {
      return c.json({ success: false, error: '現在この回答は編集できません' }, 502);
    }

    // row_slug 解決 (stored → rows-list submit_code 照合)。不能は正直エラー (殻完了禁止)。
    const rowSlug = await resolveRowSlug(mirror, makeRowsListRowSlugResolver(client, form.formaloo_slug));
    if (!rowSlug) {
      return c.json({ success: false, error: 'この回答は識別子が取得できず編集できません' }, 422);
    }

    // flat PATCH → **persist 確認** (FRESH GET で編集後値照合)。反映されない編集を成功と見せない (soft-200 禁止)。
    const patchRes = await client.patch(`/v3.0/rows/${rowSlug}/`, patchBody);
    if (!patchRes.ok) {
      return c.json({ success: false, error: '反映に失敗しました（保存していません）' }, 502);
    }
    // 実 Formaloo GET /v3.0/rows/{slug}/ の flat slug map は data.row.data に在る (client が HTTP body を .data に
    // 包むため route からは verifyRes.data.data.row.data)。1 階層浅い data.data を読むと常に undefined → 誤 502。
    const verifyRes = await client.get<{ data?: { row?: { data?: Record<string, unknown> } } }>(`/v3.0/rows/${rowSlug}/`);
    const persisted = (verifyRes.ok ? verifyRes.data?.data?.row?.data : undefined) as Record<string, unknown> | undefined;
    const confirmed =
      persisted != null &&
      Object.entries(patchBody).every(([slug, val]) => String(persisted[slug] ?? '') === String(val ?? ''));
    if (!confirmed) {
      return c.json({ success: false, error: '反映が確認できませんでした（保存していません）' }, 502);
    }

    // 成功: D1 mirror 更新 (FRESH remote を正に patchBody を上書き) + row_slug backfill (legacy) + 最小監査。
    const prevRaw = safeParseAnswers(mirror.answers_json);
    const mergedAnswers = { ...prevRaw, ...persisted, ...patchBody };
    const newSyncedAt = jstNow();
    await c.env.DB
      .prepare('UPDATE formaloo_submissions SET answers_json = ?, synced_at = ? WHERE id = ?')
      .bind(JSON.stringify(mergedAnswers), newSyncedAt, mirror.id)
      .run();
    if (!mirror.formaloo_row_slug) await updateSubmissionRowSlug(c.env.DB, mirror.id, rowSlug);

    // 最小監査 (respondent 編集 / editor_staff_id=null = 非 staff)。変更フィールドのみ・fail-soft。
    for (const [slug, val] of Object.entries(patchBody)) {
      const oldVal = prevRaw[slug];
      if (String(oldVal ?? '') === String(val ?? '')) continue;
      try {
        await recordSubmissionEdit(c.env.DB, {
          submissionId: mirror.id,
          formId: form.id,
          editorStaffId: null,
          fieldSlug: slug,
          oldValue: oldVal == null ? null : String(oldVal),
          newValue: val == null ? null : String(val),
        });
      } catch (err) {
        console.error(`/fe save audit failed token=${redactToken(token)}:`, err);
      }
    }

    return c.json({ success: true, version: newSyncedAt });
  } catch (err) {
    console.error(`/fe save failed token=${redactToken(token)}:`, err);
    return c.json({ success: false, error: '保存できませんでした' }, 500);
  }
});

/** answers_json を安全に object へ (壊れ/配列は空 object)。 */
function safeParseAnswers(json: string): Record<string, unknown> {
  try {
    const p = JSON.parse(json);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
