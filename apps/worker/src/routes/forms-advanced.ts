import { Hono, type Context } from 'hono';
import {
  createFormalooForm,
  listFormalooForms,
  getFormalooForm,
  saveFormalooDefinition,
  updateFormalooBuilderStatus,
  softDeleteFormalooForm,
  setFormalooSyncState,
  getFormalooSyncState,
  queryFormalooSubmissions,
  getFormalooSubmission,
  listFormalooSavedFilters,
  createFormalooSavedFilter,
  deleteFormalooSavedFilter,
  formalooSubmissionsDailyCounts,
  bulkDeleteFormalooSubmissions,
  setFormalooGsheetState,
  getFormalooFieldMap,
  type FormalooForm,
  type FormalooSubmissionRow,
} from '@line-crm/db';
import {
  validateHarnessField,
  toCsv,
  parseCsv,
  type HarnessField,
  type HarnessLogicRule,
} from '@line-crm/shared';
import {
  canTransition,
  buildPublicUrl,
  buildEmbedCode,
  buildScriptEmbedCode,
  isBuilderStatus,
  type BuilderStatus,
} from '../services/formaloo-publish-gate.js';
import { resolveFormalooClient } from '../services/formaloo-client.js';
import { pushDefinitionToFormaloo } from '../services/formaloo-sync.js';
import { pullDefinitionFromFormaloo } from '../services/formaloo-pull.js';
import type { Env } from '../index.js';

// =============================================================================
// /api/forms-advanced — Formaloo-backed 高機能フォーム (F-2 / G19 再定義)
// -----------------------------------------------------------------------------
// permissionMiddleware が forms_advanced feature で全 route を gate (permission-map / landmine#4)。
// native forms (/api/forms) は無改変で併存 (D-1)。SoT: D1=表示キャッシュ+台帳、Formaloo=定義の権威。
// 誤配信防止 (N-7): draft/in_review では公開/埋め込み URL を発行しない (publish gate)。
// =============================================================================

export const formsAdvanced = new Hono<Env>();

interface StoredDefinition {
  fields: HarnessField[];
  logic: HarnessLogicRule[];
  formalooAddress?: string | null;
}

function parseDefinition(json: string): StoredDefinition {
  try {
    const d = JSON.parse(json) as Partial<StoredDefinition>;
    return {
      fields: Array.isArray(d.fields) ? d.fields : [],
      logic: Array.isArray(d.logic) ? d.logic : [],
      formalooAddress: typeof d.formalooAddress === 'string' ? d.formalooAddress : null,
    };
  } catch {
    return { fields: [], logic: [], formalooAddress: null };
  }
}

async function serializeForm(db: D1Database, form: FormalooForm) {
  const def = parseDefinition(form.definition_json);
  const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
  const sync = await getFormalooSyncState(db, form.id);
  const publicUrl = buildPublicUrl(status, def.formalooAddress ?? null);
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    formalooSlug: form.formaloo_slug,
    builderStatus: status,
    publishedAt: form.published_at,
    submitCount: form.submit_count,
    onSubmitTagId: form.on_submit_tag_id,
    onSubmitScenarioId: form.on_submit_scenario_id,
    submitMessage: form.submit_message,
    fields: def.fields,
    logic: def.logic,
    // N-7: publish 前は null (公開/埋め込み URL 発行不可)
    publicUrl,
    embedCode: buildEmbedCode(status, def.formalooAddress ?? null, { title: form.title }),
    syncStatus: sync?.sync_status ?? 'idle',
    syncError: sync?.last_error ?? null,
    updatedAt: form.updated_at,
  };
}

