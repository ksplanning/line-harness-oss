import { describe, expect, test, vi } from 'vitest';
import type { FormalooAiChatHistory } from '@line-crm/db';
import type { FormalooClient } from '../services/formaloo-client.js';
import {
  createFormalooAiChatRoutes,
  parseFormalooAiRequestContract,
  runFormalooAiAnalysis,
  type FormalooAiChatRouteDeps,
  type FormalooAiRequestContract,
} from './formaloo-ai-chat.js';

const contract: FormalooAiRequestContract = {
  // Synthetic mock keys only. The official POST schema is intentionally not inferred.
  body: { form_reference: '{{form_slug}}', question_text: '{{prompt}}' },
  slug: { source: 'response', path: 'slug' },
};

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
    id: 'fa_1', deleted: 0, formaloo_slug: 'remote-form-1', workspace_id: 'fw_1',
    line_account_id: 'line-a', ...overrides,
  } as never;
}

function deps(overrides: Partial<FormalooAiChatRouteDeps> = {}): FormalooAiChatRouteDeps {
  const pending = history();
  return {
    getLineAccount: vi.fn().mockResolvedValue({ id: 'line-a', is_active: 1 } as never),
    getForm: vi.fn().mockResolvedValue(form()),
    listHistory: vi.fn().mockResolvedValue([pending]),
    reserveHistory: vi.fn().mockResolvedValue(pending),
    hasPendingHistory: vi.fn().mockResolvedValue(false),
    completeHistory: vi.fn().mockResolvedValue(history({
      status: 'completed', analysisSlug: 'analysis_1', answer: { summary: '回答が増えています' },
      answerText: '回答が増えています', creditsConsumed: true, providerStatus: 'completed',
    })),
    failHistory: vi.fn().mockResolvedValue(history({ status: 'failed' })),
    resolveClient: vi.fn().mockResolvedValue({}),
    deadlineClient: vi.fn((client) => client),
    analyze: vi.fn().mockResolvedValue({
      ok: true, slug: 'analysis_1', result: { summary: '回答が増えています' },
      answerText: '回答が増えています', providerStatus: 'completed', creditsConsumed: true,
    }),
    loadContract: vi.fn().mockReturnValue({ ok: true, contract }),
    tenantScope: vi.fn().mockReturnValue('worker-a'),
    now: vi.fn().mockReturnValue('2026-07-20T10:00:00.000+09:00'),
    ...overrides,
  };
}

const enabledEnv = {
  DB: {} as D1Database,
  FORMALOO_AI_CHAT_ENABLED: 'true',
  FORMALOO_AI_CHAT_DAILY_LIMIT: '3',
};

describe('Formaloo AI provider adapter', () => {
  test('uses only the configured mock body, then polls documented statuses until completed', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 201, data: { slug: 'analysis_1' } });
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, data: { slug: 'analysis_1', status: 'created', result: {} } })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        data: { slug: 'analysis_1', status: 'completed', result: { summary: '回答が増えています' }, errors: {} },
      });
    const client = { post, get } as unknown as FormalooClient;

    const result = await runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt: '今週の傾向は？',
      sleep: vi.fn().mockResolvedValue(undefined), maxPolls: 3,
    });

    expect(post).toHaveBeenCalledWith('/v3.0/custom-prompt-analyzes/', {
      form_reference: 'remote-form-1', question_text: '今週の傾向は？',
    });
    expect(get).toHaveBeenNthCalledWith(1, '/v3.0/custom-prompt-results/analysis_1/');
    expect(get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true, slug: 'analysis_1', providerStatus: 'completed',
      result: { summary: '回答が増えています' }, answerText: '回答が増えています',
      creditsConsumed: true,
    });
  });

  test('surfaces defensive 402 handling without claiming it is an official endpoint contract', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ ok: false, status: 402, error: 'provider body hidden' }),
      get: vi.fn(),
    } as unknown as FormalooClient;
    await expect(runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt: '分析して', sleep: vi.fn(),
    })).resolves.toMatchObject({
      ok: false, code: 'credits_exhausted', httpStatus: 402, creditsConsumed: false,
    });
  });

  test('keeps the credit reservation when an issued POST has an ambiguous 5xx outcome', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ ok: false, status: 500, error: 'provider body hidden' }),
      get: vi.fn(),
    } as unknown as FormalooClient;
    await expect(runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt: '分析して', sleep: vi.fn(),
    })).resolves.toMatchObject({
      ok: false, code: 'provider_issue_failed', httpStatus: 502, creditsConsumed: true,
    });
  });

  test('fails explicitly when the undocumented POST response does not expose the configured slug', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ ok: true, status: 201, data: null }),
      get: vi.fn(),
    } as unknown as FormalooClient;
    await expect(runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt: '分析して', sleep: vi.fn(),
    })).resolves.toMatchObject({
      ok: false, code: 'contract_mismatch', httpStatus: 502, creditsConsumed: true,
    });
  });

  test('bounds in-progress polling and reports a visible timeout', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ ok: true, status: 201, data: { slug: 'analysis_1' } }),
      get: vi.fn().mockResolvedValue({
        ok: true, status: 200, data: { slug: 'analysis_1', status: 'in_progress', result: {} },
      }),
    } as unknown as FormalooClient;
    await expect(runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt: '分析して', sleep: vi.fn().mockResolvedValue(undefined), maxPolls: 2,
    })).resolves.toMatchObject({
      ok: false, code: 'poll_timeout', httpStatus: 504, analysisSlug: 'analysis_1', creditsConsumed: true,
    });
  });

  test('requires host-confirmed form and prompt placeholders', () => {
    expect(parseFormalooAiRequestContract(JSON.stringify(contract))).toMatchObject({ ok: true });
    expect(parseFormalooAiRequestContract(JSON.stringify({ body: { only: '{{prompt}}' }, slug: contract.slug })))
      .toMatchObject({ ok: false, code: 'contract_unconfigured' });
    expect(parseFormalooAiRequestContract(JSON.stringify({
      body: { '{{form_slug}}': 'a key is not a value', prompt: '{{prompt}}' }, slug: contract.slug,
    }))).toMatchObject({ ok: false, code: 'contract_unconfigured' });
  });

  test('does not reinterpret placeholder-like text inside the administrator question', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 201, data: { slug: 'analysis_1' } });
    const client = {
      post,
      get: vi.fn().mockResolvedValue({
        ok: true, status: 200,
        data: { slug: 'analysis_1', status: 'completed', result: { summary: '完了' } },
      }),
    } as unknown as FormalooClient;
    const prompt = '文字列 {{analysis_slug}} をそのまま分析して';

    await runFormalooAiAnalysis(client, contract, {
      formSlug: 'remote-form-1', prompt, sleep: vi.fn(), generateSlug: () => 'generated_1',
    });

    expect(post).toHaveBeenCalledWith('/v3.0/custom-prompt-analyzes/', {
      form_reference: 'remote-form-1', question_text: prompt,
    });
  });
});

