import { Hono } from 'hono';
import {
  createKnowledgeDocument,
  insertKnowledgeChunks,
  listKnowledgeDocuments,
  getKnowledgeDocumentById,
  deleteKnowledgeDocument,
  type KnowledgeDocument,
} from '@line-crm/db';
import {
  getChunksBySourceDoc,
  getDocumentChunkStats,
  type DocumentChunkStat,
  listAiUsageForAccount,
  listAiUsageGlobal,
  listAiFaqDrafts,
  countEmbeddedChunks,
  type AiUsageBudgetRow,
  type AiFaqDraftRow,
} from '@line-crm/db';
import { safeFetch, resolveViaDoh, INGEST_ALLOWED_CONTENT_TYPES, SsrfBlockedError } from '../lib/ssrf-guard.js';
import { sanitizeIngestedText, splitIntoChunks, buildChunkSearchText, embedChunksForDocument } from '../services/knowledge.js';
import { createFaqAiRuntime, DEFAULT_EMBED_NEURON_PER_MTOK } from '../services/llm/runtime.js';
import { deleteChunkVectors } from '../services/vectorize.js';
import type { Env } from '../index.js';

/**
 * Phase B B-3 (T-C4/T-C1) — 取込ナレッジ endpoint 群 (account-scoped・既存 faq 権限で gate・**送信ゼロ**)。
 *   POST   /api/knowledge/ingest        (kind=text|url) — 取込→sanitize→分割→document+chunks (batch 原子性)
 *   GET    /api/knowledge/documents      — account スコープ資料一覧
 *   GET    /api/knowledge/documents/:id  — 単体 (accountScopeReject)
 *   DELETE /api/knowledge/documents/:id  — 資料単位削除 (chunks→document アプリ側順・accountScopeReject)
 *
 * permission は permission-map.ts の prefix('knowledge')→'faq' で gate (新 FeatureKey なし / Codex #12)。
 * chunk 本文/search_text は API に露出しない (serialize allowlist・M-7/8)。**live RAG に結線しない** (B-4)。
 */

const knowledge = new Hono<Env>();

/**
 * serialize allowlist (search_text は chunk 側の内部索引列で document には無いが、思想を踏襲し明示 allowlist)。
 * stats を渡すと chunkCount/embeddedCount を additive 露出する (embed 状態表示 / B-5 T-E2・M-8 serialize round-trip)。
 */
function serializeDocument(d: KnowledgeDocument, stats?: DocumentChunkStat) {
  return {
    id: d.id,
    lineAccountId: d.line_account_id,
    sourceType: d.source_type,
    sourceUrl: d.source_url,
    title: d.title,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    ...(stats ? { chunkCount: stats.chunkCount, embeddedCount: stats.embeddedCount } : {}),
  };
}

/**
 * 静的 HTML → 本文テキスト抽出 (script/style/nav/footer 等を除去・タグ除去・主要エンティティ復号)。**JS 非実行** (D4)。
 *
 * NOTE (spec §5-1 の HTMLRewriter からの意図的差替・理由明記): Cloudflare Workers の HTMLRewriter は
 * streaming 抽出 API だが vitest(node) 環境では未定義で url 取込経路が単体テスト不能になり、本番だけで
 * 動く untested code (hollow completion) を生む。静的 HTML (D4 = JS 描画/ログイン要は範囲外) では JS を
 * 実行せず script/style を除去する本純関数と機能等価であり、全経路 (node/Workers 同一挙動) をテスト可能に
 * するため純関数抽出を採用する。worker に headless/JS 実行経路は存在しない (grep 0 / T-C1)。
 */
export function extractHtmlBodyText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 本文でない要素は中身ごと除去。
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // ブロック境界を改行に (段落構造を splitIntoChunks に伝える)。
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' '); // 残りのタグ除去
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
  return s;
}

/** account-scoped 既存行の scope 検証 (saved-searches.ts:64 正典)。global(null) は常に許可・不一致は 403。 */
function accountScopeReject(existing: { line_account_id: string | null }, accountId: string | null): Response | null {
  if (existing.line_account_id !== null && existing.line_account_id !== accountId) {
    return Response.json({ success: false, error: 'knowledge account mismatch' }, { status: 403 });
  }
  return null;
}