// GET /api/forms-advanced — 一覧
formsAdvanced.get('/api/forms-advanced', async (c) => {
  try {
    const list = await listFormalooForms(c.env.DB);
    const data = await Promise.all(list.map((f) => serializeForm(c.env.DB, f)));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/forms-advanced error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced — 新規 draft 作成
formsAdvanced.post('/api/forms-advanced', async (c) => {
  try {
    const body = await c.req
      .json<{ title?: string; description?: string | null; onSubmitTagId?: string | null; onSubmitScenarioId?: string | null; submitMessage?: string | null }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.title || !body.title.trim()) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    const form = await createFormalooForm(c.env.DB, {
      title: body.title.trim(),
      description: body.description ?? null,
      onSubmitTagId: body.onSubmitTagId ?? null,
      onSubmitScenarioId: body.onSubmitScenarioId ?? null,
      submitMessage: body.submitMessage ?? null,
    });
    return c.json({ success: true, data: await serializeForm(c.env.DB, form) }, 201);
  } catch (err) {
    console.error('POST /api/forms-advanced error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id — 詳細 (fields + logic + publish 状態)
formsAdvanced.get('/api/forms-advanced/:id', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id')!);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    return c.json({ success: true, data: await serializeForm(c.env.DB, form) });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/forms-advanced/:id — 定義保存 (validate → 永続化 → fail-soft push-sync)
formsAdvanced.put('/api/forms-advanced/:id', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req
      .json<{ fields?: unknown[]; logic?: unknown[] }>()
      .catch(() => ({}) as { fields?: unknown[]; logic?: unknown[] });
    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const rawLogic = Array.isArray(body.logic) ? body.logic : [];

    // field を MVP subset で検証 (M-21 明示 reject)。1 つでも不正なら 400。
    const fields: HarnessField[] = [];
    for (let i = 0; i < rawFields.length; i++) {
      const r = validateHarnessField({ ...(rawFields[i] as object), position: (rawFields[i] as { position?: number }).position ?? i });
      if (!r.ok) return c.json({ success: false, error: `フィールド ${i + 1}: ${r.error}` }, 400);
      fields.push(r.field);
    }
    // logic は既存 field id を参照する rule だけ残す (孤立参照防止 / N-11)
    const fieldIds = new Set(fields.map((f) => f.id));
    const logic: HarnessLogicRule[] = (rawLogic as HarnessLogicRule[]).filter(
      (r) => r && fieldIds.has(r.sourceFieldId) && fieldIds.has(r.targetFieldId),
    );

    const prevDef = parseDefinition(form.definition_json);
    // まず D1 に保存 (SoT キャッシュ / fail-soft の土台)
    const definitionJson = JSON.stringify({ fields, logic, formalooAddress: prevDef.formalooAddress ?? null });
    await saveFormalooDefinition(c.env.DB, id, {
      definitionJson,
      fields: fields.map((f) => ({ id: f.id, fieldType: f.type, label: f.label, position: f.position, configJson: JSON.stringify(f.config) })),
    });

    // Formaloo へ push (fail-soft): secret 未配備 (dev) や失敗は out_of_sync でローカル保存を維持
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (!client) {
      await setFormalooSyncState(c.env.DB, id, { syncStatus: 'out_of_sync', lastError: 'Formaloo credentials 未設定 (S-1 待ち)' });
    } else {
      const pushed = await pushDefinitionToFormaloo(client, { formalooSlug: form.formaloo_slug, title: form.title, fields, logic });
      if (pushed.ok) {
        // slug + address を反映
        const merged = JSON.stringify({ fields, logic, formalooAddress: pushed.publicAddress ?? prevDef.formalooAddress ?? null });
        await saveFormalooDefinition(c.env.DB, id, {
          definitionJson: merged,
          fields: fields.map((f) => ({ id: f.id, formalooFieldSlug: pushed.fieldSlugs?.[f.id] ?? null, fieldType: f.type, label: f.label, position: f.position, configJson: JSON.stringify(f.config) })),
          formalooSlug: pushed.formalooSlug ?? null,
        });
        await setFormalooSyncState(c.env.DB, id, { syncStatus: 'idle', lastError: null, lastPushedAt: new Date().toISOString() });
      } else {
        await setFormalooSyncState(c.env.DB, id, { syncStatus: 'out_of_sync', lastError: pushed.error ?? 'push failed' });
      }
    }

    const updated = await getFormalooForm(c.env.DB, id);
    return c.json({ success: true, data: await serializeForm(c.env.DB, updated!) });
  } catch (err) {
    console.error('PUT /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/pull — Formaloo から定義を再取り込み (N-8 / 非破壊プレビュー)
//   Formaloo = 定義の権威 (§4)。運用者が Formaloo 管理画面で直接編集したフォームを builder に読み戻す。
//   D1 は書き換えない (setFormalooSyncState/saveFormalooDefinition は呼ばない) = builder state 反映のみ。
//   永続化は運用者が既存 PUT で「保存」。response.data.ok は「editor に適用してよいか」の判別子:
//   frontend は ok===true の時だけ state を置換し、ok:false は note のみ表示する (B2 = editor を潰さない)。
//   client 未配備 (dev) / formaloo_slug 無 / pull 失敗は fail-soft (ok:false + note + 200 / 500 にしない)。
formsAdvanced.get('/api/forms-advanced/:id/pull', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (!client) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: 'Formaloo 未接続のため再取り込みできません（S-1 待ち）' } });
    }
    if (!form.formaloo_slug) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: 'このフォームはまだ Formaloo に未同期です（先に保存してください）' } });
    }

    // slug → harness id の resolver を D1 field_map から組む (書込みなし = read のみ)。
    const map = await getFormalooFieldMap(c.env.DB, id);
    const bySlug = new Map<string, string>();
    for (const row of map) {
      if (row.formaloo_field_slug) bySlug.set(row.formaloo_field_slug, row.id);
    }
    const r = await pullDefinitionFromFormaloo(client, {
      formalooSlug: form.formaloo_slug,
      resolveId: (s) => bySlug.get(s) ?? s, // 既知 slug → 既存 id / 未知 → slug 自身 (fromFormalooField の fallback と整合)
    });
    if (!r.ok) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: `再取り込みに失敗しました（${r.error}）` } });
    }
    return c.json({
      success: true,
      data: {
        ok: true,
        fields: r.fields,
        logic: r.logic,
        note: 'Formaloo から再取り込みしました。内容を確認して「保存」してください（⚠️保存すると Formaloo に項目が重複作成される場合があります）',
      },
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/pull error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 状態遷移の共通ハンドラ (publish gate)。 */
async function transition(c: Context<Env>, to: BuilderStatus, notAllowedMsg: string) {
  const id = c.req.param('id')!;
  const form = await getFormalooForm(c.env.DB, id);
  if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  const from = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
  if (!canTransition(from, to)) {
    return c.json({ success: false, error: notAllowedMsg }, 409);
  }
  await updateFormalooBuilderStatus(c.env.DB, id, to);
  const updated = await getFormalooForm(c.env.DB, id);
  return c.json({ success: true, data: await serializeForm(c.env.DB, updated!) });
}

// POST /api/forms-advanced/:id/submit-for-review — draft → in_review
formsAdvanced.post('/api/forms-advanced/:id/submit-for-review', async (c) =>
  transition(c, 'in_review', 'この状態からレビュー依頼はできません'),
);

// POST /api/forms-advanced/:id/publish — in_review → published (N-7 gate: draft から直行不可)
formsAdvanced.post('/api/forms-advanced/:id/publish', async (c) =>
  transition(c, 'published', '公開の前に「レビュー依頼」で下書きを確認してください（誤配信防止）'),
);

// POST /api/forms-advanced/:id/unpublish — published → draft (URL 即無効化)
formsAdvanced.post('/api/forms-advanced/:id/unpublish', async (c) =>
  transition(c, 'draft', 'この状態から下書きに戻せません'),
);

// GET /api/forms-advanced/:id/embed — 埋め込みコード (N-7: published のみ)
formsAdvanced.get('/api/forms-advanced/:id/embed', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id')!);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const def = parseDefinition(form.definition_json);
    const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
    const embedCode = buildEmbedCode(status, def.formalooAddress ?? null, { title: form.title });
    if (!embedCode) {
      return c.json({ success: false, error: 'フォームを公開すると埋め込みコードが発行されます' }, 409);
    }
    return c.json({ success: true, data: { embedCode, publicUrl: buildPublicUrl(status, def.formalooAddress ?? null) } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/embed error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms-advanced/:id — 論理削除 (N-11 tombstone)
formsAdvanced.delete('/api/forms-advanced/:id', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    await softDeleteFormalooForm(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// F-4 データコックピット (T-D1) — 回答ミラー検索 + ドリルスルー + 保存フィルタ
//   /api/forms-advanced 配下 = permission-map で forms_advanced feature に自動 gate (landmine#4)。
//   回答は TRINA 顧客 PII を含み得る (N-9) — 外部送信しない。CSV export / 一括削除は commit 6 (owner gated)。
// =============================================================================

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function serializeSubmissionRow(row: FormalooSubmissionRow) {
  return {
    id: row.id,
    friendId: row.friend_id,
    answers: safeParseJson(row.answers_json),
    submittedAt: row.submitted_at,
    verified: row.verified === 1,
  };
}

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// GET /api/forms-advanced/:id/rows — D1 ミラーの検索/フィルタ/ソート/ページング
formsAdvanced.get('/api/forms-advanced/:id/rows', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const page = Math.max(1, parseIntSafe(c.req.query('page'), 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseIntSafe(c.req.query('pageSize'), DEFAULT_PAGE_SIZE)));
    const { rows, total } = await queryFormalooSubmissions(c.env.DB, {
      formId: id,
      q: c.req.query('q') ?? null,
      from: c.req.query('from') ?? null,
      to: c.req.query('to') ?? null,
      sortDir: c.req.query('sort') === 'asc' ? 'asc' : 'desc',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return c.json({ success: true, data: { rows: rows.map(serializeSubmissionRow), total, page, pageSize } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/rows/:rowId — Formaloo rows API ドリルスルー (fail-soft = mirror / N-6)
formsAdvanced.get('/api/forms-advanced/:id/rows/:rowId', async (c) => {
  try {
    const id = c.req.param('id')!;
    const rowId = c.req.param('rowId')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const mirror = await getFormalooSubmission(c.env.DB, rowId);
    if (!mirror || mirror.form_id !== id) return c.json({ success: false, error: '回答が見つかりません' }, 404);

    // Formaloo 側の最新をドリルスルー。client 未配備 (dev) / 失敗は mirror を返す (fail-soft)。
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (client && form.formaloo_slug) {
      const r = await client.get<{ data?: unknown }>(`/v3.0/forms/${form.formaloo_slug}/rows/${rowId}/`);
      if (r.ok) {
        return c.json({ success: true, data: { id: rowId, answers: r.data?.data ?? safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'formaloo' } });
      }
    }
    return c.json({ success: true, data: { id: rowId, answers: safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'mirror' } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows/:rowId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/filters — 保存フィルタ一覧
formsAdvanced.get('/api/forms-advanced/:id/filters', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const list = await listFormalooSavedFilters(c.env.DB, id);
    return c.json({ success: true, data: list.map((f) => ({ id: f.id, name: f.name, filter: safeParseJson(f.filter_json) })) });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/filters error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/filters — 保存フィルタ作成
formsAdvanced.post('/api/forms-advanced/:id/filters', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; filter?: unknown }>().catch(() => ({}) as { name?: string; filter?: unknown });
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ success: false, error: '名前を入力してください' }, 400);
    const created = await createFormalooSavedFilter(c.env.DB, { formId: id, name, filterJson: JSON.stringify(body.filter ?? {}) });
    return c.json({ success: true, data: { id: created.id, name: created.name, filter: safeParseJson(created.filter_json) } }, 201);
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/filters error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms-advanced/:id/filters/:filterId — 保存フィルタ削除 (form scope に閉じる)
formsAdvanced.delete('/api/forms-advanced/:id/filters/:filterId', async (c) => {
  try {
    const id = c.req.param('id')!;
    await deleteFormalooSavedFilter(c.env.DB, id, c.req.param('filterId')!);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms-advanced/:id/filters/:filterId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// F-4 データコックピット (T-D2) — 統計 + CSV 出し入れ + 一括削除
//   統計/検索は forms_advanced 権限で足りる。CSV export / import / 一括削除は PII 露出/破壊操作のため
//   owner gated (N-9 / 権限なし staff→middleware 403・非 owner staff→ownerGate 403)。
//   本番ランタイム上限を静的 cap で符号化 (Workers CPU/subrequest 保護 / 地雷#2)。
// =============================================================================

const MAX_EXPORT_ROWS = 50_000;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5_000;
const MAX_BULK_DELETE = 1_000;

/** N-9: 個人情報の書き出し/破壊操作は owner のみ。非 owner は 403。 */
function ownerGate(c: Context<Env>): Response | null {
  const staff = c.get('staff');
  if (!staff || staff.role !== 'owner') {
    return c.json({ success: false, error: 'この操作にはオーナー権限が必要です（個人情報保護）' }, 403);
  }
  return null;
}

// GET /api/forms-advanced/:id/stats — 統計 (ローカル集計 + Formaloo stats drill fail-soft)
formsAdvanced.get('/api/forms-advanced/:id/stats', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const { total } = await queryFormalooSubmissions(c.env.DB, { formId: id, limit: 1, offset: 0 });
    const daily = await formalooSubmissionsDailyCounts(c.env.DB, id);
    const verifiedRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE form_id = ? AND verified = 1').bind(id).first<{ n: number }>();

    // Formaloo 側 stats を drill (fail-soft): client 未配備/失敗は null。
    let formaloo: unknown = null;
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (client && form.formaloo_slug) {
      const r = await client.get<{ data?: unknown }>(`/v3.0/forms/${form.formaloo_slug}/stats/`);
      if (r.ok) formaloo = r.data?.data ?? null;
    }
    return c.json({ success: true, data: { total, verified: verifiedRow?.n ?? 0, daily, formaloo } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/export.csv — 回答 CSV 書き出し (owner gated / N-9)
formsAdvanced.get('/api/forms-advanced/:id/export.csv', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const { rows, total } = await queryFormalooSubmissions(c.env.DB, { formId: id, sortDir: 'asc', limit: MAX_EXPORT_ROWS, offset: 0 });
    if (total > MAX_EXPORT_ROWS) {
      return c.json({ success: false, error: `件数が多すぎます（上限 ${MAX_EXPORT_ROWS} 件）。期間で絞ってからお試しください。` }, 400);
    }
    // answer key の union を列にする (フォームごとに回答項目が異なるため)。
    const parsed = rows.map((r) => (safeParseJson(r.answers_json) as Record<string, unknown>) ?? {});
    const keys = [...new Set(parsed.flatMap((a) => Object.keys(a)))].sort();
    const header = ['回答ID', 'friend_id', '送信日時', ...keys];
    const csvRows = rows.map((r, i) => [
      r.id,
      r.friend_id ?? '',
      r.submitted_at,
      ...keys.map((k) => {
        const v = parsed[i][k];
        return Array.isArray(v) ? v.join(', ') : v ?? '';
      }),
    ]);
    const csv = toCsv(header, csvRows);
    if (new TextEncoder().encode(csv).length > MAX_EXPORT_BYTES) {
      return c.json({ success: false, error: 'データ量が大きすぎて一度に出力できません。期間で絞ってお試しください。' }, 413);
    }
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`formaloo_${id}.csv`)}`,
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/export.csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/import — CSV 取り込み (owner gated)。SoT: Formaloo import-rows へ push し、
//   webhook 経由でミラーに反映 (ミラーへ直接書き込まない)。dev/未配備は pushed=false で fail-soft。
formsAdvanced.post('/api/forms-advanced/:id/import', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req.json<{ csv?: string }>().catch(() => ({}) as { csv?: string });
    const csv = typeof body.csv === 'string' ? body.csv : '';
    const parsedRows = parseCsv(csv);
    if (parsedRows.length === 0) return c.json({ success: false, error: 'CSV が空です' }, 400);
    const dataRows = parsedRows.slice(1); // 先頭 header を除く
    if (dataRows.length > MAX_IMPORT_ROWS) {
      return c.json({ success: false, error: `一度に取り込めるのは ${MAX_IMPORT_ROWS} 行までです。分割してお試しください。` }, 400);
    }

    let pushed = false;
    let note = 'Formaloo 認証情報が未設定のため取り込みは保留しました（CSV は検証済み・S-1 で本番反映）';
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (client && form.formaloo_slug) {
      const r = await client.post(`/v3.0/forms/${form.formaloo_slug}/import-rows/`, { header: parsedRows[0], rows: dataRows });
      pushed = r.ok;
      note = r.ok ? '取り込みました（Formaloo 反映後、回答一覧に順次表示されます）' : `取り込みに失敗しました（HTTP ${r.status}）`;
    }
    return c.json({ success: true, data: { parsed: dataRows.length, pushed, note } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/import error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/rows/bulk-delete — 回答一括削除 (owner gated / N-9)
formsAdvanced.post('/api/forms-advanced/:id/rows/bulk-delete', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ success: false, error: '削除する回答を選択してください' }, 400);
    if (ids.length > MAX_BULK_DELETE) return c.json({ success: false, error: `一度に削除できるのは ${MAX_BULK_DELETE} 件までです` }, 400);

    const deleted = await bulkDeleteFormalooSubmissions(c.env.DB, id, ids);
    // Formaloo 側でも削除 (fail-soft): 失敗してもミラー削除は確定させる。
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (client && form.formaloo_slug) {
      try {
        await client.post(`/v3.0/forms/${form.formaloo_slug}/rows/bulk-delete/`, { rows: ids });
      } catch (e) {
        console.error('formaloo bulk-delete push failed (fail-soft):', e);
      }
    }
    return c.json({ success: true, data: { deleted } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/rows/bulk-delete error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// F-5 T-E1 — HP 埋め込みコード提示 + Google Sheets 連携 UI トリガ
//   埋め込みコード (iframe/script) は published のみ発行 (T-B3 publish gate に接続 / N-7)。
//   Sheets 連携は PII を外部 Sheet へ出すため owner gated (N-9)。tier 制約は live 未確定 → fail-soft (G-7)。
// =============================================================================

// GET /api/forms-advanced/:id/share — 公開 URL + 埋め込みコード (iframe/script) + Sheets 状態
formsAdvanced.get('/api/forms-advanced/:id/share', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const def = parseDefinition(form.definition_json);
    const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
    const addr = def.formalooAddress ?? null;
    return c.json({
      success: true,
      data: {
        published: status === 'published',
        publicUrl: buildPublicUrl(status, addr),
        // N-7: draft/in_review は埋め込みコードを発行しない (null)
        iframeCode: buildEmbedCode(status, addr, { title: form.title }),
        scriptCode: buildScriptEmbedCode(status, addr),
        gsheetConnected: form.gsheet_connected === 1,
        gsheetUrl: form.gsheet_url,
      },
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/share error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/gsheet/connect — Google Sheets 連携トリガ (owner gated / fail-soft)
formsAdvanced.post('/api/forms-advanced/:id/gsheet/connect', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    let connected = false;
    let gsheetUrl: string | null = null;
    let note = 'Formaloo 認証情報が未設定のため連携できませんでした（S-1 で本番連携）';
    // F6-1: 多鍵 resolver。workspaceId=null = env 単一鍵 fallback = 既存挙動 byte-equivalent
    // (form.workspace_id 列は F6-2 / migration 095 まで無い → dark-ship 安全 [FIX-4])。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, null);
    if (client && form.formaloo_slug) {
      const r = await client.post<{ data?: { gsheet_url?: string; url?: string } }>(`/v3.0/forms/${form.formaloo_slug}/regenerate-gsheet-data/`, {});
      if (r.ok) {
        connected = true;
        gsheetUrl = r.data?.data?.gsheet_url ?? r.data?.data?.url ?? null;
        note = 'Google スプレッドシートと連携しました（回答が同期されます）';
      } else {
        // tier 制約等の失敗は owner に案内 (G-7 / fail-soft)
        note = `連携に失敗しました（HTTP ${r.status}）。プランのシート連携可否・接続設定をご確認ください。`;
      }
    }
    await setFormalooGsheetState(c.env.DB, id, { connected, url: gsheetUrl });
    return c.json({ success: true, data: { connected, gsheetUrl, note } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/gsheet/connect error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
