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
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** embedding モデル (`ai.run(embedModel,{text})`) の戻り: data[0] が埋め込みベクトル (B-4 T-D2)。 */
  data?: number[][];
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
    private readonly embedModelId?: string | undefined,
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
      ...(opts?.responseFormat
        ? {
          response_format: {
            type: 'json_schema',
            json_schema: opts.responseFormat.schema,
          },
        }
        : {}),
    });

    const u = res.usage;
    const usage =
      u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
        ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
        : undefined;

    const text = typeof res.response === 'string'
      ? res.response
      : res.response == null
        ? ''
        : JSON.stringify(res.response);
    return { text, usage };
  }

  async embed(text: string): Promise<number[]> {
    // embedModelId は env.AI_EMBED_MODEL_ID を注入 (literal 焼き込みなし / 地雷 B4-2)。未設定 → 送らず
    // LlmConfigError で fail-safe (呼び手が faqs-only=B-3 挙動へ graceful degrade)。
    const model = (this.embedModelId ?? '').trim();
    if (!model) {
      throw new LlmConfigError('AI_EMBED_MODEL_ID is not configured');
    }
    const res = await this.ai.run(model, { text });
    const vector = res.data?.[0];
    if (!vector || vector.length === 0) {
      throw new LlmConfigError('embed() returned no vector');
    }
    return vector;
  }
}
