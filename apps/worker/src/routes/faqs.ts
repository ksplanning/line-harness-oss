import { Hono } from 'hono';
import {
  createFaq,
  deleteFaq,
  getFaqById,
  getFaqs,
  getUnmatchedById,
  getUnmatchedQuestions,
  markUnmatchedResolved,
  updateFaq,
} from '@line-crm/db';
import type { Faq as DbFaq, UnmatchedQuestion as DbUnmatchedQuestion } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  DEFAULT_FAQ_PERSONAL_CONTEXT_SETTINGS,
  normalizeFaqPersonalContextSettings,
} from '../services/faq-personal-context.js';
// Phase B B-2 (T-B5-a): search_text は worker 層 (faq-fts) が計算し createFaq/updateFaq に渡す
// (db は保存のみ・依存方向)。全書込呼出元でこの helper を通す (grep 3 段の対象)。
import { buildFaqSearchText } from '../services/faq-fts.js';

const faqs = new Hono<Env>();

const DEFAULT_FAQ_BOT_SETTINGS = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
  // AI 回答モード。'auto'=送信 / 'draft'=草案保存。安全側の既定は 'draft'。
  answerMode: 'draft' as 'auto' | 'draft',
  personalContext: DEFAULT_FAQ_PERSONAL_CONTEXT_SETTINGS,
};

type FaqBotSettingsInput = Partial<Omit<typeof DEFAULT_FAQ_BOT_SETTINGS, 'personalContext'>> & {
  personalContext?: unknown;
};

function parseVariants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function serializeFaq(row: DbFaq) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    question: row.question,
    variants: parseVariants(row.variants),
    answer: row.answer,
    isActive: Boolean(row.is_active),
    hitCount: row.hit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeUnmatched(row: DbUnmatchedQuestion) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    friendId: row.friend_id,
    question: row.question,
    topScore: row.top_score,
    resolvedFaqId: row.resolved_faq_id,
    createdAt: row.created_at,
  };
}

function normalizeSettings(input: FaqBotSettingsInput) {
  return {
    enabled: input.enabled === true,
    threshold: typeof input.threshold === 'number' ? input.threshold : DEFAULT_FAQ_BOT_SETTINGS.threshold,
    handoffMessage: typeof input.handoffMessage === 'string' ? input.handoffMessage : DEFAULT_FAQ_BOT_SETTINGS.handoffMessage,
    autoReplyNotice: typeof input.autoReplyNotice === 'string' ? input.autoReplyNotice : DEFAULT_FAQ_BOT_SETTINGS.autoReplyNotice,
    maxRepliesPerDay: typeof input.maxRepliesPerDay === 'number' ? input.maxRepliesPerDay : DEFAULT_FAQ_BOT_SETTINGS.maxRepliesPerDay,
    answerMode: input.answerMode === 'auto' || input.answerMode === 'draft'
      ? input.answerMode
      : DEFAULT_FAQ_BOT_SETTINGS.answerMode,
    personalContext: normalizeFaqPersonalContextSettings(input.personalContext),
  };
}

function parseStoredSettings(value: string | null | undefined) {
  if (!value) return normalizeSettings({});
  const failSafe = () => ({
    ...normalizeSettings({}),
    personalContext: normalizeFaqPersonalContextSettings(null),
  });
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return failSafe();
    }
    return normalizeSettings(parsed as FaqBotSettingsInput);
  } catch {
    return failSafe();
  }
}

function nowJst(): string {
  return new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
}

