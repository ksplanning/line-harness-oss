import { Hono } from 'hono';
import {
  getAutoReplies,
  getAutoReplyById,
  createAutoReply,
  updateAutoReply,
  deleteAutoReply,
} from '@line-crm/db';
import type { AutoReply as DbAutoReply } from '@line-crm/db';
import type { AutoReplyResponseMessage } from '@line-crm/db';
import type { Env } from '../index.js';
import { buildOutboundMessage, OUTBOUND_MESSAGE_TYPES } from '../services/outbound-message.js';

const autoReplies = new Hono<Env>();

interface EffectiveAccount {
  accountId: string;
  accountName: string;
  status: 'reply' | 'silent' | 'not_applicable';
  via: 'inline' | 'automation' | null;
}

interface SerializedAutoReply {
  id: string;
  keyword: string;
  matchType: 'exact' | 'contains';
  responseType: string;
  responseContent: string;
  responseMessages: AutoReplyResponseMessage[];
  templateId: string | null;
  lineAccountId: string | null;
  isActive: boolean;
  createdAt: string;
  effectiveAccounts?: EffectiveAccount[];
}

const AUTO_REPLY_MESSAGE_TYPES = new Set<string>(OUTBOUND_MESSAGE_TYPES);

function validateResponseMessagesShape(input: unknown): string | null {
  if (!Array.isArray(input)) return 'responseMessages は配列で指定してください';
  if (input.length < 1) return '吹き出しは1件以上、最大5件まで指定してください';
  if (input.length > 5) return '吹き出しは1件以上、最大5件までです';
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '吹き出しの形式が正しくありません';
    const message = item as Record<string, unknown>;
    if (typeof message.messageType !== 'string' || !AUTO_REPLY_MESSAGE_TYPES.has(message.messageType)) {
      return '吹き出しの種別が正しくありません';
    }
    if (typeof message.messageContent !== 'string' || message.messageContent.length === 0) {
      return '吹き出しの内容が空です';
    }
  }
  return null;
}

function validateResponseMessages(input: unknown): string | null {
  const shapeError = validateResponseMessagesShape(input);
  if (shapeError) return shapeError;
  for (const item of input as Array<Record<string, unknown>>) {
    const messageType = item.messageType as string;
    const messageContent = item.messageContent as string;
    try {
      buildOutboundMessage(messageType, messageContent);
    } catch {
      return `${messageType} の内容が正しくありません`;
    }
  }
  return null;
}

function validateSingleResponse(messageType: string, messageContent: string): string | null {
  if (messageType === 'silent') return null;
  if (!AUTO_REPLY_MESSAGE_TYPES.has(messageType)) return 'responseType が未対応です';
  if (!messageContent) return 'responseContent が空です';
  try {
    buildOutboundMessage(messageType, messageContent);
    return null;
  } catch {
    return `${messageType} の内容が正しくありません`;
  }
}

function responseMessagesFor(row: DbAutoReply): AutoReplyResponseMessage[] {
  if (row.response_messages === null) {
    if (row.response_type === 'silent') return [];
    return [{ messageType: row.response_type, messageContent: row.response_content }];
  }
  if (typeof row.response_messages !== 'string') throw new Error('response_messages must be string or null');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_messages);
  } catch {
    throw new Error('invalid response_messages JSON');
  }
  // Existing rows may predate today's stricter LINE validation. Keep their
  // envelope readable so an operator can open and repair them; every write and
  // actual send still goes through validateResponseMessages/buildOutboundMessage.
  const validationError = validateResponseMessagesShape(parsed);
  if (validationError) throw new Error(validationError);
  return parsed as AutoReplyResponseMessage[];
}

