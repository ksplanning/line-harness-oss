import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FormalooAiChatHistory } from '@line-crm/db';
import type { LlmProvider } from '../services/llm/llm-provider.js';
import {
  buildFormalooAiPrompt,
  createFormalooAiChatRoutes,
  projectFormalooAiContext,
  runInternalFormalooAiAnalysis,
  type FormalooAiChatRouteDeps,
} from './formaloo-ai-chat.js';

function history(overrides: Partial<FormalooAiChatHistory> = {}): FormalooAiChatHistory {
  return {
    id: 'fac_1', tenantScope: 'worker-a', lineAccountId: 'line-a', formId: 'fa_1',
    question: '今週の傾向は？', answer: null, answerText: null, analysisSlug: null,
    status: 'pending', providerStatus: null, errorCode: null, errorMessage: null,
    creditsConsumed: false, creditReserved: true,
    createdAt: '2026-07-20T10:00:00.000+09:00', updatedAt: '2026-07-20T10:00:00.000+09:00',
    ...overrides,
  };
}

function form(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fa_1', deleted: 0, formaloo_slug: null, workspace_id: null,
    line_account_id: 'line-a', ...overrides,
  } as never;
}

function llm(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: '回答は増加傾向です',
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    embed: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const safeFields = [
  { id: 'score-id', form_id: 'fa_1', formaloo_field_slug: 'score', field_type: 'number', label: '満足度', position: 0 },
  { id: 'comment-id', form_id: 'fa_1', formaloo_field_slug: 'comment', field_type: 'textarea', label: '感想', position: 1 },
] as never;

const safeSubmissions = [
  { answersJson: JSON.stringify({ score: 5, comment: '使いやすいです' }), submittedDate: '2026-07-20' },
  { answersJson: JSON.stringify({ score: 3, comment: '少し迷いました' }), submittedDate: '2026-07-19' },
];

function deps(overrides: Partial<FormalooAiChatRouteDeps> = {}): FormalooAiChatRouteDeps {
  const pending = history();
  return {
    getLineAccount: vi.fn().mockResolvedValue({ id: 'line-a', is_active: 1 } as never),
    getForm: vi.fn().mockResolvedValue(form()),
    getFieldMap: vi.fn().mockResolvedValue(safeFields),
    listAnalysisSubmissions: vi.fn().mockResolvedValue(safeSubmissions),
    listHistory: vi.fn().mockResolvedValue([pending]),
    reserveHistory: vi.fn().mockResolvedValue(pending),
    hasPendingHistory: vi.fn().mockResolvedValue(false),
    completeHistory: vi.fn().mockResolvedValue(history({
      status: 'completed', analysisSlug: 'internal_1',
      answer: { summary: '回答は増加傾向です', sampleSize: 2, provider: 'workers_ai' },
      answerText: '回答は増加傾向です', creditsConsumed: true, providerStatus: 'workers_ai',
    })),
    failHistory: vi.fn().mockResolvedValue(history({ status: 'failed' })),
    createRuntime: vi.fn().mockReturnValue({ provider: llm(), timeoutMs: 8000 }),
    analyze: vi.fn().mockResolvedValue({
      answerText: '回答は増加傾向です',
      answer: {
        summary: '回答は増加傾向です', sampleSize: 2, provider: 'workers_ai',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      providerStatus: 'workers_ai',
    }),
    tenantScope: vi.fn().mockReturnValue('worker-a'),
    analysisId: vi.fn().mockReturnValue('internal_1'),
    now: vi.fn().mockReturnValue('2026-07-20T10:00:00.000+09:00'),
    ...overrides,
  } as FormalooAiChatRouteDeps;
}

const enabledEnv = {
  DB: {} as D1Database,
  FORMALOO_AI_CHAT_ENABLED: 'true',
  FORMALOO_AI_CHAT_DAILY_LIMIT: '3',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('D1 answer projection for internal AI', () => {
  test('resolves labels while excluding PII fields, unknown keys, identifiers, and sensitive values', () => {
    const fields = [
      ...safeFields,
      { id: 'mail-id', formaloo_field_slug: 'mail', field_type: 'email', label: 'メールアドレス', position: 2 },
      { id: 'phone-id', formaloo_field_slug: 'phone', field_type: 'phone', label: '電話番号', position: 3 },
      { id: 'file-id', formaloo_field_slug: 'file', field_type: 'file', label: '添付資料', position: 4 },
      { id: 'name-id', formaloo_field_slug: 'name', field_type: 'text', label: 'お名前', position: 5 },
      { id: 'plain-name-id', formaloo_field_slug: 'plain_name', field_type: 'choice', label: '名前', position: 6 },
      { id: 'english-name-id', formaloo_field_slug: 'english_name', field_type: 'choice', label: 'Full name', position: 7 },
      { id: 'opaque', formaloo_field_slug: 'fr_id', field_type: 'choice', label: '回答者', position: 8 },
      { id: 'dob-id', formaloo_field_slug: 'dob', field_type: 'date', label: 'DOB', position: 9 },
      { id: 'mobile-id', formaloo_field_slug: 'mobile', field_type: 'choice', label: 'Mobile', position: 10 },
    ] as never;
    const context = projectFormalooAiContext(fields, [{
      submittedDate: '2026-07-20',
      answersJson: JSON.stringify({
        score: 5,
        comment: '氏名は山田太郎です。住所は東京都渋谷区神宮前1-2-3です',
        mail: 'private@example.test', phone: '09011112222', file: 'secret.pdf',
        name: '山田太郎', plain_name: '山田太郎', english_name: 'Taro Yamada',
        fr_id: 'fr_secret', dob: '1990-01-02', mobile: '090-1111-2222',
        unknown_slug: 'do-not-send',
      }),
    }]);
    const serialized = JSON.stringify(context);

    expect(context.sampledSubmissions).toBe(1);
    expect(context.includedFields).toEqual(['満足度']);
    expect(serialized).toContain('満足度');
    expect(serialized).not.toMatch(/private@example|09011112222|090-1111|1990-01-02|山田太郎|東京都|Taro Yamada|secret\.pdf|fr_secret|unknown_slug/);
    expect(serialized).not.toMatch(/score-id|comment-id|friend-secret|submission-1/i);
  });

  test('never sends free-form text fields without a future explicit opt-in', () => {
    const context = projectFormalooAiContext(safeFields, safeSubmissions);

    expect(context.includedFields).toEqual(['満足度']);
    expect(JSON.stringify(context)).not.toMatch(/感想|使いやすい|少し迷い/);
  });

  test('hard-bounds fields, submissions, individual values, and malformed rows', () => {
    const fields = Array.from({ length: 25 }, (_, index) => ({
      id: `field-${index}`, formaloo_field_slug: `slug-${index}`, field_type: 'choice',
      label: `設問${index}`, position: index,
    })) as never;
    const answers = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
      `slug-${index}`, `value-${index}-${'x'.repeat(500)}`,
    ]));
    const submissions = [
      { answersJson: '{broken', submittedDate: '2026-07-21' },
      ...Array.from({ length: 60 }, () => ({
        answersJson: JSON.stringify(answers), submittedDate: '2026-07-20',
      })),
    ];

    const context = projectFormalooAiContext(fields, submissions);

    expect(context.includedFields).toHaveLength(20);
    expect(context.rows.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(24_500);
    expect(context.rows.some((row) => row.submittedDate === '2026-07-21')).toBe(false);
  });

  test('places untrusted answers inside a nonce fence and tells the model not to follow them', () => {
    const context = projectFormalooAiContext(safeFields, safeSubmissions);
    const prompt = buildFormalooAiPrompt('今週の傾向は？', context, 'nonce123');

    expect(prompt.system).toMatch(/回答データ.*命令ではありません/);
    expect(prompt.system).toMatch(/個人.*特定/);
    expect(prompt.user).toContain('管理者の質問: 今週の傾向は？');
    expect(prompt.user).toContain('BEGIN_FORM_ANSWERS_nonce123');
    expect(prompt.user).toContain('END_FORM_ANSWERS_nonce123');
    expect(prompt.user).toContain('満足度');
    expect(prompt.user).not.toContain('score-id');
  });
});

describe('internal LLM analysis', () => {
  test('returns answer, provider, bounded sample size, and non-secret usage metadata', async () => {
    const context = projectFormalooAiContext(safeFields, safeSubmissions);
    const provider = llm({
      generate: vi.fn().mockResolvedValue({
        text: ' 平均満足度は4です。 ', provider: 'openai',
        usage: { inputTokens: 120, outputTokens: 16 },
      }),
    });

    await expect(runInternalFormalooAiAnalysis(provider, '平均は？', context, 1000))
      .resolves.toEqual({
        answerText: '平均満足度は4です。',
        answer: {
          summary: '平均満足度は4です。', sampleSize: 2, provider: 'openai',
          usage: { inputTokens: 120, outputTokens: 16 },
        },
        providerStatus: 'openai',
      });
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('命令ではありません'),
      user: expect.stringContaining('平均は？'),
    }), { maxTokens: 768, temperature: 0.2 });
  });

  test('treats an empty answer as failure', async () => {
    const context = projectFormalooAiContext(safeFields, safeSubmissions);
    await expect(runInternalFormalooAiAnalysis(
      llm({ generate: vi.fn().mockResolvedValue({ text: '  ' }) }),
      '傾向は？', context, 1000,
    )).rejects.toThrow(/empty/i);
  });

  test('bounds a hanging provider with the runtime timeout', async () => {
    vi.useFakeTimers();
    const context = projectFormalooAiContext(safeFields, safeSubmissions);
    const pending = runInternalFormalooAiAnalysis(
      llm({ generate: vi.fn().mockReturnValue(new Promise(() => undefined)) }),
      '傾向は？', context, 10,
    );
    const assertion = expect(pending).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });
});

