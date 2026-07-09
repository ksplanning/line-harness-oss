import { Hono } from 'hono';
import {
  getFormalooFormBySlug,
  upsertFormalooSubmission,
  claimFormalooLineProcessing,
  incrementFormalooSubmitCount,
  addTagToFriend,
  enrollFriendInScenario,
  getFriendById,
  type FormalooForm,
} from '@line-crm/db';
import { isBuilderStatus } from '../services/formaloo-publish-gate.js';
import { verifyWebhookToken, verifyHmacSignature, parseWebhookPayload } from '../services/formaloo-webhook.js';
import type { Env } from '../index.js';

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
  const parsed = parseWebhookPayload(payload, new Date().toISOString());
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
  //    draft/preview・未署名隔離は発火しない (TRINA 実顧客への誤送信を防ぐ = failure_observable 回避)。
  const status = isBuilderStatus(form.builder_status) ? form.builder_status : 'draft';
  if (verified && status === 'published') {
    const claimed = await claimFormalooLineProcessing(c.env.DB, parsed.submissionId);
    if (claimed) {
      await fireFormalooSubmitSideEffects(c, form, parsed.friendId);
      await incrementFormalooSubmitCount(c.env.DB, form.id);
    }
  }

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
