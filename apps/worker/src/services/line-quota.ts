export type LineQuotaType = 'none' | 'limited';

export interface LineQuotaSnapshot {
  plan_label: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  type: LineQuotaType;
}

export type LineQuotaResult = LineQuotaSnapshot & {
  stale?: true;
  message?: string;
};

/**
 * LINE公式アカウントの現行無料メッセージ数から推定するラベル。
 * API 自体はプラン名を返さないため、料金改定時はこの定数だけを更新する。
 */
export const LINE_PLAN_LABEL_BY_LIMIT: Readonly<Record<number, string>> = Object.freeze({
  200: 'コミュニケーションプラン相当（推定）',
  5000: 'ライトプラン相当（推定）',
  30000: 'スタンダードプラン相当（推定）',
});

export const LINE_QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

const QUOTA_URL = 'https://api.line.me/v2/bot/message/quota';
const CONSUMPTION_URL = 'https://api.line.me/v2/bot/message/quota/consumption';
const STALE_MESSAGE = 'LINEの送信数を取得できませんでした。前回の情報を表示しています。';

interface CacheEntry {
  value: LineQuotaSnapshot;
  expiresAt: number;
}

const quotaCache = new Map<string, CacheEntry>();

function inferredPlanLabel(type: LineQuotaType, limit: number | null): string {
  if (type === 'none') return '無制限（プラン名は推定できません）';
  return LINE_PLAN_LABEL_BY_LIMIT[limit ?? -1] ?? 'スタンダードプラン相当（推定）';
}

async function fetchLineJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('LINE quota request failed');
  return response.json<T>();
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 1 account = 1 cache entry。期限切れの値も失敗時 fallback 用に保持する。
 */
export async function getLineQuota(accountId: string, accessToken: string): Promise<LineQuotaResult> {
  const now = Date.now();
  const previous = quotaCache.get(accountId);
  if (previous && previous.expiresAt > now) return previous.value;

  try {
    const [quota, consumption] = await Promise.all([
      fetchLineJson<{ type?: unknown; value?: unknown }>(QUOTA_URL, accessToken),
      fetchLineJson<{ totalUsage?: unknown }>(CONSUMPTION_URL, accessToken),
    ]);

    if (quota.type !== 'none' && quota.type !== 'limited') {
      throw new Error('Invalid LINE quota type');
    }
    if (!finiteNonNegativeInteger(consumption.totalUsage)) {
      throw new Error('Invalid LINE quota consumption');
    }

    const type = quota.type;
    const limit = type === 'none'
      ? null
      : finiteNonNegativeInteger(quota.value)
        ? quota.value
        : null;
    if (type === 'limited' && limit === null) {
      throw new Error('Invalid LINE quota value');
    }

    const value: LineQuotaSnapshot = {
      plan_label: inferredPlanLabel(type, limit),
      limit,
      used: consumption.totalUsage,
      remaining: limit === null ? null : Math.max(0, limit - consumption.totalUsage),
      type,
    };
    quotaCache.set(accountId, { value, expiresAt: now + LINE_QUOTA_CACHE_TTL_MS });
    return value;
  } catch (error) {
    if (previous) {
      return { ...previous.value, stale: true, message: STALE_MESSAGE };
    }
    throw error;
  }
}
