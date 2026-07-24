import {
  countRecentFaqReplies,
  getActiveFaqsForMatch,
  incrementFaqHitCount,
  insertAiFaqDraft,
  jstNow,
  recordUnmatchedQuestion,
  type Faq,
} from '@line-crm/db';
import { buildMessage } from './step-delivery.js';
import { matchFaqDetailed, type MatchableFaq } from './faq-match.js';
import { retrieveAndRankFaq } from './faq-fts.js';
import { runFaqAiAnswer, type AnswerMode } from './faq-ai.js';
import { type FaqAiRuntime } from './llm/runtime.js';
import {
  EMPTY_REPLY_STYLE,
  normalizeReplyStyleSettings,
  type ReplyStyleSettings,
} from './reply-style.js';

interface FaqBotSettings {
  enabled: boolean;
  threshold: number;
  handoffMessage: string;
  autoReplyNotice: string;
  maxRepliesPerDay: number;
  answerMode: AnswerMode;
  replyStyle: ReplyStyleSettings;
}

const DEFAULT_SETTINGS: FaqBotSettings = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
  answerMode: 'draft',
  replyStyle: EMPTY_REPLY_STYLE,
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
      answerMode: parsed.answerMode === 'auto' || parsed.answerMode === 'draft'
        ? parsed.answerMode
        : DEFAULT_SETTINGS.answerMode,
      replyStyle: normalizeReplyStyleSettings(parsed.replyStyle),
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
    if (settings.answerMode === 'draft') {
      await insertAiFaqDraft(db, {
        lineAccountId: opts.lineAccountId,
        friendId: opts.friend.id,
        question: opts.incomingText,
        draftAnswer: detail.match.faq.answer,
        evidenceFaqIds: [detail.match.faq.id],
      });
      await incrementFaqHitCount(db, detail.match.faq.id);
      return { replied: false, handoff: false };
    }

    const answer = `${detail.match.faq.answer}${settings.autoReplyNotice ? `\n${settings.autoReplyNotice}` : ''}`;
    await lineClient.replyMessage(opts.replyToken, [buildMessage('text', answer)]);
    await incrementFaqHitCount(db, detail.match.faq.id);
    await logFaqOutgoing(db, opts.friend.id, 'faq_bot', answer);
    return { replied: true, handoff: false };
  }

  // Phase B: AI 後段 (match=null 時のみ・provider 注入時のみ)。webhook.ts:722 の
  // FAQ_BOT_ENABLED gate が閉なら tryFaqReply 自体到達しない (dark-ship)。
  if (ai?.provider && detail.match === null) {
    // Phase B B-2: 暫定検索 (Dice-over-all の detail.best) の「供給元」を FTS5 recall + Dice 再ランク
    // に差し替える (§3-3)。runFaqAiAnswer 本体・floor/grounding/escalate は byte-identical。
    // 検索スコア下限 (ai.retrievalFloor) は撤廃せず保持 (FTS 候補ありでも Dice<floor は退避 / FATAL 修正)。
    const aiDetail = await retrieveAndRankFaq(db, opts.incomingText, opts.lineAccountId);
    const outcome = await runFaqAiAnswer(
      db,
      aiDetail,
      {
        question: opts.incomingText,
        answerMode: settings.answerMode,
        lineAccountId: opts.lineAccountId,
        friendId: opts.friend.id,
        overLimit,
        replyStyle: settings.replyStyle,
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

  if (settings.answerMode === 'draft') {
    return { replied: false, handoff: false };
  }

  if (settings.handoffMessage) {
    await lineClient.replyMessage(opts.replyToken, [buildMessage('text', settings.handoffMessage)]);
    await logFaqOutgoing(db, opts.friend.id, 'faq_handoff', settings.handoffMessage);
    return { replied: false, handoff: true };
  }

  return { replied: false, handoff: false };
}
