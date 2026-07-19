import { Hono } from 'hono';
import {
  completeFormalooAiChatHistory,
  failFormalooAiChatHistory,
  getFormalooForm,
  getLineAccountById,
  hasPendingFormalooAiChatHistory,
  jstNow,
  listFormalooAiChatHistory,
  reserveFormalooAiChatHistory,
} from '@line-crm/db';
import {
  resolveFormalooClient,
  type FormalooClient,
  type FormalooResult,
} from '../services/formaloo-client.js';
import type { Env } from '../index.js';

/**
 * Official contract pins (checked 2026-07-20):
 * - POST docs: https://docs.formaloo.com/#tag/Custom-Prompt-Analyses/operation/customPromptAnalyzesCreate
 *   The OpenAPI operation has no requestBody schema and documents a 201 with no response body.
 * - GET docs: https://docs.formaloo.com/#tag/Custom-Prompt-Results/operation/customPromptResultsRetrieve
 *   CustomPromptAnalyze.status is created | in_progress | completed | failed; result/errors are opaque objects.
 *
 * Because form/prompt keys and the POST slug source are not documented, production code never invents them.
 * The owner must provide a host-confirmed JSON contract before the route can reserve or spend a credit.
 */
const ANALYZE_PATH = '/v3.0/custom-prompt-analyzes/';
const RESULT_PATH = '/v3.0/custom-prompt-results';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 12;
const PROVIDER_DEADLINE_MS = 20_000;
const DEFAULT_DAILY_LIMIT = 1;
const MAX_DAILY_LIMIT = 100;
const MAX_PROMPT_LENGTH = 2_000;
const MAX_CONTRACT_LENGTH = 16_384;

type AiChatBindings = Env['Bindings'] & {
  FORMALOO_AI_CHAT_ENABLED?: string;
  FORMALOO_AI_CHAT_DAILY_LIMIT?: string;
  FORMALOO_AI_CHAT_REQUEST_CONTRACT_JSON?: string;
};

type JsonRecord = Record<string, unknown>;

export type FormalooAiRequestContract = {
  body: JsonRecord;
  slug:
    | { source: 'response'; path: string }
    | { source: 'generated' };
};

export type FormalooAiProviderOutcome =
  | {
      ok: true;
      slug: string;
      result: JsonRecord;
      answerText: string;
      providerStatus: 'completed';
      creditsConsumed: true;
    }
  | {
      ok: false;
      code: string;
      message: string;
      httpStatus: 402 | 502 | 504;
      creditsConsumed: boolean;
      providerStatus?: string;
      analysisSlug?: string;
    };

type ContractResult =
  | { ok: true; contract: FormalooAiRequestContract }
  | { ok: false; code: 'contract_unconfigured'; message: string };

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function contractError(): ContractResult {
  return {
    ok: false,
    code: 'contract_unconfigured',
    message: 'Formaloo のAI接続形式がまだ確認されていません。管理者が設定を確認してください',
  };
}

export function parseFormalooAiRequestContract(raw: string | undefined): ContractResult {
  if (!raw || raw.length > MAX_CONTRACT_LENGTH) return contractError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return contractError();
  }
  const record = asRecord(parsed);
  const body = asRecord(record?.body);
  const slug = asRecord(record?.slug);
  if (!body || !slug) return contractError();
  if (!templateValuesContain(body, '{{form_slug}}') || !templateValuesContain(body, '{{prompt}}')) {
    return contractError();
  }

  if (slug.source === 'response') {
    if (typeof slug.path !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(slug.path)) {
      return contractError();
    }
    return { ok: true, contract: { body, slug: { source: 'response', path: slug.path } } };
  }
  if (slug.source === 'generated' && templateValuesContain(body, '{{analysis_slug}}')) {
    return { ok: true, contract: { body, slug: { source: 'generated' } } };
  }
  return contractError();
}

function templateValuesContain(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some((item) => templateValuesContain(item, token));
  const record = asRecord(value);
  return record ? Object.values(record).some((item) => templateValuesContain(item, token)) : false;
}

function renderTemplate(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\{\{(?:form_slug|prompt|analysis_slug)\}\}/g,
      (token) => replacements[token] ?? token,
    );
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, replacements));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, renderTemplate(item, replacements)]),
  );
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function providerRecord(value: unknown): JsonRecord | null {
  const outer = asRecord(value);
  if (!outer) return null;
  if (typeof outer.status === 'string' || 'result' in outer || 'errors' in outer) return outer;
  const data = asRecord(outer.data);
  if (!data) return outer;
  const nested = asRecord(data.data);
  return nested ?? data;
}