describe('Formaloo AI chat route', () => {
  test('defaults OFF with a 404 and performs no DB or provider work', async () => {
    const d = deps();
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, { ...enabledEnv, FORMALOO_AI_CHAT_ENABLED: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, code: 'ai_chat_disabled' });
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('resolves the stored form/workspace, reserves a credit, polls, and saves the answer', async () => {
    const d = deps();
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '今週の傾向は？' }),
    }, enabledEnv);
    expect(res.status).toBe(200);
    expect(d.resolveClient).toHaveBeenCalledWith(expect.objectContaining({ DB: enabledEnv.DB }), 'fw_1');
    expect(d.reserveHistory).toHaveBeenCalledWith(enabledEnv.DB, expect.objectContaining({
      tenantScope: 'worker-a', lineAccountId: 'line-a', formId: 'fa_1',
      question: '今週の傾向は？', dailyLimit: 3,
    }));
    expect(d.analyze).toHaveBeenCalledWith(expect.anything(), contract, {
      formSlug: 'remote-form-1', prompt: '今週の傾向は？',
    });
    expect(d.completeHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      analysisSlug: 'analysis_1', answerText: '回答が増えています', providerStatus: 'completed',
    }));
    expect(await res.json()).toMatchObject({ success: true, data: { status: 'completed' } });
  });

  test('rejects a form from another selected account without calling Formaloo', async () => {
    const d = deps({ getForm: vi.fn().mockResolvedValue(form({ line_account_id: 'line-b' })) });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(404);
    expect(d.resolveClient).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null],
    ['inactive', { id: 'line-a', is_active: 0 }],
  ] as const)('rejects a %s selected account even when the form is shared', async (_label, account) => {
    const d = deps({
      getLineAccount: vi.fn().mockResolvedValue(account as never),
      getForm: vi.fn().mockResolvedValue(form({ line_account_id: null })),
    });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'made-up', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(404);
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.resolveClient).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('returns a daily-limit message before provider execution', async () => {
    const d = deps({ reserveHistory: vi.fn().mockResolvedValue(null) });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ success: false, code: 'daily_limit_reached' });
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('returns an in-progress message when the atomic reservation detects a duplicate analysis', async () => {
    const d = deps({
      reserveHistory: vi.fn().mockResolvedValue(null),
      hasPendingHistory: vi.fn().mockResolvedValue(true),
    });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, code: 'analysis_in_progress' });
    expect(d.analyze).not.toHaveBeenCalled();
  });

  test('ends the pending history conservatively when the provider adapter throws', async () => {
    const d = deps({ analyze: vi.fn().mockRejectedValue(new Error('provider detail hidden')) });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(502);
    expect(d.failHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      errorCode: 'provider_unknown_failure', creditsConsumed: true,
    }));
    expect(await res.json()).toMatchObject({ success: false, code: 'provider_unknown_failure' });
  });

  test.each([
    [{ ok: false, code: 'credits_exhausted', message: '利用枠がありません', httpStatus: 402, creditsConsumed: false }, 402],
    [{ ok: false, code: 'poll_timeout', message: '時間がかかりました', httpStatus: 504, creditsConsumed: true, analysisSlug: 'a1' }, 504],
  ] as const)('stores and returns a visible provider failure %#', async (outcome, status) => {
    const d = deps({ analyze: vi.fn().mockResolvedValue(outcome) });
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, enabledEnv);
    expect(res.status).toBe(status);
    expect(d.failHistory).toHaveBeenCalledWith(enabledEnv.DB, 'fac_1', expect.objectContaining({
      errorCode: outcome.code, creditsConsumed: outcome.creditsConsumed,
    }));
    expect(await res.json()).toMatchObject({ success: false, code: outcome.code });
  });

  test('lists history only after validating the selected form/account scope', async () => {
    const d = deps();
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request(
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
    const app = createFormalooAiChatRoutes(d);
    const res = await app.request(
      '/api/forms-advanced/ai-chat/history?formId=fa_1&lineAccountId=made-up',
      undefined,
      enabledEnv,
    );
    expect(res.status).toBe(404);
    expect(d.getForm).not.toHaveBeenCalled();
    expect(d.listHistory).not.toHaveBeenCalled();
  });
});
