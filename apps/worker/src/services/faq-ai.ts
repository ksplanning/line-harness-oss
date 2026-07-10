import { insertAiFaqDraft } from '@line-crm/db';
import { type FaqMatchDetail } from './faq-match.js';
import { type FaqAiRuntime } from './llm/runtime.js';
import { type LlmPrompt } from './llm/llm-provider.js';

export type AnswerMode = 'auto' | 'draft';

/** LLM が根拠だけでは答えられない時に出力させる sentinel (「分からない」判定に使う)。 */
export const FAQ_AI_UNKNOWN_SENTINEL = '__NO_ANSWER__';

// system 指示 (上位固定・根拠より上位)。根拠外の情報を作らせない = 注入耐性 + hallucination 抑制。
const SYSTEM_PROMPT = [
  'あなたは店舗の FAQ 応答アシスタントです。',
  '以下の「根拠」に書かれている情報だけを使って、日本語で簡潔に答えてください。',
  '根拠に無い URL・電話番号・固有名詞・数値を新しく作ってはいけません。',
  `根拠だけでは答えられない場合は、正確に ${FAQ_AI_UNKNOWN_SENTINEL} とだけ出力してください。`,
].join('\n');

export interface FaqEvidence {
  question: string;
  answer: string;
}

/**
 * プロンプト構成 (D-2)。system 指示(上位) + 根拠 FAQ(データ領域) + ユーザー質問 のみ。
 * friend_id / account_id / token 等の秘密値・内部識別子は一切載せない。
 */
export function buildFaqPrompt(evidence: FaqEvidence, question: string): LlmPrompt {
  const user = ['根拠:', `Q: ${evidence.question}`, `A: ${evidence.answer}`, '---', `質問: ${question}`].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

/** LLM が「分からない」= sentinel を含む / 空。 */
export function detectNoAnswer(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  return t.includes(FAQ_AI_UNKNOWN_SENTINEL);
}

const URL_RE = /https?:\/\/[^\s<>"'）」]+/gi;
// 日本の電話番号 (0 始まり・ハイフン/括弧許容)。
const PHONE_RE = /0\d{1,4}[-（(]?\d{1,4}[-）)]?\d{3,4}/g;

/** 回答テキストから URL と電話番号を抽出する。 */
export function extractUrlsAndPhones(text: string): string[] {
  return [...(text.match(URL_RE) ?? []), ...(text.match(PHONE_RE) ?? [])];
}

/**
 * 生成回答が根拠に無い URL/電話番号を新規導入していないか (肯定的検証・注入耐性の下地)。
 * 回答内の各 URL/電話が根拠テキストに現れなければ false (= 送らない)。
 */
export function validateAnswerGrounding(answer: string, evidenceText: string): boolean {
  for (const token of extractUrlsAndPhones(answer)) {
    if (!evidenceText.includes(token)) return false;
  }
  return true;
}

export type FaqAiOutcome =
  | { kind: 'auto_send'; answer: string }
  | { kind: 'draft_saved' }
  | { kind: 'escalate'; reason: string };

export interface RunFaqAiInput {
  question: string;
  answerMode: AnswerMode;
  lineAccountId: string | null;
  friendId: string | null;
  /** friend 別 maxRepliesPerDay 超過 (pre-flight OR の片側)。ai_usage_budget 判定は C6 で結線。 */
  overLimit: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('llm_timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e as Error); },
    );
  });
}

/**
 * AI 後段 (detail.match == null 時のみ・FAQ_BOT_ENABLED=false で dark-ship)。
 * pre-flight → 暫定 Retrieval floor → 生成(timeout) → 根拠妥当性 → answer_mode 分岐。
 * 実 replyMessage / recordUnmatchedQuestion は呼び手 (tryFaqReply) が outcome を見て行う。
 */
export async function runFaqAiAnswer(
  db: D1Database,
  detail: FaqMatchDetail,
  input: RunFaqAiInput,
  ai: FaqAiRuntime,
): Promise<FaqAiOutcome> {
  // [pre-flight] friend 別上限超過 → 生成せず退避 (無駄 neuron ゼロ)。
  if (input.overLimit) {
    return { kind: 'escalate', reason: 'over_reply_limit' };
  }

  // [暫定 Retrieval] floor 未満 or 根拠なし → エスカレーション。
  const evidence = detail.best?.faq;
  if (detail.topScore == null || evidence == null || detail.topScore < ai.retrievalFloor) {
    return { kind: 'escalate', reason: 'below_retrieval_floor' };
  }

  const ev: FaqEvidence = { question: evidence.question, answer: evidence.answer };
  const prompt = buildFaqPrompt(ev, input.question);

  // [生成] timeout 付き。timeout/例外 → 判別不能=退避 (no-retry / no-send)。
  let result;
  try {
    result = await withTimeout(ai.provider.generate(prompt, { maxTokens: 512, temperature: 0.2 }), ai.timeoutMs);
  } catch (err) {
    // 秘密値/friend_id を載せない。エラー名のみ。
    console.error('FAQ AI generate failed:', err instanceof Error ? err.name : 'unknown');
    return { kind: 'escalate', reason: 'generate_error' };
  }

  // [根拠妥当性] (ii) 分からない / (iii) usage 欠損 / (iv) 根拠外 URL・電話。
  if (detectNoAnswer(result.text)) {
    return { kind: 'escalate', reason: 'no_answer' };
  }
  if (!result.usage) {
    return { kind: 'escalate', reason: 'usage_missing' };
  }
  if (!validateAnswerGrounding(result.text, `${ev.question}\n${ev.answer}`)) {
    return { kind: 'escalate', reason: 'ungrounded_contact' };
  }

  const answer = result.text.trim();

  // [根拠あり] answer_mode 分岐。
  if (input.answerMode === 'draft') {
    await insertAiFaqDraft(db, {
      lineAccountId: input.lineAccountId,
      friendId: input.friendId,
      question: input.question,
      draftAnswer: answer,
      evidenceFaqIds: [evidence.id],
    });
    return { kind: 'draft_saved' };
  }
  return { kind: 'auto_send', answer };
}
