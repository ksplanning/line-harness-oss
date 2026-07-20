import {
  type LlmGenerateOptions,
  type LlmGenerateResult,
  type LlmPrompt,
  type LlmProvider,
  LlmConfigError,
} from './llm-provider.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL_ID = 'gpt-4o-mini';

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

/** OpenAI chat-completions adapter. The API key is read only from the injected Worker secret. */
export class OpenAiProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly modelId: string | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generate(prompt: LlmPrompt, opts?: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = (this.apiKey ?? '').trim();
    if (!key) throw new LlmConfigError('OPENAI_API_KEY is not configured');

    const model = this.modelId?.trim() || DEFAULT_OPENAI_MODEL_ID;
    const response = await this.request(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_tokens: opts?.maxTokens,
        temperature: opts?.temperature,
      }),
    });
    if (!response.ok) {
      // Provider bodies can contain prompt or account details. Never copy them into logs/errors.
      throw new Error(`OpenAI request failed (${response.status})`);
    }

    let parsed: OpenAiChatResponse;
    try {
      parsed = await response.json() as OpenAiChatResponse;
    } catch {
      throw new Error('OpenAI returned an invalid response');
    }
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('OpenAI returned an invalid response');

    const inputTokens = parsed.usage?.prompt_tokens;
    const outputTokens = parsed.usage?.completion_tokens;
    const usage = typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { inputTokens, outputTokens }
      : undefined;
    return { text, usage, provider: 'openai' };
  }

  async embed(_text: string): Promise<number[]> {
    // Existing Vectorize indexes use Workers AI dimensions. OpenAI is generate-only here.
    throw new LlmConfigError('OpenAI embeddings are not supported by this provider');
  }
}
