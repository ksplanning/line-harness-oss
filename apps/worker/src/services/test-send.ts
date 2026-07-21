import { LineClient, type Message, type MessageSender } from '@line-crm/line-sdk';
import { buildMessage } from './broadcast.js';
import { checkMonthlyCap, type CapCheck } from './monthly-cap.js';
import { renderFriendMessageContent } from './render-message.js';
import { expandVariables, messageToLogPayload } from './step-delivery.js';

export const TEST_SEND_SOURCES = [
  'broadcast',
  'greeting',
  'entry_greeting',
  'scenario',
  'template_pack',
  'reminder',
] as const;

export type TestSendSource = typeof TEST_SEND_SOURCES[number];

/**
 * Deployment-controlled safety boundary. The account setting chooses a subset
 * of these LINE userIds; it cannot expand this server-side allowlist.
 */
export const DEFAULT_TEST_SEND_ALLOWED_USER_IDS = [
  'U5217ceb4debd9849959446ce8f902a27',
] as const;

export interface TestSendMessageInput {
  type: string;
  content: string;
  altText?: string;
}

export interface TestRecipient {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  user_id: string | null;
  ref_code: string | null;
  metadata: string | null;
}

interface TestSendAccount {
  channel_access_token: string;
  liff_id: string | null;
}

export interface TestSendResult {
  sent: number;
  failed: number;
  sentUserIds: string[];
  deduplicated?: boolean;
}

export class TestSendError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 | 500,
    readonly cap?: CapCheck,
  ) {
    super(message);
    this.name = 'TestSendError';
  }
}

function parseConfiguredFriendIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  } catch {
    return [];
  }
}

function serverAllowedUserIds(configured: string | undefined): Set<string> {
  const values = configured === undefined
    ? [...DEFAULT_TEST_SEND_ALLOWED_USER_IDS]
    : configured.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  return new Set(values);
}

