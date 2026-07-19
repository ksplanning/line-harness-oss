/**
 * T-A1 (F-1) — Formaloo API クライアント。
 *   - auth token 30s TTL per-isolate in-memory cache (§8 / N-1)
 *   - x-api-key + Authorization: JWT レシピ (§15 実機 200 確認済)
 *   - 401 時 1 回だけ token 再取得 (bounded / 無限ループ禁止)
 *   - rate-limit (429) backoff (bounded = Workers subrequest 上限を静的 cap で符号化 / 地雷#2)
 *   - fail-soft: 障害時は throw せず構造化 result を返す (N-6)
 *   - token 永続化しない (in-memory Map のみ / M-23)
 *
 * 地雷#3: @cloudflare/vite-plugin は 401 を "fetch failed"/500 化する。本 test は fetchImpl を
 *   注入する純ユニットなので vite-plugin を経由しない (worker vitest は environment:node)。
 * token 抽出は res.json() (JSON parse) — rtk jq を使わない (§15.2 教訓 / 地雷#1)。
 */
import { describe, test, expect } from 'vitest';
import { FormalooClient, FORMALOO_TOKEN_TTL_MS, FORMALOO_MAX_RATE_LIMIT_RETRIES } from './formaloo-client';

const KEY = 'test-api-key';
const SECRET = 'test-api-secret';