function answerText(result: JsonRecord): string | null {
  if (Object.keys(result).length === 0) return null;
  const stringValues = Object.values(result).filter((value): value is string => (
    typeof value === 'string' && value.trim().length > 0
  ));
  if (stringValues.length === 1) return stringValues[0].trim();
  return JSON.stringify(result, null, 2);
}

function providerHttpFailure(
  result: Extract<FormalooResult, { ok: false }>,
  phase: 'issue' | 'poll',
  slug?: string,
): FormalooAiProviderOutcome {
  if (result.status === 402) {
    return {
      ok: false,
      code: 'credits_exhausted',
      message: 'Formaloo のAI利用枠が足りません。利用状況を確認してください',
      httpStatus: 402,
      creditsConsumed: phase === 'poll',
      providerStatus: '402',
      ...(slug ? { analysisSlug: slug } : {}),
    };
  }
  if (result.status === 0) {
    return {
      ok: false,
      code: 'provider_timeout',
      message: 'Formaloo の応答に時間がかかりました。少し待ってからもう一度お試しください',
      httpStatus: 504,
      // POST timeout has an unknown remote outcome, so keep the reservation conservatively.
      creditsConsumed: true,
      providerStatus: 'timeout',
      ...(slug ? { analysisSlug: slug } : {}),
    };
  }
  return {
    ok: false,
    code: phase === 'issue' ? 'provider_issue_failed' : 'provider_poll_failed',
    message: phase === 'issue'
      ? 'Formaloo で分析を始められませんでした。少し待ってからもう一度お試しください'
      : 'Formaloo の分析結果を確認できませんでした。少し待ってからもう一度お試しください',
    httpStatus: 502,
    // A 5xx after POST can mean the provider accepted work but failed while answering.
    // Keep that reservation; only an explicit issue-phase 4xx is treated as not issued.
    creditsConsumed: phase === 'poll' || result.status >= 500,
    providerStatus: String(result.status),
    ...(slug ? { analysisSlug: slug } : {}),
  };
}

export async function runFormalooAiAnalysis(
  client: FormalooClient,
  contract: FormalooAiRequestContract,
  input: {
    formSlug: string;
    prompt: string;
    sleep?: (ms: number) => Promise<void>;
    maxPolls?: number;
    generateSlug?: () => string;
  },
): Promise<FormalooAiProviderOutcome> {
  const generatedSlug = (input.generateSlug ?? (() => `cpa_${crypto.randomUUID().replaceAll('-', '')}`))();
  const body = renderTemplate(contract.body, {
    '{{form_slug}}': input.formSlug,
    '{{prompt}}': input.prompt,
    '{{analysis_slug}}': generatedSlug,
  }) as JsonRecord;
  const issued = await client.post(ANALYZE_PATH, body);
  if (!issued.ok) return providerHttpFailure(issued, 'issue');

  const slugValue = contract.slug.source === 'generated'
    ? generatedSlug
    : readPath(issued.data, contract.slug.path);
  const slug = typeof slugValue === 'string' ? slugValue.trim() : '';
  if (!slug || slug.length > 63) {
    return {
      ok: false,
      code: 'contract_mismatch',
      message: 'Formaloo の分析番号を確認できませんでした。連続実行せず、管理者に確認してください',
      httpStatus: 502,
      creditsConsumed: true,
      providerStatus: String(issued.status),
    };
  }

  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPolls = Math.max(1, Math.min(30, Math.floor(input.maxPolls ?? DEFAULT_MAX_POLLS)));
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const polled = await client.get(`${RESULT_PATH}/${encodeURIComponent(slug)}/`);
    if (!polled.ok) return providerHttpFailure(polled, 'poll', slug);
    const analysis = providerRecord(polled.data);
    const status = analysis?.status;
    if (status === 'completed') {
      const result = asRecord(analysis?.result);
      const formatted = result ? answerText(result) : null;
      if (!result || !formatted) {
        return {
          ok: false,
          code: 'contract_mismatch',
          message: 'Formaloo の分析は完了しましたが、回答を読み取れませんでした。管理者に確認してください',
          httpStatus: 502,
          creditsConsumed: true,
          providerStatus: 'completed',
          analysisSlug: slug,
        };
      }
      return {
        ok: true,
        slug,
        result,
        answerText: formatted,
        providerStatus: 'completed',
        creditsConsumed: true,
      };
    }
    if (status === 'failed') {
      return {
        ok: false,
        code: 'analysis_failed',
        message: 'Formaloo の分析が完了しませんでした。質問を変えてもう一度お試しください',
        httpStatus: 502,
        creditsConsumed: true,
        providerStatus: 'failed',
        analysisSlug: slug,
      };
    }
    if (status !== 'created' && status !== 'in_progress') {
      return {
        ok: false,
        code: 'contract_mismatch',
        message: 'Formaloo の分析状態を読み取れませんでした。管理者に確認してください',
        httpStatus: 502,
        creditsConsumed: true,
        providerStatus: typeof status === 'string' ? status : 'missing',
        analysisSlug: slug,
      };
    }
    if (attempt + 1 < maxPolls) await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    code: 'poll_timeout',
    message: '回答に時間がかかりました。少し待ってからもう一度お試しください',
    httpStatus: 504,
    creditsConsumed: true,
    providerStatus: 'in_progress',
    analysisSlug: slug,
  };
}

