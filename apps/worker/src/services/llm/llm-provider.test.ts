/**
 * T-A1 (Phase B B-1) — LlmProvider 抽象 + WorkersAiProvider + MockLlmProvider + createFaqAiRuntime。
 *   - generate は {text, usage?:{inputTokens,outputTokens}} を返す (シグネチャ固定)。
 *   - WorkersAiProvider は env.AI.run(env.AI_MODEL_ID, ...) を呼ぶ (MODEL_ID は env・literal なし)。
 *   - AI_MODEL_ID 未設定/空 → 送信せず fail-safe (LlmConfigError・ai.run を呼ばない)。
 *   - provider 差替は inject 1 点 (createFaqAiRuntime factory / MockLlmProvider へ差替可能)。
 */
import { describe, expect, test, vi } from 'vitest';
import { type LlmProvider, LlmConfigError } from './llm-provider.js';
import { WorkersAiProvider, type WorkersAiBinding } from './workers-ai.js';
import { MockLlmProvider } from './mock-provider.js';
import { createFaqAiRuntime, DEFAULT_CHUNK_RELEVANCE_FLOOR } from './runtime.js';

function fakeAi(runImpl: WorkersAiBinding['run']): { ai: WorkersAiBinding; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(runImpl);
  return { ai: { run }, run };
}