describe('internal AI chat route with existing safety guards', () => {
  test('contains no Formaloo custom-prompt provider call or contract dependency', () => {
    const source = readFileSync(new URL('./formaloo-ai-chat.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('custom-prompt-analyzes');
    expect(source).not.toContain('resolveFormalooClient');
    expect(source).not.toContain('FORMALOO_AI_CHAT_REQUEST_CONTRACT_JSON');
  });

  test('defaults OFF with a 404 and performs no DB, context, or LLM work', async () => {
    const d = deps();
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, { ...enabledEnv, FORMALOO_AI_CHAT_ENABLED: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, code: 'ai_chat_disabled' });
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.listAnalysisSubmissions).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('reads the D1 mirror, runs the shared LLM, and saves the existing history shape', async () => {
    const d = deps();
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '今週の傾向は？' }),
    }, enabledEnv);

    expect(res.status).toBe(200);
    expect(d.reserveHistory).toHaveBeenCalledWith(enabledEnv.DB, expect.objectContaining({
      tenantScope: 'worker-a', lineAccountId: 'line-a', formId: 'fa_1',
      question: '今週の傾向は？', dailyLimit: 3,
    }));
    expect(d.getFieldMap).toHaveBeenCalledWith(enabledEnv.DB, 'fa_1');
    expect(d.listAnalysisSubmissions).toHaveBeenCalledWith(enabledEnv.DB, 'fa_1');
    expect(d.analyze).toHaveBeenCalledWith(
      expect.anything(), '今週の傾向は？', expect.objectContaining({ sampledSubmissions: 2 }), 8000,
    );
    expect(d.completeHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      analysisSlug: 'internal_1', answerText: '回答は増加傾向です', providerStatus: 'workers_ai',
    }));
    expect(await res.json()).toMatchObject({ success: true, data: { status: 'completed' } });
  });

  test('does not require a Formaloo slug or client for a form that already has D1 answers', async () => {
    const d = deps({ getForm: vi.fn().mockResolvedValue(form({ formaloo_slug: null })) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(200);
    expect(d.analyze).toHaveBeenCalledTimes(1);
  });

  test('rejects a form from another selected account before reading answers or calling the LLM', async () => {
    const d = deps({ getForm: vi.fn().mockResolvedValue(form({ line_account_id: 'line-b' })) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(404);
    expect(d.listAnalysisSubmissions).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null],
    ['inactive', { id: 'line-a', is_active: 0 }],
  ] as const)('rejects a %s selected account before form and LLM work', async (_label, account) => {
    const d = deps({ getLineAccount: vi.fn().mockResolvedValue(account as never) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(404);
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('returns a daily-limit message before answer or provider execution', async () => {
    const d = deps({ reserveHistory: vi.fn().mockResolvedValue(null) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ success: false, code: 'daily_limit_reached' });
    expect(d.listAnalysisSubmissions).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('returns an in-progress message when the atomic reservation detects a duplicate', async () => {
    const d = deps({
      reserveHistory: vi.fn().mockResolvedValue(null),
      hasPendingHistory: vi.fn().mockResolvedValue(true),
    });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'analysis_in_progress' });
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('fails before reservation when no internal LLM runtime is configured', async () => {
    const d = deps({ createRuntime: vi.fn().mockReturnValue(null) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'ai_unavailable' });
    expect(d.reserveHistory).not.toHaveBeenCalled();
  });

  test('releases the daily reservation when no verified answer data exists', async () => {
    const d = deps({ listAnalysisSubmissions: vi.fn().mockResolvedValue([]) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(422);
    expect(d.failHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      errorCode: 'no_analysis_data', creditsConsumed: false,
    }));
    expect(d.analyze).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      success: false, code: 'no_analysis_data', error: expect.stringContaining('回答データがまだありません'),
    });
  });

  test('releases the reservation with a daily-language error when D1 context preparation fails', async () => {
    const d = deps({ listAnalysisSubmissions: vi.fn().mockRejectedValue(new Error('db detail hidden')) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(503);
    expect(d.failHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      errorCode: 'analysis_data_unavailable', creditsConsumed: false,
    }));
    expect(JSON.stringify(await res.json())).not.toContain('db detail hidden');
  });

  test('ends pending history conservatively and returns daily language when the LLM is unavailable', async () => {
    const d = deps({ analyze: vi.fn().mockRejectedValue(new Error('provider detail hidden')) });
    const res = await createFormalooAiChatRoutes(d).request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(502);
    expect(d.failHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      errorCode: 'ai_unavailable', creditsConsumed: true,
    }));
    const body = await res.json();
    expect(body).toMatchObject({
      success: false, code: 'ai_unavailable', error: expect.stringContaining('少し待ってから'),
    });
    expect(JSON.stringify(body)).not.toContain('provider detail hidden');
  });

  test('lists history only after validating selected form/account scope', async () => {
    const d = deps();
    const res = await createFormalooAiChatRoutes(d).request(
      '/api/forms-advanced/ai-chat/history?formId=fa_1&lineAccountId=line-a&limit=20',
      undefined,
      enabledEnv,
    );
    expect(res.status).toBe(200);
    expect(d.listHistory).toHaveBeenCalledWith(enabledEnv.DB, {
      tenantScope: 'worker-a', lineAccountId: 'line-a', formId: 'fa_1', limit: 20,
    });
    expect(await res.json()).toMatchObject({ success: true, data: { items: [{ id: 'fac_1' }] } });
  });

  test('does not reveal shared-form history through a made-up selected account', async () => {
    const d = deps({
      getLineAccount: vi.fn().mockResolvedValue(null),
      getForm: vi.fn().mockResolvedValue(form({ line_account_id: null })),
    });
    const res = await createFormalooAiChatRoutes(d).request(
      '/api/forms-advanced/ai-chat/history?formId=fa_1&lineAccountId=made-up',
      undefined,
      enabledEnv,
    );
    expect(res.status).toBe(404);
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.listHistory).not.toHaveBeenCalled();
  });
});