export interface FormalooAiChatRouteDeps {
  getLineAccount: typeof getLineAccountById;
  getForm: typeof getFormalooForm;
  listHistory: typeof listFormalooAiChatHistory;
  reserveHistory: typeof reserveFormalooAiChatHistory;
  hasPendingHistory: typeof hasPendingFormalooAiChatHistory;
  completeHistory: typeof completeFormalooAiChatHistory;
  failHistory: typeof failFormalooAiChatHistory;
  resolveClient: typeof resolveFormalooClient;
  deadlineClient: (client: FormalooClient) => FormalooClient;
  analyze: (
    client: FormalooClient,
    contract: FormalooAiRequestContract,
    input: { formSlug: string; prompt: string },
  ) => Promise<FormalooAiProviderOutcome>;
  loadContract: (env: AiChatBindings) => ContractResult;
  tenantScope: (env: AiChatBindings) => string;
  now: () => string;
}

const defaultDeps: FormalooAiChatRouteDeps = {
  getLineAccount: getLineAccountById,
  getForm: getFormalooForm,
  listHistory: listFormalooAiChatHistory,
  reserveHistory: reserveFormalooAiChatHistory,
  hasPendingHistory: hasPendingFormalooAiChatHistory,
  completeHistory: completeFormalooAiChatHistory,
  failHistory: failFormalooAiChatHistory,
  resolveClient: resolveFormalooClient,
  deadlineClient: (client) => client.withDeadline(PROVIDER_DEADLINE_MS),
  analyze: (client, requestContract, input) => runFormalooAiAnalysis(client, requestContract, input),
  loadContract: (env) => parseFormalooAiRequestContract(env.FORMALOO_AI_CHAT_REQUEST_CONTRACT_JSON),
  tenantScope: (env) => env.WORKER_NAME?.trim() || 'default',
  now: jstNow,
};