// POST /api/knowledge/ingest — text/url 取込 (送信ゼロ)。
knowledge.post('/api/knowledge/ingest', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  // POST スコープ (Codex #11): 作成 account = 認証スコープ。global(null) 作成は露出しない。
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 403);
  let body: { kind?: string; url?: string; content?: string; title?: string; accountId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  // body が別 account を指す場合は不一致 403。
  if (body.accountId && body.accountId !== accountId) {
    return c.json({ success: false, error: 'account scope mismatch' }, 403);
  }

  let text: string;
  let sourceType: 'url' | 'text';
  let sourceUrl: string | null = null;
  if (body.kind === 'url') {
    if (!body.url?.trim()) return c.json({ success: false, error: 'url is required' }, 400);
    try {
      const res = await safeFetch(body.url, {
        resolve: resolveViaDoh,
        fetchImpl: fetch,
        allowedContentTypes: INGEST_ALLOWED_CONTENT_TYPES,
      });
      sourceUrl = res.finalUrl;
      text = sanitizeIngestedText(extractHtmlBodyText(res.text));
    } catch (e) {
      // SSRF/範囲外 (content-type 非allowlist・JS 描画必須で本文取れず等) は [制約] として拒否。
      if (e instanceof SsrfBlockedError) return c.json({ success: false, error: `取り込めない URL です (${e.reason})` }, 400);
      return c.json({ success: false, error: 'URL の取得に失敗しました' }, 400);
    }
    sourceType = 'url';
  } else if (body.kind === 'text') {
    if (!body.content?.trim()) return c.json({ success: false, error: 'content is required' }, 400);
    text = sanitizeIngestedText(body.content);
    sourceType = 'text';
  } else {
    return c.json({ success: false, error: "kind must be 'text' or 'url'" }, 400);
  }

  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) return c.json({ success: false, error: '取り込める本文がありませんでした' }, 400);

  const doc = await createKnowledgeDocument(c.env.DB, { lineAccountId: accountId, sourceType, sourceUrl, title: body.title ?? null });
  try {
    // worker 層が search_text を計算 → db は保存のみ (batch 原子性・account 同値コピー)。
    await insertKnowledgeChunks(
      c.env.DB,
      doc.id,
      accountId,
      chunks.map((content, i) => ({ chunkIndex: i, content, searchText: buildChunkSearchText(content) })),
    );
  } catch {
    // chunks batch 失敗時は部分 document を残さない (§4-1 原子性・補償削除)。
    await deleteKnowledgeDocument(c.env.DB, doc.id).catch(() => {});
    return c.json({ success: false, error: '取り込みの保存に失敗しました' }, 500);
  }

  // B-4 (T-D5/T-D7): chunk 保存後に embed + Vectorize upsert (予算 gated・best-effort)。Vectorize 未 binding
  // (dark-ship/dev) では createFaqAiRuntime が vectorize:null を返し no-op = FTS のみ (B-3 挙動)。embed 失敗は
  // ingest を失敗させない (chunks は既に保存済で FTS で機能・embedded_at=null は後で backfill embed)。
  const ai = createFaqAiRuntime(c.env);
  if (ai?.vectorize && ai.embedModelId) {
    try {
      await embedChunksForDocument(
        c.env.DB,
        {
          provider: ai.provider,
          vectorize: ai.vectorize,
          embedModelId: ai.embedModelId,
          embedNeuronPerMTok: ai.embedNeuronPerMTok ?? DEFAULT_EMBED_NEURON_PER_MTOK,
          globalBudget: ai.dailyNeuronBudgetGlobal,
          perAccountBudget: ai.dailyNeuronBudgetPerAccount,
        },
        doc.id,
        accountId,
      );
    } catch (err) {
      console.error('knowledge ingest embed failed:', err instanceof Error ? err.name : 'unknown');
    }
  }
  return c.json({ success: true, data: { ...serializeDocument(doc), chunkCount: chunks.length } }, 201);
});

// GET /api/knowledge/documents — account スコープ一覧 (global + 指定 account) + embed 状態 (T-E2)。
knowledge.get('/api/knowledge/documents', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const docs = await listKnowledgeDocuments(c.env.DB, accountId);
  // chunk/embed 集計を account 条件付きで join (chunk 0 の doc は 0 default)。
  const stats = await getDocumentChunkStats(c.env.DB, accountId, docs.map((d) => d.id));
  return c.json({
    success: true,
    data: docs.map((d) => serializeDocument(d, stats[d.id] ?? { chunkCount: 0, embeddedCount: 0 })),
  });
});