function serializeAutoReply(row: DbAutoReply): SerializedAutoReply {
  return {
    id: row.id,
    keyword: row.keyword,
    matchType: row.match_type,
    responseType: row.response_type,
    responseContent: row.response_content,
    responseMessages: responseMessagesFor(row),
    templateId: row.template_id,
    lineAccountId: row.line_account_id,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

/**
 * 全 active LINE accounts と全 active automations を一発で取って、各 auto_reply の
 * 「実際にどのアカで返信するか」を計算する。auto_reply の line_account_id が null
 * なら全アカ対象、specific なら対象 1 アカのみ。返信は inline (silent 以外) または
 * 同 keyword の automation rule (event_type='message_received') で起きる。
 */
async function computeEffectiveAccounts(
  db: D1Database,
  rule: DbAutoReply,
  accounts: Array<{ id: string; name: string }>,
  automationsByKeyword: Map<string, Set<string>>,  // keyword -> set of account_ids that have rule
): Promise<EffectiveAccount[]> {
  return accounts.map((acc) => {
    // line_account_id が specific なら対象アカ以外は適用外
    if (rule.line_account_id && rule.line_account_id !== acc.id) {
      return { accountId: acc.id, accountName: acc.name, status: 'not_applicable', via: null };
    }
    // inline 返信 (text / flex / image)
    if (rule.response_type !== 'silent') {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'inline' };
    }
    // silent: 同 keyword の automation rule が同アカに存在すれば返信、無ければ silent only
    const automationAccs = automationsByKeyword.get(rule.keyword);
    if (automationAccs?.has(acc.id)) {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'automation' };
    }
    return { accountId: acc.id, accountName: acc.name, status: 'silent', via: null };
  });
}

async function buildAutomationKeywordIndex(db: D1Database): Promise<Map<string, Set<string>>> {
  // event_type='message_received' で keyword を持ち、send_message を含む automation を全件取って
  // keyword -> set<account_id> のインデックス化。
  const res = await db
    .prepare(`SELECT line_account_id, conditions, actions FROM automations WHERE is_active = 1 AND event_type = 'message_received'`)
    .all<{ line_account_id: string | null; conditions: string; actions: string }>();
  const idx = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    if (!r.line_account_id) continue;  // global rules — skip; UI assumes per-account
    let keyword: string | null = null;
    try {
      const c = JSON.parse(r.conditions) as { keyword?: string; keyword_exact?: string };
      keyword = c.keyword ?? c.keyword_exact ?? null;
    } catch { continue; }
    if (!keyword) continue;
    // send_message action があるか
    let hasSendMessage = false;
    try {
      const acts = JSON.parse(r.actions) as Array<{ type: string }>;
      hasSendMessage = acts.some((a) => a.type === 'send_message');
    } catch { continue; }
    if (!hasSendMessage) continue;
    const set = idx.get(keyword) ?? new Set<string>();
    set.add(r.line_account_id);
    idx.set(keyword, set);
  }
  return idx;
}