function tokenRes(token = 'TKN', status = 200): Response {
  return new Response(JSON.stringify({ authorization_token: token }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Script {
  token?: Array<() => Response>;
  api?: Array<() => Response | Promise<Response>>;
}
function makeMockFetch(script: Script) {
  const calls = { token: [] as RequestInit[], api: [] as { url: string; init: RequestInit }[] };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('authorization-token')) {
      calls.token.push(init ?? {});
      const next = script.token?.shift();
      return next ? next() : tokenRes();
    }
    calls.api.push({ url: u, init: init ?? {} });
    const next = script.api?.shift();
    return next ? await next() : jsonRes({ status: true, data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(script: Script, opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const { fetchImpl, calls } = makeMockFetch(script);
  const sleeps: number[] = [];
  const client = new FormalooClient({
    apiKey: KEY,
    apiSecret: SECRET,
    baseUrl: 'https://api.formaloo.net',
    fetchImpl,
    now: opts.now,
    sleep: opts.sleep ?? (async (ms: number) => { sleeps.push(ms); }),
    cache: new Map(),
  });
  return { client, calls, sleeps };
}

describe('FormalooClient — auth token cache (N-1)', () => {
  test('token を 1 回取得しキャッシュ (TTL 内は再取得しない)', async () => {
    const { client, calls } = makeClient({ api: [() => jsonRes({ status: true, data: { a: 1 } }), () => jsonRes({ status: true, data: { b: 2 } })] });
    await client.get('/v3.0/forms/');
    await client.get('/v3.0/forms/');
    expect(calls.token.length).toBe(1); // TTL 内 = token 1 回のみ
    expect(calls.api.length).toBe(2);
  });

  test('TTL(30s) 経過後は token を再取得', async () => {
    let t = 1_000_000;
    const { client, calls } = makeClient(
      { api: [() => jsonRes({ status: true, data: {} }), () => jsonRes({ status: true, data: {} })] },
      { now: () => t },
    );
    await client.get('/v3.0/forms/');
    t += FORMALOO_TOKEN_TTL_MS + 1; // TTL 超過
    await client.get('/v3.0/forms/');
    expect(calls.token.length).toBe(2);
  });

  test('TTL は 30 秒 (安全側 cap)', () => {
    expect(FORMALOO_TOKEN_TTL_MS).toBe(30_000);
  });
});

describe('FormalooClient — 認証レシピ (§15 実機 200)', () => {
  test('token 取得は Basic SECRET + x-api-key + grant_type=client_credentials', async () => {
    const { client, calls } = makeClient({ api: [() => jsonRes({ status: true, data: {} })] });
    await client.get('/v3.0/forms/');
    const h = new Headers(calls.token[0].headers);
    expect(h.get('authorization')).toBe(`Basic ${SECRET}`);
    expect(h.get('x-api-key')).toBe(KEY);
    expect(String(calls.token[0].body)).toContain('grant_type=client_credentials');
  });

  test('API 呼び出しは Authorization: JWT <token> + x-api-key (Bearer 不可)', async () => {
    const { client, calls } = makeClient({ token: [() => tokenRes('JWT-XYZ')], api: [() => jsonRes({ status: true, data: {} })] });
    await client.get('/v3.0/forms/');
    const h = new Headers(calls.api[0].init.headers);
    expect(h.get('authorization')).toBe('JWT JWT-XYZ');
    expect(h.get('x-api-key')).toBe(KEY);
  });
});

describe('FormalooClient — patch (弾M form-post-edit / row 部分更新)', () => {
  test('patch は PATCH メソッド + JSON body で送る (flat slug body)', async () => {
    const { client, calls } = makeClient({ api: [() => jsonRes({ status: true, data: { nameSlug: '山田' } })] });
    const r = await client.patch('/v3.0/rows/ROW1/', { nameSlug: '山田' });
    expect(r.ok).toBe(true);
    expect(calls.api[0].init.method).toBe('PATCH');
    expect(String(calls.api[0].init.body)).toBe(JSON.stringify({ nameSlug: '山田' }));
  });
});

describe('FormalooClient — 401 リトライ (bounded)', () => {
  test('401 で token を 1 回だけ再取得しリトライ成功', async () => {
    const { client, calls } = makeClient({
      token: [() => tokenRes('OLD'), () => tokenRes('NEW')],
      api: [() => jsonRes({ general_errors: ['Error decoding signature.'] }, 401), () => jsonRes({ status: true, data: { ok: 1 } })],
    });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(true);
    expect(calls.token.length).toBe(2); // 初回 + 401 後の再取得
    expect(calls.api.length).toBe(2);
    const h = new Headers(calls.api[1].init.headers);
    expect(h.get('authorization')).toBe('JWT NEW'); // 再取得した token で再送
  });

  test('401 が 2 回連続なら 1 回だけ再取得して諦める (無限ループ禁止 = fail-soft)', async () => {
    const { client, calls } = makeClient({
      token: [() => tokenRes('OLD'), () => tokenRes('NEW')],
      api: [() => jsonRes({}, 401), () => jsonRes({}, 401)],
    });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(calls.token.length).toBe(2); // 再取得は 1 回のみ (bounded)
    expect(calls.api.length).toBe(2);
  });
});

describe('FormalooClient — rate-limit backoff (bounded / 地雷#2)', () => {
  test('429 で backoff しリトライ成功 (sleep 呼び出し)', async () => {
    const { client, calls, sleeps } = makeClient({
      api: [() => jsonRes({}, 429, { 'retry-after': '1' }), () => jsonRes({}, 429), () => jsonRes({ status: true, data: {} })],
    });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(true);
    expect(calls.api.length).toBe(3);
    expect(sleeps.length).toBe(2); // 429 x2 → backoff x2
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  test('429 が上限まで続くと諦める (静的 cap で bound / subrequest 上限保護)', async () => {
    const alwaysThrottled = Array.from({ length: 10 }, () => () => jsonRes({}, 429));
    const { client, calls } = makeClient({ api: alwaysThrottled });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    // 初回 + 最大 retry 回数 = bounded (無限リトライ禁止)
    expect(calls.api.length).toBe(FORMALOO_MAX_RATE_LIMIT_RETRIES + 1);
  });

  test('MAX_RATE_LIMIT_RETRIES は小さい有限値 (Workers subrequest 上限を符号化)', () => {
    expect(FORMALOO_MAX_RATE_LIMIT_RETRIES).toBeGreaterThan(0);
    expect(FORMALOO_MAX_RATE_LIMIT_RETRIES).toBeLessThanOrEqual(5);
  });
});

describe('FormalooClient — operation deadline', () => {
  test('withDeadline は停止した API fetch を AbortSignal で中断して fail-soft に返す', async () => {
    let seenSignal: AbortSignal | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('authorization-token')) return tokenRes();
      seenSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        seenSignal?.addEventListener('abort', () => reject(seenSignal?.reason), { once: true });
      });
    }) as typeof fetch;
    const client = new FormalooClient({
      apiKey: KEY,
      apiSecret: SECRET,
      fetchImpl,
      cache: new Map(),
    });

    const result = await client.withDeadline(10).get('/v3.0/forms/');
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(seenSignal?.aborted).toBe(true);
  });

  test('parent attempt の abort も deadline client の API fetch へ伝播する', async () => {
    const parent = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('authorization-token')) return tokenRes();
      started();
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const client = new FormalooClient({
      apiKey: KEY,
      apiSecret: SECRET,
      fetchImpl,
      cache: new Map(),
    });

    const pending = client.withDeadline(10_000, parent.signal).get('/v3.0/forms/');
    await fetchStarted;
    parent.abort(new Error('attempt expired'));
    await expect(pending).resolves.toMatchObject({ ok: false, status: 0, error: 'attempt expired' });
  });
});

describe('FormalooClient — fail-soft (N-6)', () => {
  test('ネットワーク例外は throw せず {ok:false} を返す', async () => {
    const { client } = makeClient({ api: [async () => { throw new Error('network down'); }] });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.ok === false && r.error).toContain('network down');
  });

  test('5xx も throw せず fail-soft', async () => {
    const { client } = makeClient({ api: [() => jsonRes({}, 503)] });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test('token 取得失敗 (auth 500) も fail-soft', async () => {
    const { client } = makeClient({ token: [() => tokenRes('', 500)] });
    const r = await client.get('/v3.0/forms/');
    expect(r.ok).toBe(false);
  });
});

describe('FormalooClient — token 永続化しない (M-23)', () => {
  test('cache は注入された in-memory Map のみ (外部ストレージ非依存)', async () => {
    const cache = new Map<string, { token: string; expiresAt: number }>();
    const { fetchImpl } = makeMockFetch({ api: [() => jsonRes({ status: true, data: {} })] });
    const client = new FormalooClient({ apiKey: KEY, apiSecret: SECRET, fetchImpl, cache });
    await client.get('/v3.0/forms/');
    expect(cache.size).toBe(1); // token は Map に載る (KV/D1 書き込みなし)
    expect([...cache.values()][0].token).toBeTruthy();
  });
});

describe('FormalooClient — requestForm (multipart / form-design 画像 upload)', () => {
  test('FormData body を送り Content-Type: application/json を付けない (boundary は fetch 任せ)', async () => {
    const { client, calls } = makeClient({ api: [() => jsonRes({ status: true, data: { form: { logo: 'https://s3/x.png' } } })] });
    const form = new FormData();
    form.append('logo', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'l.png');
    const r = await client.requestForm('PATCH', '/v3.0/forms/abc/', form);
    expect(r.ok).toBe(true);
    expect(r.ok === true && (r.data as { data: { form: { logo: string } } }).data.form.logo).toBe('https://s3/x.png');
    expect(calls.api[0].init.body).toBeInstanceOf(FormData); // JSON.stringify されていない
    const h = new Headers(calls.api[0].init.headers);
    expect(h.get('content-type')).toBeNull(); // multipart boundary を潰さない
    expect(h.get('authorization')).toBe('JWT TKN');
    expect(h.get('x-api-key')).toBe(KEY);
  });

  test('401 で token を 1 回再取得しリトライ (既存 JSON 経路と同じ bounded ガード)', async () => {
    const { client, calls } = makeClient({
      token: [() => tokenRes('OLD'), () => tokenRes('NEW')],
      api: [() => jsonRes({}, 401), () => jsonRes({ status: true, data: { form: {} } })],
    });
    const form = new FormData();
    form.append('background_image', new Blob([new Uint8Array([9])], { type: 'image/png' }), 'b.png');
    const r = await client.requestForm('PATCH', '/v3.0/forms/abc/', form);
    expect(r.ok).toBe(true);
    expect(calls.token.length).toBe(2);
    expect(new Headers(calls.api[1].init.headers).get('authorization')).toBe('JWT NEW');
  });

  test('ネットワーク例外は fail-soft (throw しない / N-6)', async () => {
    const { client } = makeClient({ api: [async () => { throw new Error('mp boom'); }] });
    const r = await client.requestForm('PATCH', '/v3.0/forms/abc/', new FormData());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});