// GET /api/knowledge/documents/:id — 単体 (accountScopeReject)。
knowledge.get('/api/knowledge/documents/:id', async (c) => {
  const doc = await getKnowledgeDocumentById(c.env.DB, c.req.param('id'));
  if (!doc) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(doc, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  return c.json({ success: true, data: serializeDocument(doc) });
});

// DELETE /api/knowledge/documents/:id — 資料単位削除 (chunks→document アプリ側順・accountScopeReject)。
knowledge.delete('/api/knowledge/documents/:id', async (c) => {
  const doc = await getKnowledgeDocumentById(c.env.DB, c.req.param('id'));
  if (!doc) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(doc, c.req.query('accountId') ?? null);
  if (rejected) return rejected;

  // B-4 (T-D7): D1 削除の**前**に chunk id を取得し (削除後は id が分からず orphan 化)、Vectorize ベクトルを
  // **先に**削除試行 → 成功後 D1 (chunks→document) 削除の順で「孤児ベクトルが再作成 doc へ leak」を防ぐ。
  // Vectorize 削除失敗は id をログ (再試行キュー相当) に残し D1 削除は続行 (孤児は掃除ジョブが回収 / spec §7)。
  const ai = createFaqAiRuntime(c.env);
  if (ai?.vectorize) {
    const chunkIds = (await getChunksBySourceDoc(c.env.DB, doc.id)).map((ch) => ch.id);
    if (chunkIds.length > 0) {
      try {
        await deleteChunkVectors(ai.vectorize, chunkIds);
      } catch (err) {
        console.error('knowledge delete vectorize cleanup deferred:', doc.id, chunkIds.length, err instanceof Error ? err.name : 'unknown');
      }
    }
  }
  await deleteKnowledgeDocument(c.env.DB, doc.id);
  return c.json({ success: true });
});

// clamp: 数値 query を [1, max] に収める (不正/欠損は default・無制限レスポンス防止 / M-3)。
function clampInt(v: string | undefined, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** AI 使用量行の serialize allowlist (neuron/日次のみ・内部 id を露出しない / D-3)。 */
function serializeUsage(r: AiUsageBudgetRow) {
  return {
    usageDate: r.usage_date,
    llmNeurons: Number(r.llm_neurons),
    embedNeurons: Number(r.embed_neurons),
    imageNeurons: Number(r.image_neurons),
    replyCount: Number(r.reply_count),
  };
}

/** AI 草案の serialize allowlist (question/draft/status/日時のみ・friend_id/account_id/evidence は非露出 / D-3・B5-6)。 */
function serializeDraft(r: AiFaqDraftRow) {
  return {
    id: r.id,
    question: r.question,
    draftAnswer: r.draft_answer,
    status: r.status,
    createdAt: r.created_at,
  };
}

// GET /api/knowledge/ai-usage — AI 使用量/コスト (per-account + global SUM + embed 済 chunk 数)。
// permission-map prefix('knowledge')→'faq' で gate (別 route なし)。**送信ゼロ・秘密非露出**。
knowledge.get('/api/knowledge/ai-usage', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const days = clampInt(c.req.query('days'), 30, 365);
  const account = accountId ? (await listAiUsageForAccount(c.env.DB, accountId, days)).map(serializeUsage) : [];
  const global = (await listAiUsageGlobal(c.env.DB, days)).map(serializeUsage);
  // Vectorize stored dims の下限推定に使う embed 済 chunk 数 (§4-4)。次元は provisioning 後に UI で掛ける。
  const embeddedChunks = await countEmbeddedChunks(c.env.DB, accountId);
  return c.json({ success: true, data: { account, global, embeddedChunks } });
});

// GET /api/knowledge/ai-drafts — AI 草案ログ (draft のみ・auto-send 回答は非保存)。account スコープ・秘密非露出。
knowledge.get('/api/knowledge/ai-drafts', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const status = c.req.query('status') || undefined;
  const limit = clampInt(c.req.query('limit'), 100, 500);
  const drafts = (await listAiFaqDrafts(c.env.DB, accountId, status, limit)).map(serializeDraft);
  return c.json({ success: true, data: drafts });
});

export { knowledge };
