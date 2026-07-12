import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import { runStaffDocsAnswer, seedStaffDocs, type StaffDocInput } from '../services/staff-docs.js';
import { createFaqAiRuntime, DEFAULT_EMBED_NEURON_PER_MTOK } from '../services/llm/runtime.js';
import type { EmbedIngestConfig } from '../services/knowledge.js';
import type { Env } from '../index.js';

/**
 * line-staff-docs-chat Batch 1 — スタッフ用 常駐 RAG chat + admin seed endpoint。
 *
 *   POST /api/staff-docs/chat  — 質問 → runStaffDocsAnswer → {answer, citations, status}。**送信ゼロ** (LINE
 *     送信クライアントに触れない)。permission-map は prefix('staff-docs')→null (help chat=read-only 全認証可)。
 *   POST /api/staff-docs/seed  — 資料 manifest 取込。**admin 専用** (staff sentinel を書ける唯一の経路 / T-A7・
 *     BLOCKER-1)。requireRole('owner','admin')。manifest は local script (scripts/seed-staff-docs.mjs) が FS 読取
 *     して送る (Worker は FS 非対応 / T-A8・BLOCKER-3)。
 *
 * dark-ship: STAFF_DOCS_ENABLED != 'true' で両 route 404 (両面 OFF の worker 側 / plan §6・Codex #10)。
 * 顧客 FAQ 経路 (faq-reply の LINE 送信) とは呼び手ごと別物 = 混線ゼロ・送信ゼロ。
 */

const staffDocs = new Hono<Env>();

// staff ID 基準の soft rate-limit (in-memory sliding window / isolate 内・cold start でリセット可)。
// 既存 rateLimitMiddleware は認証前 token/cookie 先頭 16 文字単位で staff help に不適 (Codex #9) ゆえ専用。
const STAFF_CHAT_LIMIT = 20;
const STAFF_CHAT_WINDOW_MS = 60_000;
const chatHits = new Map<string, number[]>();
function allowStaffChat(staffId: string): boolean {
  const now = Date.now();
  const cutoff = now - STAFF_CHAT_WINDOW_MS;
  const arr = (chatHits.get(staffId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= STAFF_CHAT_LIMIT) {
    chatHits.set(staffId, arr);
    return false;
  }
  arr.push(now);
  chatHits.set(staffId, arr);
  return true;
}

function flagEnabled(env: Env['Bindings']): boolean {
  return env.STAFF_DOCS_ENABLED === 'true';
}

// POST /api/staff-docs/chat — スタッフ質問 → RAG 回答 (送信ゼロ・fail-closed)。
staffDocs.post('/api/staff-docs/chat', async (c) => {
  if (!flagEnabled(c.env)) return c.json({ success: false, error: 'not found' }, 404); // dark-ship
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'unauthorized' }, 401);
  if (!allowStaffChat(staff.id)) {
    return c.json({ success: false, error: 'ただいま混雑しています。少し後でお試しください。' }, 429);
  }

  let body: { question?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const question = (body.question ?? '').trim();
  if (!question) return c.json({ success: false, error: 'question is required' }, 400);

  const ai = createFaqAiRuntime(c.env);
  if (!ai) {
    // AI binding 未設定 (dev/dark) → 生成せず fail-closed (資料にありません相当)。
    return c.json({ success: true, data: { status: 'no_evidence', answer: '', citations: [] } });
  }
  const result = await runStaffDocsAnswer(c.env.DB, question, ai);
  return c.json({ success: true, data: result });
});

/** createFaqAiRuntime から embed 実行 config を組む (Vectorize/embedModel 未設定=null=no-op / dark-ship)。 */
function embedConfigFrom(ai: ReturnType<typeof createFaqAiRuntime>): EmbedIngestConfig | null {
  if (!ai?.vectorize || !ai.embedModelId) return null;
  return {
    provider: ai.provider,
    vectorize: ai.vectorize,
    embedModelId: ai.embedModelId,
    embedNeuronPerMTok: ai.embedNeuronPerMTok ?? DEFAULT_EMBED_NEURON_PER_MTOK,
    globalBudget: ai.dailyNeuronBudgetGlobal,
    perAccountBudget: ai.dailyNeuronBudgetPerAccount,
  };
}

// POST /api/staff-docs/seed — admin 専用 (staff sentinel を書ける唯一の経路 / T-A7・T-A8)。
staffDocs.post('/api/staff-docs/seed', requireRole('owner', 'admin'), async (c) => {
  if (!flagEnabled(c.env)) return c.json({ success: false, error: 'not found' }, 404);

  let body: { docs?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const raw = Array.isArray(body.docs) ? body.docs : [];
  if (raw.length === 0) return c.json({ success: false, error: 'docs is required' }, 400);
  const docs: StaffDocInput[] = [];
  for (const d of raw) {
    if (!d || typeof (d as StaffDocInput).docKey !== 'string' || typeof (d as StaffDocInput).title !== 'string' || typeof (d as StaffDocInput).content !== 'string') {
      return c.json({ success: false, error: 'each doc requires docKey/title/content (string)' }, 400);
    }
    docs.push({ docKey: (d as StaffDocInput).docKey, title: (d as StaffDocInput).title, content: (d as StaffDocInput).content });
  }

  const embedCfg = embedConfigFrom(createFaqAiRuntime(c.env));
  const result = await seedStaffDocs(c.env.DB, docs, embedCfg);
  return c.json({ success: true, data: result });
});

export { staffDocs };
