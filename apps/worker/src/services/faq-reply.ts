import {
  getActiveFaqsForMatch,
  incrementFaqHitCount,
  jstNow,
  recordUnmatchedQuestion,
  type Faq,
} from '@line-crm/db';
import { buildMessage } from './step-delivery.js';
import { matchFaqDetailed, type MatchableFaq } from './faq-match.js';

interface FaqBotSettings {
  enabled: boolean;
  threshold: number;
  handoffMessage: string;
  autoReplyNotice: string;
  maxRepliesPerDay: number;
}

const DEFAULT_SETTINGS: FaqBotSettings = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
};

export interface TryFaqReplyOptions {
  friend: { id: string; line_account_id: string | null };
  incomingText: string;
  lineAccountId: string | null;
  replyToken: string;
}

export interface TryFaqReplyResult {
  replied: boolean;
  handoff: boolean;
}

type ReplyClient = {
  replyMessage(replyToken: string, messages: unknown[]): Promise<unknown>;
};

function parseSettings(value: string | null | undefined): FaqBotSettings {
  if (!value) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(value) as Partial<FaqBotSettings>;
    return {
      enabled: parsed.enabled === true,
      threshold: typeof parsed.threshold === 'number' ? parsed.threshold : DEFAULT_SETTINGS.threshold,
      handoffMessage: typeof parsed.handoffMessage === 'string' ? parsed.handoffMessage : DEFAULT_SETTINGS.handoffMessage,
      autoReplyNotice: typeof parsed.autoReplyNotice === 'string' ? parsed.autoReplyNotice : DEFAULT_SETTINGS.autoReplyNotice,
      maxRepliesPerDay: typeof parsed.maxRepliesPerDay === 'number' ? parsed.maxRepliesPerDay : DEFAULT_SETTINGS.maxRepliesPerDay,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function getFaqBotSettings(db: D1Database, lineAccountId: string | null): Promise<FaqBotSettings> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`)
    .bind(lineAccountId)
    .first<{ value: string }>();
  return parseSettings(row?.value);
}

async function countRecentFaqReplies(db: D1Database, friendId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages_log
       WHERE friend_id = ?
         AND direction = 'outgoing'
         AND source = 'faq_bot'
         AND delivery_type = 'reply'
         AND created_at >= datetime('now', '-24 hours')`,
    )
    .bind(friendId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function logFaqOutgoing(
  db: D1Database,
  friendId: string,
  source: 'faq_bot' | 'faq_handoff',
  content: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', '${source}', ?)`,
    )
    .bind(crypto.randomUUID(), friendId, 'text', content, jstNow())
    .run();
}

function toMatchableFaqs(faqs: Faq[]): MatchableFaq[] {
  return faqs.map((faq) => ({
    ...faq,
    variants: (() => {
      try {
        const parsed = JSON.parse(faq.variants) as unknown;
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
      } catch {
        return [];
      }
    })(),
  }));
}

export async function tryFaqReply(
  db: D1Database,
  lineClient: ReplyClient,
  opts: TryFaqReplyOptions,
): Promise<TryFaqReplyResult> {
  const settings = await getFaqBotSettings(db, opts.lineAccountId);
  if (settings.enabled !== true) {
    return { replied: false, handoff: false };
  }

  const recentReplyCount = await countRecentFaqReplies(db, opts.friend.id);
  const overLimit = recentReplyCount >= settings.maxRepliesPerDay;
  const faqs = toMatchableFaqs(await getActiveFaqsForMatch(db, opts.lineAccountId));
  const detail = matchFaqDetailed(opts.incomingText, faqs, settings.threshold);

  if (detail.match && !overLimit) {
    const answer = `${detail.match.faq.answer}${settings.autoReplyNotice ? `\n${settings.autoReplyNotice}` : ''}`;
    await lineClient.replyMessage(opts.replyToken, [buildMessage('text', answer)]);
    await incrementFaqHitCount(db, detail.match.faq.id);
    await logFaqOutgoing(db, opts.friend.id, 'faq_bot', answer);
    return { replied: true, handoff: false };
  }

  await recordUnmatchedQuestion(db, {
    lineAccountId: opts.lineAccountId,
    friendId: opts.friend.id,
    question: opts.incomingText,
    topScore: detail.topScore,
  });

  if (settings.handoffMessage) {
    await lineClient.replyMessage(opts.replyToken, [buildMessage('text', settings.handoffMessage)]);
    await logFaqOutgoing(db, opts.friend.id, 'faq_handoff', settings.handoffMessage);
    return { replied: false, handoff: true };
  }

  return { replied: false, handoff: false };
}