export async function getTestRecipients(
  db: D1Database,
  accountId: string,
  configuredAllowedUserIds?: string,
): Promise<TestRecipient[]> {
  const setting = await db.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`,
  ).bind(accountId).first<{ value: string }>();
  const friendIds = parseConfiguredFriendIds(setting?.value);
  if (friendIds.length === 0) return [];

  const placeholders = friendIds.map(() => '?').join(',');
  const result = await db.prepare(
    `SELECT id, line_user_id, display_name, picture_url, user_id, ref_code, metadata
     FROM friends
     WHERE line_account_id = ? AND is_following = 1 AND id IN (${placeholders})`,
  ).bind(accountId, ...friendIds).all<TestRecipient>();
  if (result.results.length !== friendIds.length) {
    throw new TestSendError('テスト送信先の設定に、このLINEアカウントでは送信できない友だちが含まれています', 400);
  }
  const byId = new Map(result.results.map((friend) => [friend.id, friend]));
  const recipients = friendIds.flatMap((id) => {
    const friend = byId.get(id);
    return friend ? [friend] : [];
  });
  const allowedUserIds = serverAllowedUserIds(configuredAllowedUserIds);
  const blockedUserIds = [...new Set(
    recipients
      .map((friend) => friend.line_user_id)
      .filter((userId) => !allowedUserIds.has(userId)),
  )];
  if (blockedUserIds.length > 0) {
    throw new TestSendError(
      `テスト送信先にサーバー許可リスト外のuserIdが含まれています: ${blockedUserIds.join(', ')}`,
      400,
    );
  }
  return recipients;
}

async function renderMessagesForFriend(
  db: D1Database,
  friend: TestRecipient,
  account: TestSendAccount,
  messages: readonly TestSendMessageInput[],
  workerUrl?: string,
  sender?: MessageSender,
): Promise<Message[]> {
  const rendered: Message[] = [];
  for (const input of messages) {
    const legacyExpanded = expandVariables(input.content, friend, workerUrl);
    const recipientExpanded = await renderFriendMessageContent(
      legacyExpanded,
      account.liff_id,
      db,
      friend,
    );
    const labeled = input.type === 'text'
      ? `【テスト配信】\n${recipientExpanded}`
      : recipientExpanded;
    rendered.push(buildMessage(input.type, labeled, input.altText, sender));
  }
  return rendered;
}

function logPayload(messages: readonly Message[]): { messageType: string; content: string } {
  if (messages.length === 1) return messageToLogPayload(messages[0]);
  const payloads = messages.map(messageToLogPayload);
  return {
    messageType: payloads[0]?.messageType ?? 'text',
    content: JSON.stringify(payloads),
  };
}

interface ExistingTestSendRequest {
  line_account_id: string;
  source: string;
  request_payload: string;
  status: string;
  response_json: string | null;
}

async function completedOrInFlightRequest(
  db: D1Database,
  idempotencyKey: string,
  accountId: string,
  source: TestSendSource,
  requestPayload: string,
): Promise<TestSendResult | null> {
  const existing = await db.prepare(
    `SELECT line_account_id, source, request_payload, status, response_json
     FROM test_send_requests WHERE idempotency_key = ?`,
  ).bind(idempotencyKey).first<ExistingTestSendRequest>();
  if (!existing) return null;
  if (
    existing.line_account_id !== accountId
    || existing.source !== source
    || existing.request_payload !== requestPayload
  ) {
    throw new TestSendError('同じ操作キーを別のテスト送信に再利用できません', 409);
  }
  if (existing.status === 'completed' && existing.response_json) {
    const cached = JSON.parse(existing.response_json) as {
      sent: number;
      failed: number;
      sentUserIds?: unknown;
    };
    return {
      sent: cached.sent,
      failed: cached.failed,
      sentUserIds: Array.isArray(cached.sentUserIds)
        ? cached.sentUserIds.filter((userId): userId is string => typeof userId === 'string')
        : [],
      deduplicated: true,
    };
  }
  throw new TestSendError('同じテスト送信を処理中です', 409);
}

export async function sendTestMessages(input: {
  db: D1Database;
  accountId: string;
  source: TestSendSource;
  messages: readonly TestSendMessageInput[];
  idempotencyKey: string;
  workerUrl?: string;
  /** Comma/whitespace separated deployment binding; undefined uses the safe current default. */
  allowedUserIds?: string;
  /** Server-resolved only. Public routes never accept a raw LINE sender object. */
  sender?: MessageSender;
}): Promise<TestSendResult> {
  const requestPayload = JSON.stringify({
    accountId: input.accountId,
    source: input.source,
    messages: input.messages,
    sender: input.sender ?? null,
  });
  // A completed operation is authoritative even if settings or the monthly
  // cap changed afterward. Returning it before validation preserves true
  // idempotency while the later atomic INSERT still wins concurrent races.
  const replay = await completedOrInFlightRequest(
    input.db,
    input.idempotencyKey,
    input.accountId,
    input.source,
    requestPayload,
  );
  if (replay) return replay;

  const account = await input.db.prepare(
    `SELECT channel_access_token, liff_id FROM line_accounts WHERE id = ? AND is_active = 1`,
  ).bind(input.accountId).first<TestSendAccount>();
  if (!account) throw new TestSendError('LINE account not found or inactive', 404);

  const recipients = await getTestRecipients(input.db, input.accountId, input.allowedUserIds);
  if (recipients.length === 0) {
    throw new TestSendError('テスト送信先を先に設定してください', 400);
  }

  const cap = await checkMonthlyCap(input.db, input.accountId, recipients.length);
  if (!cap.allowed) throw new TestSendError('今月の送信上限に達しています', 429, cap);

  const claimedAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const claim = await input.db.prepare(
    `INSERT OR IGNORE INTO test_send_requests
       (idempotency_key, line_account_id, source, request_payload, status, created_at)
     VALUES (?, ?, ?, ?, 'processing', ?)`,
  ).bind(input.idempotencyKey, input.accountId, input.source, requestPayload, claimedAt).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const concurrent = await completedOrInFlightRequest(
      input.db,
      input.idempotencyKey,
      input.accountId,
      input.source,
      requestPayload,
    );
    if (concurrent) return concurrent;
    throw new TestSendError('同じテスト送信を処理中です', 409);
  }

  const lineClient = new LineClient(account.channel_access_token);
  let sent = 0;
  let failed = 0;
  const sentUserIds: string[] = [];
  for (const friend of recipients) {
    let messages: Message[];
    try {
      messages = await renderMessagesForFriend(
        input.db,
        friend,
        account,
        input.messages,
        input.workerUrl,
        input.sender,
      );
      await lineClient.pushMessage(friend.line_user_id, messages);
      sent++;
      sentUserIds.push(friend.line_user_id);
    } catch (error) {
      console.error(`Test send to ${friend.id} failed:`, error);
      failed++;
      continue;
    }

    try {
      const payload = logPayload(messages);
      const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
      await input.db.prepare(
        `INSERT INTO messages_log
           (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'test', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        friend.id,
        payload.messageType,
        payload.content,
        'test',
        input.accountId,
        now,
      ).run();
    } catch (error) {
      // LINE already accepted the push. Keep the result physically honest and
      // surface the logging failure separately instead of claiming send failure.
      console.error(`Test send log for ${friend.id} failed after LINE push:`, error);
    }
  }
  const result = { sent, failed, sentUserIds };
  const completedAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  await input.db.prepare(
    `UPDATE test_send_requests
     SET status = 'completed', response_json = ?, completed_at = ?
     WHERE idempotency_key = ? AND status = 'processing'`,
  ).bind(JSON.stringify(result), completedAt, input.idempotencyKey).run();
  return result;
}
