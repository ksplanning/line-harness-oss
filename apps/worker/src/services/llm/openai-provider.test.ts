import { describe, expect, test, vi } from 'vitest';
import { LlmConfigError, type LlmProvider } from './llm-provider.js';
import { OpenAiProvider } from './openai.js';
import { GenerateFallbackProvider } from './fallback-provider.js';
import { WorkersAiProvider, type WorkersAiBinding } from './workers-ai.js';
import { createFaqAiRuntime } from './runtime.js';

function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: 'primary answer',
      usage: { inputTokens: 2, outputTokens: 1 },
    }),
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    ...overrides,
  };
}

describe('OpenAiProvider', () => {
  test('maps the chat-completions response onto the shared LLM result without exposing the key', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OpenAI の回答' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const openai = new OpenAiProvider('test-secret', 'gpt-test', request as typeof fetch);

    await expect(openai.generate(
      { system: 'system rule', user: 'question' },
      { maxTokens: 321, temperature: 0.25 },
    )).resolves.toEqual({
      text: 'OpenAI の回答',
      usage: { inputTokens: 11, outputTokens: 7 },
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'system rule' },
        { role: 'user', content: 'question' },
      ],
      max_tokens: 321,
      temperature: 0.25,
    });
  });

  test('uses a stable default model when only OPENAI_API_KEY is configured', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    const openai = new OpenAiProvider('test-secret', undefined, request as typeof fetch);

    await openai.generate({ system: 's', user: 'u' });

    const init = request.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).model).toBe('gpt-4o-mini');
  });

  test('rejects a blank key before fetch and does not leak provider response details', async () => {
    const request = vi.fn().mockResolvedValue(new Response('sensitive upstream detail', { status: 429 }));
    const missing = new OpenAiProvider('  ', 'gpt-test', request as typeof fetch);
    await expect(missing.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmConfigError);
    expect(request).not.toHaveBeenCalled();

    const configured = new OpenAiProvider('test-secret', 'gpt-test', request as typeof fetch);
    const failure = await configured.generate({ system: 's', user: 'u' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('429');
    expect(String(failure)).not.toContain('test-secret');
    expect(String(failure)).not.toContain('sensitive upstream detail');
  });
});

describe('GenerateFallbackProvider', () => {
  test('returns Workers AI success without calling OpenAI', async () => {
    const primary = provider();
    const fallback = provider({ generate: vi.fn().mockResolvedValue({ text: 'fallback answer' }) });
    const combined = new GenerateFallbackProvider(primary, fallback);

    await expect(combined.generate({ system: 's', user: 'u' })).resolves.toMatchObject({ text: 'primary answer' });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  test.each(['throws', 'returns an empty answer'])(
    'falls back to OpenAI when Workers AI %s',
    async (mode) => {
      const primary = provider({
        generate: mode === 'throws'
          ? vi.fn().mockRejectedValue(new Error('workers limit'))
          : vi.fn().mockResolvedValue({ text: '  ' }),
      });
      const fallback = provider({ generate: vi.fn().mockResolvedValue({ text: 'fallback answer' }) });
      const combined = new GenerateFallbackProvider(primary, fallback);

      await expect(combined.generate({ system: 's', user: 'u' })).resolves.toMatchObject({ text: 'fallback answer' });
      expect(fallback.generate).toHaveBeenCalledTimes(1);
    },
  );

  test('always keeps embeddings on Workers AI', async () => {
    const primary = provider();
    const fallback = provider();
    const combined = new GenerateFallbackProvider(primary, fallback);

    await expect(combined.embed('document')).resolves.toEqual([0.1, 0.2]);
    expect(primary.embed).toHaveBeenCalledWith('document');
    expect(fallback.embed).not.toHaveBeenCalled();
  });
});

describe('createFaqAiRuntime OpenAI fallback wiring', () => {
  const ai: WorkersAiBinding = { run: vi.fn().mockResolvedValue({ response: 'workers answer' }) };

  test('keeps the byte-equivalent Workers provider when the key is missing or blank', () => {
    expect(createFaqAiRuntime({ AI: ai, AI_MODEL_ID: 'workers-model' })!.provider)
      .toBeInstanceOf(WorkersAiProvider);
    expect(createFaqAiRuntime({ AI: ai, AI_MODEL_ID: 'workers-model', OPENAI_API_KEY: '  ' })!.provider)
      .toBeInstanceOf(WorkersAiProvider);
  });

  test('adds the generate-only fallback only when OPENAI_API_KEY is configured', () => {
    const runtime = createFaqAiRuntime({
      AI: ai,
      AI_MODEL_ID: 'workers-model',
      OPENAI_API_KEY: 'test-secret',
      OPENAI_MODEL_ID: 'gpt-test',
    });
    expect(runtime!.provider).toBeInstanceOf(GenerateFallbackProvider);
  });

  test('preserves the existing dark-ship null when env.AI is absent', () => {
    expect(createFaqAiRuntime({ OPENAI_API_KEY: 'test-secret' })).toBeNull();
  });
});
