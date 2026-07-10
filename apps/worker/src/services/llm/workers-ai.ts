import {
  type LlmProvider,
  type LlmPrompt,
  type LlmGenerateOptions,
  type LlmGenerateResult,
  LlmConfigError,
} from './llm-provider.js';

/**
 * Cloudflare Workers AI binding の最小型。@cloudflare/workers-types に `Ai` 型が無い
 * 環境でも型付けできるよう、B-1 が使う run() だけを構造的に定義する。
 * 実 binding (`[ai] binding = "AI"`) は infra 工程 (closer/デプロイ) で wrangler に追記。
 */
export interface WorkersAiRunResult {
  response?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<WorkersAiRunResult>;
}

/**
 * Workers AI (`env.AI.run(modelId, ...)`) アダプタ。
 * modelId は env.AI_MODEL_ID を注入 (literal フォールバックなし)。未設定/空 → 送信せず
 * LlmConfigError で fail-safe (呼び手が未対応インボックスへ退避)。
 */
export class WorkersAiProvider implements LlmProvider {
  constructor(
    private readonly ai: WorkersAiBinding,
    private readonly modelId: string | undefined,
  ) {}

  async generate(prompt: LlmPrompt, opts?: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const model = (this.modelId ?? '').trim();
    if (!model) {
      // literal 焼き込みなし = ここで既定モデルに落とさない。設定不備は送らない側に倒す。
      throw new LlmConfigError('AI_MODEL_ID is not configured');
    }

    const res = await this.ai.run(model, {
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      max_tokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });

    const u = res.usage;
    const usage =
      u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
        ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
        : undefined;

    return { text: res.response ?? '', usage };
  }

  async embed(_text: string): Promise<number[]> {
    // B-1 では呼び手なし (暫定 Retrieval は Phase A best FAQ)。埋め込みモデル確定は B-2/B-4。
    throw new LlmConfigError('embed() is not wired in B-1 (see B-2/B-4)');
  }
}
