import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  sendTestMessages,
  getTestRecipients,
  TEST_SEND_SOURCES,
  TestSendError,
  type TestSendMessageInput,
  type TestSendSource,
} from '../services/test-send.js';
import { buildMessage } from '../services/broadcast.js';
import { resolveSenderForBroadcast } from '@line-crm/db';

const testSends = new Hono<Env>();
const MESSAGE_TYPES = new Set(['text', 'image', 'flex', 'video', 'audio', 'sticker', 'imagemap', 'richvideo']);

function isTestSendSource(value: string): value is TestSendSource {
  return (TEST_SEND_SOURCES as readonly string[]).includes(value);
}

function parsePayload(value: unknown): {
  accountId: string;
  source: TestSendSource;
  messages: TestSendMessageInput[];
  idempotencyKey: string;
  senderPresetId?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) return null;
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 128) return null;
  if (typeof body.source !== 'string' || !(TEST_SEND_SOURCES as readonly string[]).includes(body.source)) return null;
  if (body.senderPresetId !== undefined) {
    if (body.source !== 'broadcast' || typeof body.senderPresetId !== 'string' || body.senderPresetId.length === 0) return null;
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 5) return null;

  const messages: TestSendMessageInput[] = [];
  for (const value of body.messages) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = value as Record<string, unknown>;
    if (typeof message.type !== 'string' || !MESSAGE_TYPES.has(message.type)) return null;
    if (typeof message.content !== 'string' || message.content.length === 0) return null;
    if (message.altText !== undefined && typeof message.altText !== 'string') return null;
    // Reject malformed JSON/media/Flex before recipient lookup, cap claim or
    // any LINE call. Per-recipient rendering still happens later.
    try {
      buildMessage(
        message.type,
        message.content,
        typeof message.altText === 'string' ? message.altText : undefined,
      );
    } catch {
      return null;
    }
    messages.push({
      type: message.type,
      content: message.content,
      ...(typeof message.altText === 'string' ? { altText: message.altText } : {}),
    });
  }
  return {
    accountId: body.accountId,
    source: body.source as TestSendSource,
    messages,
    idempotencyKey: body.idempotencyKey,
    ...(typeof body.senderPresetId === 'string' ? { senderPresetId: body.senderPresetId } : {}),
  };
}

// Read-only recipient preview lives under the same source-scoped permission as
// its composer. Changing the setting remains under broadcast_settings.
testSends.get('/api/test-sends/:source/recipients', async (c) => {
  const source = c.req.param('source');
  const accountId = c.req.query('accountId');
  if (!isTestSendSource(source) || !accountId) {
    return c.json({ success: false, error: 'Valid source and accountId required' }, 400);
  }
  try {
    const recipients = await getTestRecipients(
      c.env.DB,
      accountId,
      c.env.TEST_SEND_ALLOWED_USER_IDS,
    );
    return c.json({
      success: true,
      data: recipients.map((friend) => ({
        id: friend.id,
        displayName: friend.display_name,
        pictureUrl: friend.picture_url,
      })),
    });
  } catch (error) {
    if (error instanceof TestSendError) {
      return c.json({ success: false, error: error.message }, error.status === 404 ? 404 : 400);
    }
    console.error('GET /api/test-sends/:source/recipients error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

testSends.post('/api/test-sends/:source', async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  const body = parsePayload(json);
  if (!body) return c.json({ success: false, error: 'Invalid test-send payload' }, 400);
  // The path is evaluated by permissionMiddleware before this handler. Pin it
  // to the body so a caller cannot obtain (for example) scenario permission
  // and then relabel a template-pack operation after authorization.
  if (c.req.param('source') !== body.source) {
    return c.json({ success: false, error: 'Test-send source does not match route' }, 400);
  }

  try {
    const sender = body.senderPresetId
      ? await resolveSenderForBroadcast(c.env.DB, body.senderPresetId, body.accountId)
      : undefined;
    if (body.senderPresetId && !sender) {
      return c.json({ success: false, error: '指定された送信者プリセットがこのLINEアカウントにありません' }, 400);
    }
    const result = await sendTestMessages({
      db: c.env.DB,
      accountId: body.accountId,
      source: body.source,
      messages: body.messages,
      idempotencyKey: body.idempotencyKey,
      workerUrl: c.env.WORKER_URL,
      allowedUserIds: c.env.TEST_SEND_ALLOWED_USER_IDS,
      sender,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof TestSendError) {
      if (error.status === 429) {
        return c.json({ success: false, error: error.message, capBlocked: true, cap: error.cap }, 429);
      }
      if (error.status === 404) return c.json({ success: false, error: error.message }, 404);
      if (error.status === 409) return c.json({ success: false, error: error.message }, 409);
      if (error.status === 400) return c.json({ success: false, error: error.message }, 400);
    }
    console.error('POST /api/test-sends error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { testSends };
