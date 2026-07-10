import { type LlmProvider } from './llm-provider.js';
import { WorkersAiProvider, type WorkersAiBinding } from './workers-ai.js';
import { type VectorizeIndex } from '../vectorize.js';

/**
 * FAQ AI 後段の runtime 設定 (provider + env 由来の閾値/上限/係数)。
 * 呼び手 (faq-reply.tryFaqReply) には本 runtime を additive 引数で渡す。
 * null = AI 後段を組まない (env.AI binding 未設定 = infra 工程前の dark-ship default)。
 */
export interface FaqAiRuntime {
  provider: LlmProvider;
  /** 暫定 Retrieval の採否下限 (< threshold 0.6)。topScore < floor → 根拠なし即エスカレーション。 */
  retrievalFloor: number;
  /** generate の timeout(ms)。超過 → 判別不能=退避。 */
  timeoutMs: number;
  /** token→neuron 換算係数 (モデル別・literal 焼き込みなし=env 差替)。 */
  neuronPerMTokIn: number;
  neuronPerMTokOut: number;
  /** Cloudflare 共有無料枠の合算上限 (全 account 合算 neuron/日)。 */
  dailyNeuronBudgetGlobal: number;
  /** 当該 account の neuron/日 上限。 */
  dailyNeuronBudgetPerAccount: number;
  // ── B-4 (chunks live RAG) additive。null/未設定なら chunk 検索を組まず faqs-only=B-3 挙動へ degrade。──
  /** Vectorize index binding (env.VECTORIZE)。未設定 → chunk 検索しない。 */
  vectorize?: VectorizeIndex | null;
  /** embedding モデル ID (env.AI_EMBED_MODEL_ID)。literal 焼き込みなし (地雷 B4-2)。 */
  embedModelId?: string;
  /** chunk 採用下限 = 正規化 cosine [0,1] (bm25 単独採用禁止 / 地雷 B4-1)。 */
  chunkRelevanceFloor?: number;
  /** embed の token→neuron 換算係数 (無料枠合算ガード用)。 */
  embedNeuronPerMTok?: number;
}

/** createFaqAiRuntime が読む env の最小 shape (worker Env の部分集合)。 */
export interface FaqAiEnv {
  AI?: WorkersAiBinding;
  AI_MODEL_ID?: string;
  AI_RETRIEVAL_FLOOR?: string;
  AI_TIMEOUT_MS?: string;
  AI_NEURON_PER_MTOK_IN?: string;
  AI_NEURON_PER_MTOK_OUT?: string;
  AI_DAILY_NEURON_BUDGET_GLOBAL?: string;
  AI_DAILY_NEURON_BUDGET_PER_ACCOUNT?: string;
  // B-4 additive (未設定 = chunk 検索を組まない dark-ship/dev degrade)。
  VECTORIZE?: VectorizeIndex;
  AI_EMBED_MODEL_ID?: string;
  AI_CHUNK_RELEVANCE_FLOOR?: string;
  AI_EMBED_NEURON_PER_MTOK?: string;
}

// 運用 default (env 未設定時の fail-safe fallback)。MODEL_ID は含めない (literal 焼き込み禁止)。
// budget は無料枠 10,000 neurons/日 に安全マージンを引いた値 (fail-closed = 枯渇前に退避)。
const DEFAULT_RETRIEVAL_FLOOR = 0.3;
const DEFAULT_TIMEOUT_MS = 8000;
// §2-3b の係数 (8B 級目安・neurons per 1M tokens)。実モデルの実測で infra が [vars] 上書き。
const DEFAULT_NEURON_PER_MTOK_IN = 4119;
const DEFAULT_NEURON_PER_MTOK_OUT = 34868;
const DEFAULT_DAILY_NEURON_BUDGET_GLOBAL = 9000;
const DEFAULT_DAILY_NEURON_BUDGET_PER_ACCOUNT = 9000;
// B-4: chunk 採用の正規化 cosine [0,1] 下限 (env で実測校正)。faq の Dice floor (0.3) とは別尺度・別値。
export const DEFAULT_CHUNK_RELEVANCE_FLOOR = 0.6;
// B-4: embed の neuron/1M token 係数 (fail-safe 高め見積・infra が実測で [vars] 上書き)。
export const DEFAULT_EMBED_NEURON_PER_MTOK = 3000;

function numFromEnv(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * env から FaqAiRuntime を組む (inject 1 点)。
 * env.AI binding が無ければ null (AI 後段を一切組まない = dark-ship default)。
 * AI_MODEL_ID の literal フォールバックは持たない (未設定は WorkersAiProvider.generate が
 * LlmConfigError で fail-safe)。floor/budget/係数は env 優先・安全 default fallback。
 */
export function createFaqAiRuntime(env: FaqAiEnv): FaqAiRuntime | null {
  if (!env.AI) return null;
  return {
    provider: new WorkersAiProvider(env.AI, env.AI_MODEL_ID, env.AI_EMBED_MODEL_ID),
    retrievalFloor: numFromEnv(env.AI_RETRIEVAL_FLOOR, DEFAULT_RETRIEVAL_FLOOR),
    timeoutMs: numFromEnv(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    neuronPerMTokIn: numFromEnv(env.AI_NEURON_PER_MTOK_IN, DEFAULT_NEURON_PER_MTOK_IN),
    neuronPerMTokOut: numFromEnv(env.AI_NEURON_PER_MTOK_OUT, DEFAULT_NEURON_PER_MTOK_OUT),
    dailyNeuronBudgetGlobal: numFromEnv(env.AI_DAILY_NEURON_BUDGET_GLOBAL, DEFAULT_DAILY_NEURON_BUDGET_GLOBAL),
    dailyNeuronBudgetPerAccount: numFromEnv(
      env.AI_DAILY_NEURON_BUDGET_PER_ACCOUNT,
      DEFAULT_DAILY_NEURON_BUDGET_PER_ACCOUNT,
    ),
    // B-4: env.VECTORIZE 未設定なら null = chunk 検索を組まない (faqs-only=B-3 挙動へ degrade)。
    // embedModelId の literal フォールバックは持たない (未設定は WorkersAiProvider.embed が LlmConfigError)。
    vectorize: env.VECTORIZE ?? null,
    embedModelId: env.AI_EMBED_MODEL_ID,
    chunkRelevanceFloor: numFromEnv(env.AI_CHUNK_RELEVANCE_FLOOR, DEFAULT_CHUNK_RELEVANCE_FLOOR),
    embedNeuronPerMTok: numFromEnv(env.AI_EMBED_NEURON_PER_MTOK, DEFAULT_EMBED_NEURON_PER_MTOK),
  };
}