describe('WorkersAiProvider', () => {
  test('generate は env.AI.run(modelId, messages) を呼び {text, usage} を返す', async () => {
    const { ai, run } = fakeAi(async () => ({
      response: '10時から19時です',
      usage: { prompt_tokens: 42, completion_tokens: 8 },
    }));
    const provider = new WorkersAiProvider(ai, '@cf/meta/llama-3.1-8b-instruct-fast');
    const out = await provider.generate({ system: 'sys', user: 'usr' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe('@cf/meta/llama-3.1-8b-instruct-fast'); // MODEL_ID は渡された env 値
    expect(out.text).toBe('10時から19時です');
    expect(out.usage).toEqual({ inputTokens: 42, outputTokens: 8 });
  });

  test('AI_MODEL_ID 未設定 → ai.run を呼ばず LlmConfigError で fail-safe', async () => {
    const { ai, run } = fakeAi(async () => ({ response: 'x' }));
    const provider = new WorkersAiProvider(ai, undefined);
    await expect(provider.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmConfigError);
    expect(run).not.toHaveBeenCalled();
  });

  test('AI_MODEL_ID が空文字 → ai.run を呼ばず fail-safe', async () => {
    const { ai, run } = fakeAi(async () => ({ response: 'x' }));
    const provider = new WorkersAiProvider(ai, '   ');
    await expect(provider.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmConfigError);
    expect(run).not.toHaveBeenCalled();
  });

  test('usage 欠損時は usage=undefined を返す (呼び手が退避判定)', async () => {
    const { ai } = fakeAi(async () => ({ response: 'ok' }));
    const provider = new WorkersAiProvider(ai, 'model-x');
    const out = await provider.generate({ system: 's', user: 'u' });
    expect(out.text).toBe('ok');
    expect(out.usage).toBeUndefined();
  });

  test('JSON schema を Workers AI の response_format に渡し object 応答を JSON text 化する', async () => {
    const { ai, run } = fakeAi(async () => ({
      response: { answerable: false, answer: '資料だけでは確認できません' },
      usage: { prompt_tokens: 12, completion_tokens: 9 },
    }));
    const provider = new WorkersAiProvider(ai, 'model-x');
    const responseFormat = {
      type: 'json_schema' as const,
      name: 'faq_answer',
      schema: {
        type: 'object',
        properties: { answerable: { type: 'boolean' }, answer: { type: 'string' } },
        required: ['answerable', 'answer'],
      },
    };

    const out = await provider.generate({ system: 's', user: 'u' }, { responseFormat });

    expect(run.mock.calls[0][1]).toMatchObject({
      response_format: { type: 'json_schema', json_schema: responseFormat.schema },
    });
    expect(JSON.parse(out.text)).toEqual({ answerable: false, answer: '資料だけでは確認できません' });
  });
});

describe('MockLlmProvider', () => {
  test('設定した text/usage を返し呼出を記録する', async () => {
    const mock = new MockLlmProvider({ text: 'mock回答', usage: { inputTokens: 5, outputTokens: 3 } });
    const out = await mock.generate({ system: 's', user: 'u' });
    expect(out.text).toBe('mock回答');
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(mock.calls).toHaveLength(1);
  });

  test('throwError で例外を投げられる (timeout/例外の再現)', async () => {
    const mock = new MockLlmProvider({ throwError: true });
    await expect(mock.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(Error);
  });
});

describe('createFaqAiRuntime (inject 1 点)', () => {
  test('env.AI 未設定 (infra 工程前) → null = AI 後段を組まない (dark-ship default)', () => {
    expect(createFaqAiRuntime({})).toBeNull();
    expect(createFaqAiRuntime({ AI_MODEL_ID: 'model-x' })).toBeNull(); // binding が無ければ null
  });

  test('env.AI あり → WorkersAiProvider を持つ runtime。floor 既定 0.3 (MODEL literal なし)', () => {
    const { ai } = fakeAi(async () => ({ response: 'x' }));
    const rt = createFaqAiRuntime({ AI: ai, AI_MODEL_ID: 'model-x' });
    expect(rt).not.toBeNull();
    expect(rt!.provider).toBeInstanceOf(WorkersAiProvider);
    expect(rt!.retrievalFloor).toBe(0.3);
    // retrievalFloor < threshold 0.6 (AI は match=null=topScore<0.6 の時のみ発火する下地)
    expect(rt!.retrievalFloor).toBeLessThan(0.6);
  });

  test('floor / budget / 係数を env から読む (literal 焼き込みでなく差替可能)', () => {
    const { ai } = fakeAi(async () => ({ response: 'x' }));
    const rt = createFaqAiRuntime({
      AI: ai,
      AI_MODEL_ID: 'model-x',
      AI_RETRIEVAL_FLOOR: '0.45',
      AI_DAILY_NEURON_BUDGET_GLOBAL: '5000',
      AI_DAILY_NEURON_BUDGET_PER_ACCOUNT: '2500',
      AI_NEURON_PER_MTOK_IN: '4119',
      AI_NEURON_PER_MTOK_OUT: '34868',
    })!;
    expect(rt.retrievalFloor).toBe(0.45);
    expect(rt.dailyNeuronBudgetGlobal).toBe(5000);
    expect(rt.dailyNeuronBudgetPerAccount).toBe(2500);
    expect(rt.neuronPerMTokIn).toBe(4119);
    expect(rt.neuronPerMTokOut).toBe(34868);
  });

  test('chunk relevance floor を env AI_CHUNK_RELEVANCE_FLOOR から読む (立会 §2: 0.70 = 第二層防御強化)', () => {
    const { ai } = fakeAi(async () => ({ response: 'x' }));
    // 立会 §2 retrieval-forensics 実測: Q1(営業時間質問) に無関係 chunk MAL-b cosine 0.6551 /
    // MAL-a 0.6483 が floor 0.6 では採用されていた。env で 0.70 に引き上げると両者不採用となり、
    // 無関係 chunk の混入とトークン消費を削る (floor は正規化 cosine の採否下限)。
    const rt = createFaqAiRuntime({ AI: ai, AI_MODEL_ID: 'model-x', AI_CHUNK_RELEVANCE_FLOOR: '0.70' })!;
    expect(rt.chunkRelevanceFloor).toBe(0.70);
    // 実測された無関係 chunk (0.6551 / 0.6483) は floor 0.70 で不採用になる。
    expect(0.6551).toBeLessThan(rt.chunkRelevanceFloor!);
    expect(0.6483).toBeLessThan(rt.chunkRelevanceFloor!);
  });

  test('AI_CHUNK_RELEVANCE_FLOOR 未設定なら既定 0.6 のまま (env 未設定環境の既定は不可侵 = env var のみが正)', () => {
    const { ai } = fakeAi(async () => ({ response: 'x' }));
    const rt = createFaqAiRuntime({ AI: ai, AI_MODEL_ID: 'model-x' })!;
    expect(rt.chunkRelevanceFloor).toBe(DEFAULT_CHUNK_RELEVANCE_FLOOR);
    // 既定値そのものは 0.6 据え置き (wrangler [vars] の env 値のみを 0.70 へ引き上げる)。
    expect(DEFAULT_CHUNK_RELEVANCE_FLOOR).toBe(0.6);
  });

  test('runtime.provider は LlmProvider として差替可能 (Mock を注入できる)', async () => {
    const swap: LlmProvider = new MockLlmProvider({ text: 'swapped' });
    // 呼び手 (faq-reply) は provider を抽象として受けるだけ = 差替 1 点
    const out = await swap.generate({ system: 's', user: 'u' });
    expect(out.text).toBe('swapped');
    expect(typeof swap.embed).toBe('function');
  });
});