faqs.get('/api/faqs', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const rows = await getFaqs(c.env.DB, accountId || undefined);
    return c.json({ success: true, data: rows.map(serializeFaq) });
  } catch (err) {
    console.error('GET /api/faqs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.post('/api/faqs', async (c) => {
  try {
    const body = await c.req.json<{
      question?: string;
      variants?: string[];
      answer?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (!body.question?.trim()) return c.json({ success: false, error: 'question is required' }, 400);
    if (!body.answer?.trim()) return c.json({ success: false, error: 'answer is required' }, 400);
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }

    const item = await createFaq(c.env.DB, {
      question: body.question,
      variants: body.variants ?? [],
      answer: body.answer,
      lineAccountId: body.lineAccountId ?? null,
      isActive: body.isActive ?? true,
      searchText: buildFaqSearchText(body.question, body.variants ?? []),
    });
    return c.json({ success: true, data: serializeFaq(item) }, 201);
  } catch (err) {
    console.error('POST /api/faqs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * question 正規化 — 重複突合の「単一正典」(サーバ側・最終ガード)。
 *
 * ⚠️ UI 側 apps/web/src/lib/faq-bulk/normalize.ts と**同一入力→同一出力**であること。
 * 変更時は必ず両側を一致させる (spec §API 重複判定 / D-19)。
 * 変更したら faqs.test.ts と normalize.test.ts の両パリティテストを緑にする。
 *
 * ステップ: 全角ASCII→半角 / 全角スペース→半角 / 連続空白畳み+trim / 小文字化。
 */
export function bulkNormalizeQuestion(input: string): string {
  if (!input) return '';
  let s = input.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/　/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.toLowerCase();
}

const BULK_MAX_ITEMS = 500;
const BULK_QUESTION_MAX = 400;
const BULK_ANSWER_MAX = 2000;
// reviewer R1-H2 (DoS): variants の件数/要素長に上限を設ける (無制限だと巨大 variants で
// D1 書き込み肥大・メモリ膨張)。要素長は question(400) と整合する 200 字。UI validate.ts と同値。
const BULK_VARIANTS_MAX = 10;
const BULK_VARIANT_LEN_MAX = 200;

interface BulkItem {
  question?: string;
  variants?: string[];
  answer?: string;
  isActive?: boolean;
  mode?: 'create' | 'overwrite';
  overwriteId?: string;
}

type BulkRowStatus = 'created' | 'updated' | 'skipped' | 'error';

interface BulkRowResult {
  index: number;
  status: BulkRowStatus;
  faqId?: string;
  error?: string;
}

/**
 * POST /api/faqs/bulk — FAQ の一括登録 (spec §API 契約)。
 *
 * - auth/CSRF: index.ts の authMiddleware でカバー済 (追加ミドルウェア不要)。
 * - scope: body の lineAccountId 1 個で全 item 統一 (item 個別 account を持たない =
 *   「item ごとに別 account へ漏れる」は構造的に不可能)。
 * - overwrite: overwriteId の対象 FAQ の line_account_id が body と一致するときのみ更新
 *   (不一致は error にして他アカFAQ上書きを拒否 / D-18)。
 * - 重複: 既存 question と正規化突合し create でも既存があれば skipped (最終ガード / D-12)。
 * - 部分失敗: all-or-nothing にせず行別 results を返す (1 行の失敗で全体を落とさない / D-11)。
 * - INSERT/UPDATE は createFaq/updateFaq helper のみ (bind 済 = SQLi なし・別経路を作らない)。
 */
faqs.post('/api/faqs/bulk', async (c) => {
  try {
    const body = await c.req.json<{ lineAccountId?: string | null; items?: unknown }>();
    const items = body.items;
    if (!Array.isArray(items)) {
      return c.json({ success: false, error: 'items must be an array' }, 400);
    }
    if (items.length > BULK_MAX_ITEMS) {
      return c.json({ success: false, error: `一度に登録できるのは${BULK_MAX_ITEMS}件までです` }, 400);
    }

    // reviewer R1-H1 (情報漏洩): lineAccountId は「null (全アカ共通)」か「非空文字列 (個別 account)」
    // のいずれかでなければならない。空文字/空白/欠落/非文字列を通すと getFaqs(db,'') の
    // if(lineAccountId) が falsy になり全アカ FAQ を SELECT → 他アカの question が dedup 索引へ
    // 漏れる。ここで明示的に 400 拒否し、以降の getFaqs は必ず null か有効 account だけになる。
    const rawScope = (body as { lineAccountId?: unknown }).lineAccountId;
    let lineAccountId: string | null;
    if (rawScope === null || rawScope === undefined) {
      // 欠落は誤って全アカ共通登録されないよう拒否 (明示的に null を送る必要がある)。
      if (rawScope === undefined) {
        return c.json({ success: false, error: 'lineAccountId is required (send null for all-account)' }, 400);
      }
      lineAccountId = null;
    } else if (typeof rawScope === 'string') {
      if (rawScope.trim() === '') {
        return c.json({ success: false, error: 'lineAccountId must not be empty' }, 400);
      }
      lineAccountId = rawScope;
    } else {
      return c.json({ success: false, error: 'lineAccountId must be a string or null' }, 400);
    }

    // 既存 FAQ を account スコープで取得し、正規化 question → id を索引化 (最終ガード)。
    const existing = await getFaqs(c.env.DB, lineAccountId ?? undefined);
    const existingByKey = new Map<string, string>();
    for (const f of existing) {
      // 全アカ共通 (null) と個別 account の突合スコープを分ける:
      // body が null のときは既存 null のみ、body が account のときは同 account or null を既存として扱う。
      // getFaqs(account) は「NULL or 一致」を返すため、null-body 時のみ null に絞る。
      if (lineAccountId === null && f.line_account_id !== null) continue;
      const key = bulkNormalizeQuestion(f.question);
      if (key !== '' && !existingByKey.has(key)) existingByKey.set(key, f.id);
    }

    const results: BulkRowResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (let index = 0; index < items.length; index++) {
      const item = items[index] as BulkItem;
      try {
        const question = typeof item.question === 'string' ? item.question.trim() : '';
        const answer = typeof item.answer === 'string' ? item.answer.trim() : '';
        const variants = Array.isArray(item.variants)
          ? item.variants.filter((v): v is string => typeof v === 'string')
          : [];

        if (question === '') {
          results.push({ index, status: 'error', error: '質問が空です' });
          errors++;
          continue;
        }
        if (answer === '') {
          results.push({ index, status: 'error', error: '答えが空です' });
          errors++;
          continue;
        }
        if (question.length > BULK_QUESTION_MAX) {
          results.push({ index, status: 'error', error: `質問が長すぎます（${BULK_QUESTION_MAX}文字まで）` });
          errors++;
          continue;
        }
        if (answer.length > BULK_ANSWER_MAX) {
          results.push({ index, status: 'error', error: `答えが長すぎます（${BULK_ANSWER_MAX}文字まで）` });
          errors++;
          continue;
        }
        // reviewer R1-H2: variants の件数上限・要素長上限を server で enforce (DoS 防御)。
        if (variants.length > BULK_VARIANTS_MAX) {
          results.push({ index, status: 'error', error: `言い換えは${BULK_VARIANTS_MAX}個までです` });
          errors++;
          continue;
        }
        if (variants.some((v) => v.length > BULK_VARIANT_LEN_MAX)) {
          results.push({ index, status: 'error', error: `言い換えが長すぎます（${BULK_VARIANT_LEN_MAX}文字まで）` });
          errors++;
          continue;
        }

        if (item.mode === 'overwrite') {
          const overwriteId = typeof item.overwriteId === 'string' ? item.overwriteId : '';
          if (overwriteId === '') {
            results.push({ index, status: 'error', error: '上書き対象が指定されていません' });
            errors++;
            continue;
          }
          // overwriteId の scope 検証 (D-18): 対象 FAQ の line_account_id が body と一致すること。
          const target = await getFaqById(c.env.DB, overwriteId);
          if (!target) {
            results.push({ index, status: 'error', error: '上書き対象が見つかりません' });
            errors++;
            continue;
          }
          const targetScope = target.line_account_id;
          // body null ↔ 対象 null、または body=account ↔ 対象=同 account のみ許可。
          if (targetScope !== lineAccountId) {
            results.push({ index, status: 'error', error: '別のアカウントの質問は上書きできません' });
            errors++;
            continue;
          }
          const upd = await updateFaq(c.env.DB, overwriteId, {
            answer,
            variants,
            isActive: item.isActive,
            // overwrite は question を変えない → 既存 target.question + 新 variants で再計算。
            searchText: buildFaqSearchText(target.question, variants),
          });
          if (!upd) {
            results.push({ index, status: 'error', error: '上書きに失敗しました' });
            errors++;
            continue;
          }
          updated++;
          results.push({ index, status: 'updated', faqId: upd.id });
          continue;
        }

        // create モード: 既存 question と正規化突合 (最終ガード)。既にあれば skipped。
        const key = bulkNormalizeQuestion(question);
        const dupId = existingByKey.get(key);
        if (dupId !== undefined) {
          skipped++;
          results.push({ index, status: 'skipped', faqId: dupId });
          continue;
        }

        const createdFaq = await createFaq(c.env.DB, {
          question,
          variants,
          answer,
          lineAccountId,
          isActive: item.isActive ?? true,
          searchText: buildFaqSearchText(question, variants),
        });
        // 同一リクエスト内での二重登録も防ぐため索引に足す。
        if (key !== '') existingByKey.set(key, createdFaq.id);
        created++;
        results.push({ index, status: 'created', faqId: createdFaq.id });
      } catch (rowErr) {
        console.error(`POST /api/faqs/bulk row ${index} error:`, rowErr);
        results.push({ index, status: 'error', error: '登録に失敗しました' });
        errors++;
      }
    }

    return c.json({ success: true, data: { created, updated, skipped, errors, results } });
  } catch (err) {
    console.error('POST /api/faqs/bulk error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.put('/api/faqs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      question?: string;
      variants?: string[];
      answer?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }

    const input: Parameters<typeof updateFaq>[2] = {};
    if (body.question !== undefined) input.question = body.question;
    if (body.variants !== undefined) input.variants = body.variants;
    if (body.answer !== undefined) input.answer = body.answer;
    if ('lineAccountId' in body) input.lineAccountId = body.lineAccountId ?? null;
    if (body.isActive !== undefined) input.isActive = body.isActive;

    // B-2 (T-B5-a): question/variants が変わる時のみ search_text を再計算 (最終値=body ?? 既存で算出)。
    // answer/isActive のみの変更では既存 search_text を保持 (updateFaq が省略時保持)。
    if (body.question !== undefined || body.variants !== undefined) {
      const current = await getFaqById(c.env.DB, id);
      if (current) {
        const question = body.question ?? current.question;
        const variants = body.variants ?? parseVariants(current.variants);
        input.searchText = buildFaqSearchText(question, variants);
      }
    }

    const updated = await updateFaq(c.env.DB, id, input);
    if (!updated) return c.json({ success: false, error: 'FAQ not found' }, 404);
    return c.json({ success: true, data: serializeFaq(updated) });
  } catch (err) {
    console.error('PUT /api/faqs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.delete('/api/faqs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getFaqById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'FAQ not found' }, 404);
    await deleteFaq(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/faqs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.get('/api/faqs/unmatched', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const rows = await getUnmatchedQuestions(c.env.DB, accountId || undefined);
    return c.json({ success: true, data: rows.map(serializeUnmatched) });
  } catch (err) {
    console.error('GET /api/faqs/unmatched error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.post('/api/faqs/from-unmatched/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      answer?: string;
      variants?: string[];
      question?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (!body.answer?.trim()) return c.json({ success: false, error: 'answer is required' }, 400);
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }
    const unmatched = await getUnmatchedById(c.env.DB, id);
    if (!unmatched) return c.json({ success: false, error: 'Unmatched question not found' }, 404);

    const question = body.question?.trim() || unmatched.question;
    const variants = body.variants ?? [];
    const item = await createFaq(c.env.DB, {
      question,
      variants,
      answer: body.answer,
      lineAccountId: 'lineAccountId' in body ? (body.lineAccountId ?? null) : unmatched.line_account_id,
      // reviewer R1-I1: EditDialog が送る isActive を尊重する。無効で昇格したら無効 FAQ を作る
      // (flag ON アカウントで意図せぬ自動返信の入口にしない)。省略時のみ既定 true。
      isActive: body.isActive ?? true,
      searchText: buildFaqSearchText(question, variants),
    });
    await markUnmatchedResolved(c.env.DB, id, item.id);
    return c.json({ success: true, data: serializeFaq(item) }, 201);
  } catch (err) {
    console.error('POST /api/faqs/from-unmatched/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.get('/api/account-settings/faq-bot', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`)
    .bind(accountId)
    .first<{ value: string }>();
  const value = parseStoredSettings(row?.value);
  return c.json({ success: true, data: value });
});

faqs.put('/api/account-settings/faq-bot', async (c) => {
  const body = await c.req.json<FaqBotSettingsInput & { accountId?: string }>();
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const existingRow = await c.env.DB
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`)
    .bind(body.accountId)
    .first<{ value: string }>();
  const existing = parseStoredSettings(existingRow?.value);
  const value = normalizeSettings({
    ...body,
    // Old clients know nothing about this additive setting. Omission must keep
    // an administrator's saved choice instead of silently restoring default ON.
    personalContext: Object.prototype.hasOwnProperty.call(body, 'personalContext')
      ? body.personalContext
      : existing.personalContext,
  });
  const id = crypto.randomUUID();
  const now = nowJst();
  const json = JSON.stringify(value);

  await c.env.DB
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, 'faq_bot', ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(id, body.accountId, json, now, now, json, now)
    .run();

  return c.json({ success: true, data: value });
});

export { faqs };