function dailyLimit(env: AiChatBindings): number {
  const parsed = Number(env.FORMALOO_AI_CHAT_DAILY_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_DAILY_LIMIT;
  return Math.min(parsed, MAX_DAILY_LIMIT);
}

function enabled(env: AiChatBindings): boolean {
  return env.FORMALOO_AI_CHAT_ENABLED === 'true';
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function formInAccount(form: Awaited<ReturnType<typeof getFormalooForm>>, lineAccountId: string): boolean {
  return Boolean(
    form
    && form.deleted !== 1
    && (form.line_account_id === null || form.line_account_id === lineAccountId),
  );
}

function activeLineAccount(account: Awaited<ReturnType<typeof getLineAccountById>>): boolean {
  return Boolean(account && account.is_active === 1);
}

export function createFormalooAiChatRoutes(injected: FormalooAiChatRouteDeps = defaultDeps) {
  const deps = injected;
  const routes = new Hono<Env>();

  routes.post('/api/forms-advanced/ai-chat/analyze', async (c) => {
    const env = c.env as AiChatBindings;
    if (!enabled(env)) {
      return c.json({ success: false, code: 'ai_chat_disabled', error: 'AIチャットは現在オフです' }, 404);
    }
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = asRecord(raw);
    const formId = body?.formId;
    const lineAccountId = body?.lineAccountId;
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!validIdentifier(formId) || !validIdentifier(lineAccountId)) {
      return c.json({ success: false, code: 'invalid_request', error: 'フォームとLINEアカウントを選んでください' }, 400);
    }
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      return c.json({ success: false, code: 'invalid_prompt', error: '質問は1〜2000文字で入力してください' }, 400);
    }

    const lineAccount = await deps.getLineAccount(c.env.DB, lineAccountId);
    if (!activeLineAccount(lineAccount)) {
      return c.json({ success: false, code: 'account_not_found', error: 'LINEアカウントが見つかりません' }, 404);
    }
    const form = await deps.getForm(c.env.DB, formId);
    if (!formInAccount(form, lineAccountId)) {
      return c.json({ success: false, code: 'form_not_found', error: 'フォームが見つかりません' }, 404);
    }
    if (!form!.formaloo_slug) {
      return c.json({ success: false, code: 'form_not_linked', error: '先にフォームを Formaloo へ保存してください' }, 409);
    }

    const contractResult = deps.loadContract(env);
    if (!contractResult.ok) {
      return c.json({ success: false, code: contractResult.code, error: contractResult.message }, 503);
    }
    const client = await deps.resolveClient(c.env, form!.workspace_id);
    if (!client) {
      return c.json({ success: false, code: 'formaloo_unavailable', error: 'Formaloo 接続を確認してください' }, 503);
    }

    const pending = await deps.reserveHistory(c.env.DB, {
      tenantScope: deps.tenantScope(env),
      lineAccountId,
      formId,
      question: prompt,
      dailyLimit: dailyLimit(env),
      now: deps.now(),
    });
    if (!pending) {
      const analysisInProgress = await deps.hasPendingHistory(c.env.DB, {
        tenantScope: deps.tenantScope(env), lineAccountId, formId,
      });
      if (analysisInProgress) {
        return c.json({
          success: false,
          code: 'analysis_in_progress',
          error: 'このフォームは分析中です。回答が表示されるまでお待ちください',
        }, 409);
      }
      return c.json({
        success: false,
        code: 'daily_limit_reached',
        error: '本日のAI分析上限に達しました。明日以降にもう一度お試しください',
      }, 429);
    }

    let outcome: FormalooAiProviderOutcome;
    try {
      outcome = await deps.analyze(deps.deadlineClient(client), contractResult.contract, {
        formSlug: form!.formaloo_slug,
        prompt,
      });
    } catch {
      const code = 'provider_unknown_failure';
      const message = 'Formaloo から回答を受け取れませんでした。連続実行せず、管理者に確認してください';
      await deps.failHistory(c.env.DB, pending.id, {
        errorCode: code,
        errorMessage: message,
        // The request may already have reached Formaloo, so retain the daily reservation.
        creditsConsumed: true,
        providerStatus: 'unknown',
        now: deps.now(),
      });
      return c.json({ success: false, code, error: message }, 502);
    }
    if (!outcome.ok) {
      await deps.failHistory(c.env.DB, pending.id, {
        errorCode: outcome.code,
        errorMessage: outcome.message,
        creditsConsumed: outcome.creditsConsumed,
        providerStatus: outcome.providerStatus,
        analysisSlug: outcome.analysisSlug,
        now: deps.now(),
      });
      return c.json({ success: false, code: outcome.code, error: outcome.message }, outcome.httpStatus);
    }

    const saved = await deps.completeHistory(c.env.DB, pending.id, {
      analysisSlug: outcome.slug,
      answer: outcome.result,
      answerText: outcome.answerText,
      providerStatus: outcome.providerStatus,
      now: deps.now(),
    });
    if (!saved) {
      return c.json({ success: false, code: 'history_write_failed', error: '回答の保存に失敗しました' }, 500);
    }
    return c.json({ success: true, data: saved });
  });

  routes.get('/api/forms-advanced/ai-chat/history', async (c) => {
    const env = c.env as AiChatBindings;
    if (!enabled(env)) {
      return c.json({ success: false, code: 'ai_chat_disabled', error: 'AIチャットは現在オフです' }, 404);
    }
    const formId = c.req.query('formId');
    const lineAccountId = c.req.query('lineAccountId');
    if (!validIdentifier(formId) || !validIdentifier(lineAccountId)) {
      return c.json({ success: false, code: 'invalid_request', error: 'フォームとLINEアカウントを選んでください' }, 400);
    }
    const lineAccount = await deps.getLineAccount(c.env.DB, lineAccountId);
    if (!activeLineAccount(lineAccount)) {
      return c.json({ success: false, code: 'account_not_found', error: 'LINEアカウントが見つかりません' }, 404);
    }
    const form = await deps.getForm(c.env.DB, formId);
    if (!formInAccount(form, lineAccountId)) {
      return c.json({ success: false, code: 'form_not_found', error: 'フォームが見つかりません' }, 404);
    }
    const rawLimit = Number(c.req.query('limit'));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const items = await deps.listHistory(c.env.DB, {
      tenantScope: deps.tenantScope(env), lineAccountId, formId, limit,
    });
    return c.json({ success: true, data: { items } });
  });

  return routes;
}

export const formalooAiChat = createFormalooAiChatRoutes();
