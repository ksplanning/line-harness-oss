import { Hono } from 'hono';
import {
  listAbTests,
  createAbTest,
  getAbTestById,
  updateAbTest,
  deleteAbTest,
  createBroadcast,
  type AbTest,
  type AbMetric,
} from '@line-crm/db';
import { buildSegmentWhere } from '../services/segment-query.js';
import type { SegmentCondition } from '../services/segment-query.js';
import { splitAudience, decideWinner, type VariantInsight } from '../services/ab-split.js';
import type { Env } from '../index.js';

const abTests = new Hono<Env>();

/**
 * ab_tests は account-scoped (account_id NOT NULL)。GET/POST/PATCH/DELETE の 4 verb で accountId を
 * 必須にし、read/write を getAbTestById / listAbTests / update / delete のすべてで account_id = accountId
 * に絞る。→ 別 account の A/B テストは一覧に出ず、id を知っていても取得/編集/削除できない (getAbTestById
 * が account-scoped で null → 404 = 存在も伏せる / cross-account 漏洩ゼロ)。accountId 欠落は 400。
 *
 * 本 route は「作成・決定論的分割プレビュー・比較・勝ち→残りへの draft 生成」まで。実 A/B 分割送信・
 * 勝ち全配信の実発火は既存 owner-gated 送信経路のみ (本 route は multicast を一切叩かない = 送信ゼロ)。
 */

function serialize(t: AbTest) {
  return {
    id: t.id,
    accountId: t.account_id,
    name: t.name,
    metric: t.metric,
    status: t.status,
    winnerBroadcastId: t.winner_broadcast_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function isMetric(v: unknown): v is AbMetric {
  return v === 'open_rate' || v === 'click_rate';
}

// GET /api/ab-tests?accountId= — 自 account の A/B テスト一覧。
abTests.get('/api/ab-tests', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const items = await listAbTests(c.env.DB, accountId);
  return c.json({ success: true, data: items.map(serialize) });
});

// GET /api/ab-tests/:id?accountId= — account-scoped 取得 (別 account は 404)。
abTests.get('/api/ab-tests/:id', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const t = await getAbTestById(c.env.DB, c.req.param('id'), accountId);
  if (!t) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: serialize(t) });
});

// POST /api/ab-tests?accountId= — { name, metric }
abTests.post('/api/ab-tests', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const body = await c.req.json<{ name?: string; metric?: unknown }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ success: false, error: 'A/B テストの名前を入力してください' }, 400);
  if (!isMetric(body.metric)) {
    return c.json({ success: false, error: '比較指標は「開封率」か「クリック率」を選んでください' }, 400);
  }
  const created = await createAbTest(c.env.DB, { accountId, name, metric: body.metric });
  return c.json({ success: true, data: serialize(created) }, 201);
});

// PATCH /api/ab-tests/:id?accountId= — { name?, metric?, status? }
abTests.patch('/api/ab-tests/:id', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const existing = await getAbTestById(c.env.DB, id, accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ name?: string; metric?: unknown; status?: unknown }>();
  if (body.metric !== undefined && !isMetric(body.metric)) {
    return c.json({ success: false, error: '比較指標は「開封率」か「クリック率」を選んでください' }, 400);
  }
  if (body.status !== undefined && !['draft', 'running', 'decided'].includes(body.status as string)) {
    return c.json({ success: false, error: 'status が不正です' }, 400);
  }
  const updated = await updateAbTest(c.env.DB, id, accountId, {
    name: body.name !== undefined ? body.name.trim() : undefined,
    metric: body.metric !== undefined ? (body.metric as AbMetric) : undefined,
    status: body.status !== undefined ? (body.status as AbTest['status']) : undefined,
  });
  return c.json({ success: true, data: updated ? serialize(updated) : null });
});

// DELETE /api/ab-tests/:id?accountId=
abTests.delete('/api/ab-tests/:id', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const existing = await getAbTestById(c.env.DB, id, accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  await deleteAbTest(c.env.DB, id, accountId);
  return c.json({ success: true, data: null });
});

/**
 * POST /api/ab-tests/:id/split-preview?accountId= — { conditions } で対象 audience を解決し
 * 決定論・重複なしで案 A/B に分割した「件数プレビュー」を返す。**送信は一切しない**。
 */
