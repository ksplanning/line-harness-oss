import { Hono } from 'hono';
import {
  isActiveFormalooWorkspace,
  listFormalooAccountBindings,
  upsertFormalooAccountBinding,
  clearFormalooAccountBinding,
} from '@line-crm/db';
import { FormalooClient } from '../services/formaloo-client.js';
import { encryptSecret, formalooFieldAad } from '../services/formaloo-crypto.js';
import { ownerGate } from '../lib/owner-gate.js';
import type { Env } from '../index.js';

// =============================================================================
// /api/formaloo-workspaces — Formaloo workspace の API キー設定管理 (F6-1 / 本柱①)
// -----------------------------------------------------------------------------
// owner が複数 Formaloo workspace の鍵 (KEY/SECRET) を UI から登録・切替 (enable/disable)・疎通テストする。
// 鍵は D1 に **平文で置かない** — AES-256-GCM envelope 暗号化 (KEK=FORMALOO_KEK worker secret) で暗号文だけ保存。
//
// セキュリティ契約 (Codex gap #5/#6):
//   - **GET を含む全 route が owner-only** (共有 ownerGate)。permission-middleware は built-in role を
//     全許可する非対称 fail-closed ゆえ、built-in admin/staff でも非 owner は ownerGate が 403 で締める。
//   - permission-map は custom role 導線用に forms_advanced feature で gate (map + ownerGate の二重)。
//   - KEY/SECRET は保存後 API で返さない (write-only / M-8)。一覧に暗号文も載せない。
//   - 疎通テストは保存前に GET /v3.0/forms/ 200 を確認 (誤鍵早期検知)。平文鍵は request スコープのみ。
//   - **エラーは汎用化**: Formaloo 応答本文・入力鍵を echo せず・console に平文/KEK を出さない (N-15)。
// =============================================================================

export const formalooWorkspaces = new Hono<Env>();

const OWNER_MSG = 'この操作にはオーナー権限が必要です（APIキー管理）';
const GENERIC_CONN_ERROR = '接続に失敗しました。APIキー・シークレットをご確認ください。';

// 入力 whitelist の上限 (M-21 / 過大入力の防御)。
const MAX_LABEL = 100;
const MAX_KEY = 500;
const MAX_SECRET = 4000;
const MAX_BUSINESS_SLUG = 200;

interface WorkspaceListRow {
  id: string;
  label: string;
  business_slug: string | null;
  is_active: number;
}

/** 一覧 serialize: 暗号文・KEY/SECRET を **絶対に載せない** (write-only / M-8)。 */
function serializeWorkspace(row: WorkspaceListRow) {
  return {
    id: row.id,
    label: row.label,
    businessSlug: row.business_slug,
    isActive: row.is_active === 1,
  };
}

type AddInput =
  | { ok: true; label: string; key: string; secret: string; businessSlug: string | null }
  | { ok: false; error: string };

/** M-21: label/KEY/SECRET を明示 whitelist で検証。不正値は generic メッセージで弾く (鍵を echo しない)。 */
function validateAddInput(body: Record<string, unknown>): AddInput {
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  const businessSlug = typeof body.businessSlug === 'string' ? body.businessSlug.trim() : '';
  if (!label) return { ok: false, error: 'ラベルを入力してください' };
  if (label.length > MAX_LABEL) return { ok: false, error: 'ラベルが長すぎます' };
  if (!key) return { ok: false, error: 'APIキーを入力してください' };
  if (!secret) return { ok: false, error: 'APIシークレットを入力してください' };
  if (key.length > MAX_KEY || secret.length > MAX_SECRET || businessSlug.length > MAX_BUSINESS_SLUG) {
    return { ok: false, error: '入力値が長すぎます' };
  }
  return { ok: true, label, key, secret, businessSlug: businessSlug || null };
}

/**
 * 入力鍵で Formaloo に疎通確認 (誤鍵早期検知)。FormalooClient は fail-soft (throw しない) ゆえ ok を返す。
 * 平文鍵は request 変数スコープのみ・Formaloo 応答本文は返さない (呼び出し側で generic 化)。
 *
 * **isolated cache 必須** (reviewer I1): FormalooClient の default は module-level token cache (apiKey キー /
 * TTL 30秒)。共有 cache を使うと、同 apiKey のトークンが既に cache 済みの窓では **getToken が oauth を
 * skip し、誤った apiSecret でも 200 になり誤鍵が保存される** 穴が開く。疎通テストは apiSecret を必ず
 * oauth で検証する必要があるため、専用の空 cache を渡して毎回 fresh 認証させる (共有 cache も汚さない)。
 */
