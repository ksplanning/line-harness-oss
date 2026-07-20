import {
  type LlmGenerateOptions,
  type LlmGenerateResult,
  type LlmPrompt,
  type LlmProvider,
} from './llm-provider.js';

/**
 * Uses the secondary provider only when primary generation fails or returns no answer.
 * Embeddings intentionally stay on the primary Workers AI provider so Vectorize dimensions
 * and the existing FAQ/document-QA path remain unchanged.
 */
export class GenerateFallbackProvider implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {}

  async generate(prompt: LlmPrompt, opts?: LlmGenerateOptions): Promise<LlmGenerateResult> {
    try {
      const result = await this.primary.generate(prompt, opts);
      if (result.text.trim()) return result;
    } catch {
      // The fallback owns the visible result; provider details must not escape this boundary.
    }
    return this.fallback.generate(prompt, opts);
  }

  embed(text: string): Promise<number[]> {
    return this.primary.embed(text);
  }
}