// GET /api/auto-replies — list all auto-replies (optional ?accountId filter)
autoReplies.get('/api/auto-replies', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const items = await getAutoReplies(c.env.DB, accountId || undefined);

    // active LINE accounts を取得 + automations の keyword -> accounts インデックスを構築
    const accRes = await c.env.DB
      .prepare(`SELECT id, name FROM line_accounts WHERE is_active = 1 ORDER BY name`)
      .all<{ id: string; name: string }>();
    const activeAccounts = accRes.results ?? [];
    const automationIdx = await buildAutomationKeywordIndex(c.env.DB);

    const data: SerializedAutoReply[] = await Promise.all(
      items.map(async (row) => {
        const base = serializeAutoReply(row);
        base.effectiveAccounts = await computeEffectiveAccounts(c.env.DB, row, activeAccounts, automationIdx);
        return base;
      }),
    );

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/auto-replies/:id — get by ID
autoReplies.get('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getAutoReplyById(c.env.DB, id);
    if (!item) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }
    return c.json({ success: true, data: serializeAutoReply(item) });
  } catch (err) {
    console.error('GET /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/auto-replies — create
autoReplies.post('/api/auto-replies', async (c) => {
  try {
    const body = await c.req.json<{
      keyword: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      responseMessages?: unknown;
      templateId?: string | null;
      lineAccountId?: string | null;
    }>();

    if (!body.keyword) {
      return c.json({ success: false, error: 'keyword is required' }, 400);
    }
    const responseMessagesError = body.responseMessages === undefined || body.responseMessages === null
      ? null
      : validateResponseMessages(body.responseMessages);
    if (responseMessagesError) {
      return c.json({ success: false, error: responseMessagesError }, 400);
    }
    const responseMessages = Array.isArray(body.responseMessages)
      ? body.responseMessages as AutoReplyResponseMessage[]
      : body.responseMessages === null ? null : undefined;
    // template_id があれば content は空でも OK (template から resolve される)。
    // silent も content 不要。それ以外は inline content 必須。
    if (!responseMessages && !body.templateId && !body.responseContent && body.responseType !== 'silent') {
      return c.json({ success: false, error: 'templateId or responseContent required (unless responseType=silent)' }, 400);
    }

    // template_id が来てて content/type が空の場合、template の現在値を inline
    // snapshot として保存する。これがないと ON DELETE SET NULL で template_id が
    // クリアされた時に webhook resolve が空メッセージにフォールバックしてしまう。
    let resolvedResponseType = body.responseType ?? 'text';
    let resolvedResponseContent = body.responseContent ?? '';
    const firstMessage = responseMessages?.[0];
    if (firstMessage) {
      resolvedResponseType = firstMessage.messageType;
      resolvedResponseContent = firstMessage.messageContent;
    } else if (body.templateId && (!body.responseContent || !body.responseType)) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      if (tpl) {
        if (!body.responseType) resolvedResponseType = tpl.message_type;
        if (!body.responseContent) resolvedResponseContent = tpl.message_content;
      }
    }

    if (!responseMessages) {
      const singleResponseError = validateSingleResponse(resolvedResponseType, resolvedResponseContent);
      if (singleResponseError) {
        return c.json({ success: false, error: singleResponseError }, 400);
      }
    }

    const item = await createAutoReply(c.env.DB, {
      keyword: body.keyword,
      matchType: body.matchType,
      responseType: resolvedResponseType,
      responseContent: resolvedResponseContent,
      responseMessages,
      templateId: body.templateId ?? null,
      lineAccountId: body.lineAccountId ?? null,
    });

    return c.json({ success: true, data: serializeAutoReply(item) }, 201);
  } catch (err) {
    console.error('POST /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/auto-replies/:id — update
autoReplies.put('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      keyword?: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      responseMessages?: unknown;
      templateId?: string | null;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();

    const input: Record<string, unknown> = {};
    if (body.keyword !== undefined) input.keyword = body.keyword;
    if (body.matchType !== undefined) input.matchType = body.matchType;
    if (body.responseType !== undefined) input.responseType = body.responseType;
    if (body.responseContent !== undefined) input.responseContent = body.responseContent;
    if (body.responseMessages !== undefined) {
      if (body.responseMessages !== null) {
        const responseMessagesError = validateResponseMessages(body.responseMessages);
        if (responseMessagesError) return c.json({ success: false, error: responseMessagesError }, 400);
      }
      input.responseMessages = body.responseMessages;
    }
    if ('templateId' in body) input.templateId = body.templateId;
    if ('lineAccountId' in body) input.lineAccountId = body.lineAccountId;
    if (body.isActive !== undefined) input.isActive = body.isActive;

    // templateId が新たに set されて responseContent が来てない場合は template の
    // 現在値を inline snapshot として書き込む (ON DELETE SET NULL の fallback 用)。
    if (body.templateId && body.responseContent === undefined && body.responseMessages === undefined) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      if (tpl) {
        input.responseContent = tpl.message_content;
        if (body.responseType === undefined) input.responseType = tpl.message_type;
      }
    }

    const needsSingleResponseValidation = body.responseMessages === null || (
      body.responseMessages === undefined
      && (body.responseType !== undefined || body.responseContent !== undefined || body.templateId !== undefined)
    );
    if (needsSingleResponseValidation) {
      const existing = await getAutoReplyById(c.env.DB, id);
      if (!existing) return c.json({ success: false, error: 'Auto-reply not found' }, 404);
      const messageType = typeof input.responseType === 'string' ? input.responseType : existing.response_type;
      const messageContent = typeof input.responseContent === 'string' ? input.responseContent : existing.response_content;
      const singleResponseError = validateSingleResponse(messageType, messageContent);
      if (singleResponseError) return c.json({ success: false, error: singleResponseError }, 400);
    }

    const updated = await updateAutoReply(c.env.DB, id, input as Parameters<typeof updateAutoReply>[2]);

    if (!updated) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }

    return c.json({ success: true, data: serializeAutoReply(updated) });
  } catch (err) {
    console.error('PUT /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/auto-replies/:id
autoReplies.delete('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getAutoReplyById(c.env.DB, id);
    if (!item) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }
    await deleteAutoReply(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { autoReplies };
