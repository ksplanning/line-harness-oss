import {
  toFormalooFormUpdateRequest,
  type FormalooFormUpdateRequest,
  type FormOperationsSettingsPatch,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

type ManagedFormalooOperationKey =
  | 'has_recaptcha'
  | 'accept_draft_answers'
  | 'max_submit_count'
  | 'submit_start_time'
  | 'submit_end_time';

const MANAGED_KEYS: readonly ManagedFormalooOperationKey[] = [
  'has_recaptcha',
  'accept_draft_answers',
  'max_submit_count',
  'submit_start_time',
  'submit_end_time',
];

function extractForm(root: unknown): Record<string, unknown> {
  const value = (root ?? {}) as Record<string, any>;
  return (value?.data?.form ?? value?.data ?? value?.form ?? {}) as Record<string, unknown>;
}

function datesEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expected);
  return Number.isFinite(actualMs) && Number.isFinite(expectedMs) && actualMs === expectedMs;
}

function reflected(actual: unknown, expected: unknown, key: ManagedFormalooOperationKey): boolean {
  if ((key === 'submit_start_time' || key === 'submit_end_time') && typeof expected === 'string') {
    return datesEqual(actual, expected);
  }
  return actual === expected;
}

/** present な管理5項目だけを PATCH body へ変換する。UTM intent と未知 key は含めない。 */
export function formOperationsFields(patch: FormOperationsSettingsPatch): FormalooFormUpdateRequest {
  return toFormalooFormUpdateRequest(patch);
}

export interface FormOperationsReflectionResult {
  ok: boolean;
  error?: string;
}

/**
 * PATCH 200 を成功根拠にせず、独立 GET の `data.form.*` が送信値と一致するまで bounded 確認する。
 * 確認対象が無い（UTMだけ等）場合は GET せず成功する。
 */
export async function confirmFormOperationsReflected(
  client: FormalooClient,
  formalooSlug: string,
  patch: FormOperationsSettingsPatch,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<FormOperationsReflectionResult> {
  const expected = formOperationsFields(patch) as Record<ManagedFormalooOperationKey, unknown>;
  const wanted = MANAGED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(expected, key));
  if (wanted.length === 0) return { ok: true };

  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastMiss = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (result.ok) {
      const form = extractForm(result.data);
      lastMiss = wanted.find((key) => !reflected(form[key], expected[key], key)) ?? '';
      if (!lastMiss) return { ok: true };
    } else {
      lastMiss = `HTTP ${result.status}`;
    }
    if (attempt < retries) await sleep(100 * (attempt + 1));
  }
  return {
    ok: false,
    error: `運用制御が Formaloo に反映されませんでした（${lastMiss || '確認に失敗しました'}）`,
  };
}
