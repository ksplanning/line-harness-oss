import type { EmailSenderDnsRecord } from '@line-crm/db';

const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';

export interface ResendDomainsEnv {
  RESEND_API_KEY?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records: EmailSenderDnsRecord[];
}

export type ResendDomainResult =
  | { ok: true; domain: ResendDomain }
  | { ok: false; error: string };

export type ResendDomainActionResult =
  | { ok: true }
  | { ok: false; error: string };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function publicRecord(value: unknown): EmailSenderDnsRecord | null {
  const row = objectValue(value);
  if (!row) return null;
  const type = nonEmptyString(row.type);
  const name = nonEmptyString(row.name);
  const recordValue = nonEmptyString(row.value);
  if (!type || !name || !recordValue) return null;

  const priority = typeof row.priority === 'number' && Number.isFinite(row.priority)
    ? row.priority
    : null;
  const ttl = typeof row.ttl === 'number' && Number.isFinite(row.ttl)
    ? String(row.ttl)
    : nonEmptyString(row.ttl);

  return {
    record: nonEmptyString(row.record),
    type,
    name,
    value: recordValue,
    ttl,
    status: nonEmptyString(row.status),
    priority,
  };
}

function providerDomain(value: unknown): ResendDomain | null {
  const row = objectValue(value);
  if (!row) return null;
  const id = nonEmptyString(row.id);
  const name = nonEmptyString(row.name);
  const status = nonEmptyString(row.status);
  if (!id || !name || !status || !Array.isArray(row.records)) return null;

  const records = row.records.map(publicRecord);
  if (records.some((record) => record === null)) return null;
  return {
    id,
    name: name.toLowerCase(),
    status: status.toLowerCase(),
    records: records as EmailSenderDnsRecord[],
  };
}

function apiKey(env: ResendDomainsEnv): string | null {
  return env.RESEND_API_KEY?.trim() || null;
}

function headers(key: string): HeadersInit {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function providerErrorCode(response: Response): Promise<string> {
  const fallback = `resend_domains_http_${response.status}`;
  const body = objectValue(await response.json().catch(() => null));
  const name = nonEmptyString(body?.name)?.toLowerCase() ?? '';
  const message = nonEmptyString(body?.message)?.toLowerCase() ?? '';

  if (
    response.status === 403
    && message.includes('plan includes')
    && message.includes('domain')
  ) {
    return 'resend_domains_plan_limit';
  }
  if (
    response.status === 401
    || (
      response.status === 403
      && (
        ['invalid_api_key', 'missing_api_key', 'restricted_api_key'].includes(name)
        || (message.includes('api key') && /invalid|restricted|unauthori[sz]ed/.test(message))
      )
    )
  ) {
    return 'resend_domains_auth_error';
  }
  if (
    [400, 422].includes(response.status)
    && (
      message.includes('valid domain')
      || (
        message.includes('domain')
        && /invalid|format|malformed/.test(message)
      )
    )
  ) {
    return 'resend_domains_invalid_domain';
  }
  return fallback;
}

async function readDomainResponse(response: Response): Promise<ResendDomainResult> {
  if (!response.ok) return { ok: false, error: await providerErrorCode(response) };
  const body = await response.json().catch(() => null);
  const domain = providerDomain(body);
  return domain
    ? { ok: true, domain }
    : { ok: false, error: 'resend_domains_invalid_response' };
}

export async function registerResendDomain(
  env: ResendDomainsEnv,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendDomainResult> {
  const key = apiKey(env);
  if (!key) return { ok: false, error: 'missing_api_key' };

  try {
    const response = await fetcher(RESEND_DOMAINS_URL, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ name: domain }),
    });
    return readDomainResponse(response);
  } catch {
    return { ok: false, error: 'resend_domains_network_error' };
  }
}

export async function startResendDomainVerification(
  env: ResendDomainsEnv,
  domainId: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendDomainActionResult> {
  const key = apiKey(env);
  if (!key) return { ok: false, error: 'missing_api_key' };
  const url = `${RESEND_DOMAINS_URL}/${encodeURIComponent(domainId)}`;

  try {
    const response = await fetcher(`${url}/verify`, {
      method: 'POST',
      headers: headers(key),
    });
    if (!response.ok) {
      return { ok: false, error: await providerErrorCode(response) };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'resend_domains_network_error' };
  }
}

export async function getResendDomain(
  env: ResendDomainsEnv,
  domainId: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendDomainResult> {
  const key = apiKey(env);
  if (!key) return { ok: false, error: 'missing_api_key' };
  const url = `${RESEND_DOMAINS_URL}/${encodeURIComponent(domainId)}`;

  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: headers(key),
    });
    return readDomainResponse(response);
  } catch {
    return { ok: false, error: 'resend_domains_network_error' };
  }
}
