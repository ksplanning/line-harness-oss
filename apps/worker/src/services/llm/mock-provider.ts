import {
  type LlmProvider,
  type LlmPrompt,
  type LlmGenerateOptions,
  type LlmGenerateResult,
  type LlmUsage,
} from './llm-provider.js';

export interface MockLlmOptions {
  text?: string;
  usage?: LlmUsage;
  /** true / Error で generate を失敗させる (timeout/例外の再現)。 */
  throwError?: Error | boolean;
  embedResult?: number[];
}

/**
 * vitest 用 provider。ローカル/CI は `env.AI` binding が無いため本 mock を inject する。
 * 実 `env.AI.run` は本番 dark-ship 環境 (FAQ_BOT_ENABLED=false) でのみ結線。
 */
export class MockLlmProvider implements LlmProvider {
  public readonly calls: LlmPrompt[] = [];

  constructor(private readonly opts: MockLlmOptions = {}) {}

  async generate(prompt: LlmPrompt, _opts?: LlmGenerateOptions): Promise<LlmGenerateResult> {
    this.calls.push(prompt);
    if (this.opts.throwError) {
      throw this.opts.throwError instanceof Error
        ? this.opts.throwError
        : new Error('mock generate error');
    }
    return {
      text: this.opts.text ?? '',
      usage: this.opts.usage ?? { inputTokens: 10, outputTokens: 20 },
    };
  }

  async embed(_text: string): Promise<number[]> {
    return this.opts.embedResult ?? [];
  }
}
