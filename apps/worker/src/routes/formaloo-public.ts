import { Hono } from 'hono';
import {
  getFormalooForm,
  getFormalooFormBySlug,
  upsertFormalooSubmission,
  claimFormalooLineProcessing,
  incrementFormalooSubmitCount,
  addTagToFriend,
  enrollFriendInScenario,
  getFriendById,
  getFriendByLineUserId,
  jstNow,
  type FormalooForm,
} from '@line-crm/db';
import { isBuilderStatus, buildPublicUrl } from '../services/formaloo-publish-gate.js';
import { verifyWebhookToken, verifyHmacSignature, parseWebhookPayload } from '../services/formaloo-webhook.js';
import { signFriendToken } from '../services/formaloo-friend-token.js';
import type { Env } from '../index.js';

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

  // 6) 冪等 upsert (N-3 / 順序非依存)
  await upsertFormalooSubmission(c.env.DB, {
    id: parsed.submissionId,
    formId: form.id,
    formalooSlug: parsed.slug,
    friendId: parsed.friendId,
    answersJson: JSON.stringify(parsed.answers),
    submittedAt: parsed.submittedAt,
    verified,
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
  if (!lineUserId && !friendId && isLineApp && c.env.LIFF_URL) {
    const directUrl = `${c.env.WORKER_URL || new URL(c.req.url).origin}/fo/${id}`;
    return c.redirect(`${c.env.LIFF_URL}?redirect=${encodeURIComponent(directUrl)}`, 302);
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
    if (signed) {
      try {
        const u = new URL(url);
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
