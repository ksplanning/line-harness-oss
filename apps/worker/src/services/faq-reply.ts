import {
  countRecentFaqReplies,
  getActiveFaqsForMatch,
  incrementFaqHitCount,
  jstNow,
  recordUnmatchedQuestion,
  type Faq,
} from '@line-crm/db';
import { buildMessage } from './step-delivery.js';
import { matchFaqDetailed, type MatchableFaq } from './faq-match.js';
import { runFaqAiAnswer, type AnswerMode } from './faq-ai.js';
import { type FaqAiRuntime } from './llm/runtime.js';

interface FaqBotSettings {
  enabled: boolean;
  threshold: number;
  handoffMessage: string;
  autoReplyNotice: string;
  maxRepliesPerDay: number;
  answerMode: AnswerMode;
}

const DEFAULT_SETTINGS: FaqBotSettings = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
  answerMode: 'auto',
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
      answerMode: parsed.answerMode === 'draft' ? 'draft' : DEFAULT_SETTINGS.answerMode,
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

// reviewer R1-I2: 24h 上限カウントは packages/db の countRecentFaqReplies に移設。
// SQL は julianday() 比較 (JST 文字列 created_at と 'now' の TZ 差で窓判定が歪むのを回避)。
// 実 SQLite 境界テストは packages/db/src/faqs.test.ts。

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
  ai?: FaqAiRuntime | null,
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

  // Phase B: AI 後段 (match=null 時のみ・provider 注入時のみ)。webhook.ts:722 の
  // FAQ_BOT_ENABLED gate が閉なら tryFaqReply 自体到達しない (dark-ship)。
  if (ai?.provider && detail.match === null) {
    const outcome = await runFaqAiAnswer(
      db,
      detail,
      {
        question: opts.incomingText,
        answerMode: settings.answerMode,
        lineAccountId: opts.lineAccountId,
        friendId: opts.friend.id,
        overLimit,
      },
      ai,
    );
    if (outcome.kind === 'auto_send') {
      const answer = `${outcome.answer}${settings.autoReplyNotice ? `\n${settings.autoReplyNotice}` : ''}`;
      await lineClient.replyMessage(opts.replyToken, [buildMessage('text', answer)]);
      await logFaqOutgoing(db, opts.friend.id, 'faq_bot', answer);
      return { replied: true, handoff: false };
    }
    if (outcome.kind === 'draft_saved') {
      return { replied: false, handoff: false };
    }
    // escalate → 既存の recordUnmatchedQuestion 経路へ落ちる (単一 record 地点)。
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
