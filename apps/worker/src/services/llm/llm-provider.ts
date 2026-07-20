/**
 * LLM 接続層の抽象 (Phase B B-1 / T-A1)。
 * 呼び手 (faq-reply) は本抽象のみを参照し、実体 (WorkersAiProvider / MockLlmProvider) は
 * createFaqAiRuntime factory が inject する (差替 1 点)。Workers AI が既定で、secret 設定時だけ
 * OpenAI の generate-only fallback を合成する。embed は既存 Workers AI 経路を維持する。
 */

export interface LlmPrompt {
  /** 安全指示 (上位固定)。根拠より上位・秘密値/内部識別子を載せない (D-2)。 */
  system: string;
  /** データ領域 (根拠 FAQ テキスト + ユーザー質問)。 */
  user: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmGenerateResult {
  text: string;
  /** provider がトークン数を返せない場合 undefined (呼び手は「判別不能=退避」で fail-safe)。 */
  usage?: LlmUsage;
  /** Optional generation origin for history/operations metadata; existing Workers results omit it. */
  provider?: 'workers_ai' | 'openai';
}

export interface LlmGenerateOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  generate(prompt: LlmPrompt, opts?: LlmGenerateOptions): Promise<LlmGenerateResult>;
  /** B-1 では load-bearing でない (暫定 Retrieval は Phase A best FAQ)。埋め込みは B-2/B-4。 */
  embed(text: string): Promise<number[]>;
}

/** MODEL_ID 未設定/空・その他設定不備。呼び手は「送らない=退避」で扱う (fail-closed)。 */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}
