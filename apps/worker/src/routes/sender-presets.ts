import { Hono } from 'hono';
import {
  listSenderPresets,
  createSenderPreset,
  getSenderPresetById,
  updateSenderPreset,
  deleteSenderPreset,
  type SenderPreset,
} from '@line-crm/db';
import type { Env } from '../index.js';

const senderPresets = new Hono<Env>();

const NAME_MAX = 20; // LINE sender.name の最大文字数

/**
 * sender_presets は account-scoped (line_account_id NOT NULL)。GET/POST/PATCH/DELETE の 4 verb で
 * accountId を必須にし、read/write を getSenderPresetById / listSenderPresets / update / delete の
 * すべてで line_account_id = accountId に絞る。→ 別 account のプリセットは一覧に出ず、id を知って
 * いても取得/編集/削除できない (getSenderPresetById が account-scoped で null → 404 = 存在も伏せる /
 * cross-account 漏洩ゼロ・batch4 R1 教訓)。accountId 欠落は 400 (fail-closed)。
 */

function serialize(p: SenderPreset) {
  return { id: p.id, accountId: p.line_account_id, name: p.name, iconUrl: p.icon_url, createdAt: p.created_at };
}

/**
 * なりすまし防止の値検証 (T-C6 正典・server が正典で client は UX 補助):
 *   - name: 必須・20 文字以内 (LINE 仕様)
 *   - iconUrl: 任意・指定時は https + 許可ドメイン (自 app の R2 media/ 配信ホスト or
 *     ALLOWED_ICON_DOMAINS env のホスト)。任意の外部 URL を送信者アイコンに使わせない。
 * OK なら null、不正なら日本語エラー文字列。
 */
function validatePresetInput(
  name: string | undefined,
  iconUrl: string | null | undefined,
  env: { WORKER_URL?: string; ALLOWED_ICON_DOMAINS?: string },
  nameRequired: boolean,
): string | null {
  if (nameRequired || name !== undefined) {
    const n = (name ?? '').trim();
    if (!n) return '送信者の名前を入力してください';
    if (n.length > NAME_MAX) return `送信者の名前は${NAME_MAX}文字以内で入力してください`;
  }
  if (iconUrl !== undefined && iconUrl !== null && iconUrl !== '') {
    if (typeof iconUrl !== 'string' || !/^https:\/\/\S+/.test(iconUrl)) {
      return 'アイコン画像URLは https で指定してください';
    }
    let host: string;
    try {
      host = new URL(iconUrl).host;
    } catch {
      return 'アイコン画像URLの形式が正しくありません';
    }
    const allowed = new Set<string>();
    try {
      if (env.WORKER_URL) allowed.add(new URL(env.WORKER_URL).host);
    } catch {
      /* ignore malformed WORKER_URL */
    }
    for (const d of (env.ALLOWED_ICON_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      allowed.add(d);
    }
    // 許可ホストが設定されている場合のみ enforce (設定不在時は https のみ = fail-open を避け configで締める)。
    if (allowed.size > 0 && !allowed.has(host)) {
      return 'アイコン画像はアップロード済みの画像URLを使ってください';
    }
  }
  return null;
}

function iconEnv(c: { env: unknown }) {
  const e = c.env as { WORKER_URL?: string; ALLOWED_ICON_DOMAINS?: string };
  return { WORKER_URL: e.WORKER_URL, ALLOWED_ICON_DOMAINS: e.ALLOWED_ICON_DOMAINS };
}

// GET /api/sender-presets?accountId= — 自 account の送信者プリセット一覧。
senderPresets.get('/api/sender-presets', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const items = await listSenderPresets(c.env.DB, accountId);
  return c.json({ success: true, data: items.map(serialize) });
});

// POST /api/sender-presets?accountId= — { name, iconUrl? }
senderPresets.post('/api/sender-presets', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const body = await c.req.json<{ name?: string; iconUrl?: string | null }>();
  const err = validatePresetInput(body.name, body.iconUrl, iconEnv(c), true);
  if (err) return c.json({ success: false, error: err }, 400);
  const created = await createSenderPreset(c.env.DB, {
    accountId,
    name: (body.name ?? '').trim(),
    iconUrl: body.iconUrl ? body.iconUrl.trim() : null,
  });
  return c.json({ success: true, data: serialize(created) }, 201);
});

// PATCH /api/sender-presets/:id?accountId= — { name?, iconUrl? }
senderPresets.patch('/api/sender-presets/:id', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  // account-scoped 取得: 別 account の id は null → 404 (存在も伏せる)。
  const existing = await getSenderPresetById(c.env.DB, id, accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ name?: string; iconUrl?: string | null }>();
  const err = validatePresetInput(body.name, body.iconUrl, iconEnv(c), false);
  if (err) return c.json({ success: false, error: err }, 400);
  const updated = await updateSenderPreset(c.env.DB, id, accountId, {
    name: body.name !== undefined ? body.name.trim() : undefined,
    iconUrl: body.iconUrl !== undefined ? (body.iconUrl ? body.iconUrl.trim() : null) : undefined,
  });
  return c.json({ success: true, data: updated ? serialize(updated) : null });
});

// DELETE /api/sender-presets/:id?accountId=
senderPresets.delete('/api/sender-presets/:id', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const existing = await getSenderPresetById(c.env.DB, id, accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  await deleteSenderPreset(c.env.DB, id, accountId);
  return c.json({ success: true, data: null });
});

export { senderPresets };