async function testConnection(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const client = new FormalooClient({ apiKey, apiSecret, cache: new Map() });
    const r = await client.get('/v3.0/forms/?page_size=1');
    return r.ok;
  } catch {
    return false;
  }
}

// GET /api/formaloo-workspaces — 一覧 (owner only / 非 owner に business_slug を見せない)
formalooWorkspaces.get('/api/formaloo-workspaces', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, label, business_slug, is_active FROM formaloo_workspaces ORDER BY created_at DESC`,
    ).all<WorkspaceListRow>();
    return c.json({ success: true, data: results.map(serializeWorkspace) });
  } catch {
    console.error('GET /api/formaloo-workspaces error'); // 秘密を含めない
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/formaloo-workspaces/test — 疎通テスト (dry-run / 保存しない / owner only)
formalooWorkspaces.post('/api/formaloo-workspaces/test', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  if (!key || !secret) return c.json({ success: false, error: 'APIキー・シークレットを入力してください' }, 400);
  if (key.length > MAX_KEY || secret.length > MAX_SECRET) {
    return c.json({ success: false, error: '入力値が長すぎます' }, 400);
  }
  const ok = await testConnection(key, secret);
  // ok=false でも 200 (テスト結果として返す)。Formaloo 応答本文・入力鍵は返さない (generic)。
  return c.json({ success: true, data: { ok } });
});

// POST /api/formaloo-workspaces — 追加 (疎通テスト → 暗号化 → D1 保存 / owner only)
formalooWorkspaces.post('/api/formaloo-workspaces', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const v = validateAddInput(body);
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);
  // KEK 未投入 (S-1 前) では暗号化保存できない。平文は保持しない。
  if (!c.env.FORMALOO_KEK) {
    return c.json({ success: false, error: 'サーバーの暗号化設定が未完了です（管理者にお問い合わせください）' }, 503);
  }
  // 誤鍵早期検知: 保存前に疎通確認。失敗は generic error (鍵・応答本文を echo しない / Codex gap #5)。
  const ok = await testConnection(v.key, v.secret);
  if (!ok) return c.json({ success: false, error: GENERIC_CONN_ERROR }, 400);
  try {
    const id = `fw_${crypto.randomUUID()}`;
    const kc = await encryptSecret(c.env.FORMALOO_KEK, v.key, formalooFieldAad(id, 'key'));
    const sc = await encryptSecret(c.env.FORMALOO_KEK, v.secret, formalooFieldAad(id, 'secret'));
    await c.env.DB.prepare(
      `INSERT INTO formaloo_workspaces (id, label, business_slug, key_ciphertext, key_iv, secret_ciphertext, secret_iv)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(id, v.label, v.businessSlug, kc.ciphertext, kc.iv, sc.ciphertext, sc.iv).run();
    // 応答に KEY/SECRET/暗号文を **返さない** (write-only / M-8)。
    return c.json({ success: true, data: { id, label: v.label, businessSlug: v.businessSlug, isActive: true } }, 201);
  } catch {
    console.error('POST /api/formaloo-workspaces save error'); // 平文/KEK/応答本文を含めない (N-15)
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/formaloo-workspaces/:id — 有効化/無効化の切替 (F6-1 の「切替」= enable/disable / owner only)
formalooWorkspaces.patch('/api/formaloo-workspaces/:id', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const id = c.req.param('id')!;
  const body = await c.req.json<{ isActive?: unknown }>().catch(() => ({}) as { isActive?: unknown });
  if (typeof body.isActive !== 'boolean') {
    return c.json({ success: false, error: 'isActive（真偽値）を指定してください' }, 400);
  }
  try {
    const res = await c.env.DB.prepare(
      `UPDATE formaloo_workspaces SET is_active = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')) WHERE id = ?`,
    ).bind(body.isActive ? 1 : 0, id).run();
    if (!res.meta.changes) return c.json({ success: false, error: 'workspace が見つかりません' }, 404);
    return c.json({ success: true, data: { id, isActive: body.isActive } });
  } catch {
    console.error('PATCH /api/formaloo-workspaces/:id error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/formaloo-workspaces/:id — 削除 (soft-delete = is_active 0 / N-16 tombstone / owner only)
formalooWorkspaces.delete('/api/formaloo-workspaces/:id', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const id = c.req.param('id')!;
  try {
    const res = await c.env.DB.prepare(
      `UPDATE formaloo_workspaces SET is_active = 0, updated_at = (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')) WHERE id = ?`,
    ).bind(id).run();
    if (!res.meta.changes) return c.json({ success: false, error: 'workspace が見つかりません' }, 404);
    return c.json({ success: true, data: null });
  } catch {
    console.error('DELETE /api/formaloo-workspaces/:id error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// /api/formaloo-account-bindings — アカウント→既定 workspace の binding (F6-2 / 作成先の既定解決)
// -----------------------------------------------------------------------------
// owner-only (共有 ownerGate = built-in admin/staff も非 owner は 403 / Codex gap #6)。
// permission-map は formaloo-workspaces と同じ forms_advanced feature で gate (custom role 導線用)。
// 用途: ①作成 UI の workspace セレクタ既定 ②POST /api/forms-advanced で明示 workspace 無しのときの server 既定解決。
// default_workspace_id は **登録済 active workspace のみ** 受理 (無効値で binding を書かない / 参照整合性 M-4)。
// =============================================================================

// GET /api/formaloo-account-bindings — 一覧 (owner only)
formalooWorkspaces.get('/api/formaloo-account-bindings', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  try {
    const list = await listFormalooAccountBindings(c.env.DB);
    return c.json({
      success: true,
      data: list.map((b) => ({ lineAccountId: b.line_account_id, defaultWorkspaceId: b.default_workspace_id })),
    });
  } catch {
    console.error('GET /api/formaloo-account-bindings error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/formaloo-account-bindings/:lineAccountId — 既定 workspace を set (active 検証 / owner only)
formalooWorkspaces.put('/api/formaloo-account-bindings/:lineAccountId', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const lineAccountId = c.req.param('lineAccountId')!;
  const body = await c.req.json<{ defaultWorkspaceId?: unknown }>().catch(() => ({}) as { defaultWorkspaceId?: unknown });
  const defaultWorkspaceId = typeof body.defaultWorkspaceId === 'string' && body.defaultWorkspaceId.trim() ? body.defaultWorkspaceId.trim() : '';
  if (!defaultWorkspaceId) {
    return c.json({ success: false, error: '既定にするワークスペースを選択してください' }, 400);
  }
  try {
    // 実在アカウントのみ (line_accounts に無い id への binding は作らない / 参照整合性)。
    const acc = await c.env.DB.prepare('SELECT 1 AS ok FROM line_accounts WHERE id = ?').bind(lineAccountId).first<{ ok: number }>();
    if (!acc) return c.json({ success: false, error: 'アカウントが見つかりません' }, 400);
    // 登録済 active workspace のみ受理 (無効値で binding を書かない / Codex M#4)。
    if (!(await isActiveFormalooWorkspace(c.env.DB, defaultWorkspaceId))) {
      return c.json({ success: false, error: '指定されたワークスペースは登録されていないか無効です' }, 400);
    }
    await upsertFormalooAccountBinding(c.env.DB, lineAccountId, defaultWorkspaceId);
    return c.json({ success: true, data: { lineAccountId, defaultWorkspaceId } });
  } catch {
    console.error('PUT /api/formaloo-account-bindings/:lineAccountId error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/formaloo-account-bindings/:lineAccountId — 既定 workspace を clear (owner only)
formalooWorkspaces.delete('/api/formaloo-account-bindings/:lineAccountId', async (c) => {
  const denied = ownerGate(c, OWNER_MSG);
  if (denied) return denied;
  const lineAccountId = c.req.param('lineAccountId')!;
  try {
    await clearFormalooAccountBinding(c.env.DB, lineAccountId);
    return c.json({ success: true, data: null });
  } catch {
    console.error('DELETE /api/formaloo-account-bindings/:lineAccountId error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