abTests.post('/api/ab-tests/:id/split-preview', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const test = await getAbTestById(c.env.DB, id, accountId);
  if (!test) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ conditions?: SegmentCondition }>();
  try {
    const { clause, bindings } = buildSegmentWhere((body.conditions ?? { operator: 'AND', rules: [] }) as SegmentCondition);
    // account 条件を構造的に AND (HIGH-2 括弧維持で cross-account 非漏洩)。
    const sql = `SELECT f.id FROM friends f WHERE f.line_account_id = ? AND ${clause}`;
    const rows = await c.env.DB.prepare(sql).bind(accountId, ...bindings).all<{ id: string }>();
    const split = splitAudience(rows.results.map((r) => r.id));
    return c.json({
      success: true,
      data: { total: rows.results.length, counts: split.counts },
      // owner facing: 実送信は確認後。プレビューは数のみ。
      note: '実際に送るのは owner 確認後です (このプレビューは送信しません)',
    });
  } catch {
    return c.json({ success: false, error: 'Invalid segment conditions' }, 400);
  }
});

/**
 * GET /api/ab-tests/:id/compare?accountId= — 案 A/B の broadcasts の insight を variant 別に読み、
 * metric で勝ちを判定する (同点 tie 明示 / insight 未取得は dataPending=「データ取得待ち」)。
 */
abTests.get('/api/ab-tests/:id/compare', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const test = await getAbTestById(c.env.DB, id, accountId);
  if (!test) return c.json({ success: false, error: 'Not found' }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT b.id AS broadcast_id, b.ab_variant AS variant, bi.open_rate, bi.click_rate
       FROM broadcasts b
       LEFT JOIN broadcast_insights bi ON bi.broadcast_id = b.id
         AND bi.id = (SELECT id FROM broadcast_insights WHERE broadcast_id = b.id ORDER BY created_at DESC LIMIT 1)
      WHERE b.ab_test_id = ? AND b.ab_variant IS NOT NULL
      ORDER BY b.ab_variant ASC`,
  ).bind(id).all<{ broadcast_id: string; variant: string; open_rate: number | null; click_rate: number | null }>();
  const insights: VariantInsight[] = rows.results.map((r) => ({
    variant: r.variant,
    broadcastId: r.broadcast_id,
    openRate: r.open_rate,
    clickRate: r.click_rate,
  }));
  const comparison = decideWinner(insights, test.metric);
  return c.json({ success: true, data: comparison });
});

/**
 * POST /api/ab-tests/:id/winner-draft?accountId= — { winnerVariant } の案を残り audience に配信する
 * **下書きを作る**だけ (createBroadcast draft・status='draft'・実 multicast は叩かない)。ab_test の
 * winner_broadcast_id / status='decided' を刻む。実配信は既存の owner-gated 送信ボタンから。
 */
abTests.post('/api/ab-tests/:id/winner-draft', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const test = await getAbTestById(c.env.DB, id, accountId);
  if (!test) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ winnerVariant?: string }>();
  const variant = (body.winnerVariant ?? '').trim();
  if (!variant) return c.json({ success: false, error: '勝ち案 (variant) を指定してください' }, 400);

  const winner = await c.env.DB.prepare(
    `SELECT * FROM broadcasts WHERE ab_test_id = ? AND ab_variant = ? LIMIT 1`,
  ).bind(id, variant).first<Record<string, unknown>>();
  if (!winner) return c.json({ success: false, error: '指定した勝ち案の配信が見つかりません' }, 404);

  // 勝ち案の内容を残り audience 用の draft にコピー (送信しない = status='draft')。
  const draft = await createBroadcast(c.env.DB, {
    title: `${test.name}（勝ち案 ${variant}）残りへ配信`,
    messageType: winner.message_type as never,
    messageContent: winner.message_content as string,
    targetType: (winner.target_type as never) ?? 'all',
    targetTagId: (winner.target_tag_id as string | null) ?? null,
    senderPresetId: (winner.sender_preset_id as string | null) ?? null,
    abTestId: id,
    abVariant: 'winner',
  });
  // line_account_id を勝ち案から引き継ぐ (createBroadcast は line_account_id を持たないため後付け)。
  if (winner.line_account_id) {
    await c.env.DB.prepare(`UPDATE broadcasts SET line_account_id = ? WHERE id = ?`)
      .bind(winner.line_account_id, draft.id).run();
  }
  await updateAbTest(c.env.DB, id, accountId, { winnerBroadcastId: draft.id, status: 'decided' });

  return c.json({
    success: true,
    data: { draftBroadcastId: draft.id },
    note: '下書きを作成しました (すぐには送りません)。送信は配信画面の送信ボタンから owner 確認後に行ってください。',
  }, 201);
});

export { abTests };
