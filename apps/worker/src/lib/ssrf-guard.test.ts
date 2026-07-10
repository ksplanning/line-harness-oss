/**
 * T-C2 (Phase B B-3) — SSRF ガードの機械検証 (resolve/fetchImpl 注入で network なし)。
 * spec §3 の攻撃ベクタを fixture 群で網羅: literal-IP エンコード (10/16/8進・短縮・mapped/6to4/NAT64)、
 * hostname denylist、port 制限、redirect→内部、DNS rebinding (hop 再検証)、content-type/size/deadline、
 * DoH 成功判定 fail-closed。default-deny (IANA globally-reachable) を正当 public host の通過で確認。
 */
import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  normalizeToIp,
  isGloballyReachable,
  isBlockedHostname,
  assertSchemeAndHostAndPort,
  assertUrlSafe,
  safeFetch,
  resolveViaDoh,
  SsrfBlockedError,
} from './ssrf-guard.js';

const ac = () => new AbortController().signal;
const constResolve = (ips: string[]) => async () => ips;

describe('normalizeToIp — literal-IP エンコード正規化', () => {
  test('dotted / 10進 / 16進 / 8進 / 短縮 IPv4 を実 IP に', () => {
    expect(normalizeToIp('127.0.0.1')).toEqual({ family: 4, ip: '127.0.0.1' });
    expect(normalizeToIp('2130706433')).toEqual({ family: 4, ip: '127.0.0.1' }); // 10進
    expect(normalizeToIp('0x7f000001')).toEqual({ family: 4, ip: '127.0.0.1' }); // 16進
    expect(normalizeToIp('0177.0.0.1')).toEqual({ family: 4, ip: '127.0.0.1' }); // 8進
    expect(normalizeToIp('127.1')).toEqual({ family: 4, ip: '127.0.0.1' }); // 短縮
  });
  test('IPv4-mapped / 6to4 / NAT64 を内側 v4 に unwrap', () => {
    expect(normalizeToIp('[::ffff:169.254.169.254]')).toEqual({ family: 4, ip: '169.254.169.254' });
    expect(normalizeToIp('::ffff:a9fe:a9fe')).toEqual({ family: 4, ip: '169.254.169.254' });
    expect(normalizeToIp('2002:c0a8:0101::')).toEqual({ family: 4, ip: '192.168.1.1' }); // 6to4
    expect(normalizeToIp('64:ff9b::a9fe:a9fe')).toEqual({ family: 4, ip: '169.254.169.254' }); // NAT64 wellknown
    expect(normalizeToIp('64:ff9b:1::0a00:0001')).toEqual({ family: 4, ip: '10.0.0.1' }); // NAT64 local
  });
  test('真の IPv6 は family 6 / ドメインは null (=DNS 要)', () => {
    expect(normalizeToIp('::1')?.family).toBe(6);
    expect(normalizeToIp('2606:4700:4700::1111')?.family).toBe(6);
    expect(normalizeToIp('example.com')).toBeNull();
    expect(normalizeToIp('not-an-ip')).toBeNull();
  });
});

describe('isGloballyReachable — default-deny (IANA globally-reachable)', () => {
  test.each([
    ['0.0.0.0', 4], ['10.0.0.1', 4], ['100.64.0.1', 4], ['127.0.0.1', 4], ['169.254.169.254', 4],
    ['172.16.0.1', 4], ['192.0.0.1', 4], ['192.0.2.1', 4], ['192.88.99.1', 4], ['192.168.1.1', 4],
    ['198.18.0.1', 4], ['198.51.100.1', 4], ['203.0.113.1', 4], ['224.0.0.1', 4], ['255.255.255.255', 4],
  ] as const)('private/reserved %s は遮断', (ip, fam) => {
    expect(isGloballyReachable(ip, fam)).toBe(false);
  });
  test.each([
    ['8.8.8.8', 4], ['93.184.216.34', 4], ['1.1.1.1', 4],
  ] as const)('public %s は通過', (ip, fam) => {
    expect(isGloballyReachable(ip, fam)).toBe(true);
  });
  test('IPv6: ループバック/ULA/link-local/doc は遮断・global unicast は通過', () => {
    expect(isGloballyReachable('0000:0000:0000:0000:0000:0000:0000:0001', 6)).toBe(false); // ::1
    expect(isGloballyReachable('fc00:0000:0000:0000:0000:0000:0000:0001', 6)).toBe(false); // ULA
    expect(isGloballyReachable('fe80:0000:0000:0000:0000:0000:0000:0001', 6)).toBe(false); // link-local
    expect(isGloballyReachable('2001:0db8:0000:0000:0000:0000:0000:0001', 6)).toBe(false); // doc
    expect(isGloballyReachable('2606:4700:4700:0000:0000:0000:0000:1111', 6)).toBe(true); // Cloudflare public
  });
});

describe('isBlockedHostname', () => {
  test('localhost / .internal / .local / metadata / 末尾ドット を遮断', () => {
    for (const h of ['localhost', 'foo.localhost', 'db.internal', 'printer.local', 'metadata.google.internal', 'metadata', 'example.com.', 'localhost.']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });
  test('通常の公開ドメインは通す', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('shop.example.co.jp')).toBe(false);
  });
});

describe('assertSchemeAndHostAndPort', () => {
  test('http/https 以外の scheme を遮断', () => {
    expect(assertSchemeAndHostAndPort('ftp://example.com/')).toEqual({ blocked: 'scheme:ftp:' });
    expect(assertSchemeAndHostAndPort('file:///etc/passwd')).toHaveProperty('blocked');
  });
  test('port 80/443/空 のみ許可', () => {
    expect(assertSchemeAndHostAndPort('http://public.example:8080/')).toEqual({ blocked: 'port:8080' });
    expect(assertSchemeAndHostAndPort('http://example.com/')).toHaveProperty('url');
    expect(assertSchemeAndHostAndPort('http://example.com:80/')).toHaveProperty('url');
    expect(assertSchemeAndHostAndPort('https://example.com:443/')).toHaveProperty('url');
  });
  test('literal private IP を default-deny', () => {
    expect(assertSchemeAndHostAndPort('http://10.0.0.1/')).toHaveProperty('blocked');
    expect(assertSchemeAndHostAndPort('http://2130706433/')).toHaveProperty('blocked'); // 10進 127.0.0.1
  });
});

// ── SSRF URL fixture 群: 全て SsrfBlockedError で throw (literal/denylist は resolve 未使用) ──
const BLOCKED_FIXTURES = [
  'http://localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://169.254.169.254/',
  'http://10.0.0.1/', 'http://192.168.1.1/', 'http://192.88.99.1/', 'http://[::1]/',
  'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://2130706433/',
  'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://example.com./', 'http://public.example:8080/',
  'ftp://example.com/',
];

describe('assertUrlSafe — SSRF fixture は全て throw / 正当 public は通過', () => {
  test.each(BLOCKED_FIXTURES)('%s は SsrfBlockedError', async (u) => {
    // resolve は public を返すが literal-IP/denylist/scheme/port は resolve 前に throw する。
    await expect(assertUrlSafe(u, { resolve: constResolve(['93.184.216.34']), signal: ac() })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  test('ドメインが private に解決したら遮断 (DNS 後 IP 検証)', async () => {
    await expect(assertUrlSafe('http://evil.example/', { resolve: constResolve(['10.0.0.1']), signal: ac() })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  test('DNS 空 Answer は遮断 (fail-closed)', async () => {
    await expect(assertUrlSafe('http://evil.example/', { resolve: constResolve([]), signal: ac() })).rejects.toThrow(/dns-empty/);
  });
  test('複数解決の 1 つでも private なら遮断', async () => {
    await expect(assertUrlSafe('http://mixed.example/', { resolve: constResolve(['93.184.216.34', '169.254.169.254']), signal: ac() })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  test('正当 public host (80/443) は通過', async () => {
    await expect(assertUrlSafe('http://good.example/', { resolve: constResolve(['93.184.216.34']), signal: ac() })).resolves.toBeInstanceOf(URL);
    await expect(assertUrlSafe('https://good.example/', { resolve: constResolve(['93.184.216.34']), signal: ac() })).resolves.toBeInstanceOf(URL);
  });
});

function resp(status: number, headers: Record<string, string>, body: string | null = null): Response {
  return new Response(body, { status, headers });
}

describe('safeFetch — redirect / rebinding / content-type / size / deadline', () => {
  test('正当 public host の 2xx text/html を取得', async () => {
    const fetchImpl = vi.fn(async () => resp(200, { 'content-type': 'text/html; charset=utf-8' }, '<p>hi</p>')) as unknown as typeof fetch;
    const r = await safeFetch('http://good.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl });
    expect(r.contentType).toBe('text/html');
    expect(r.text).toContain('<p>hi</p>');
  });

  test('redirect→内部IP を hop で遮断 (302 Location http://10.0.0.1/)', async () => {
    const fetchImpl = vi.fn(async () => resp(302, { location: 'http://10.0.0.1/' })) as unknown as typeof fetch;
    await expect(safeFetch('http://evil.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('DNS rebinding: hop ごと再解決で public→private を遮断', async () => {
    let call = 0;
    const resolve = async () => (call++ === 0 ? ['93.184.216.34'] : ['10.0.0.1']);
    // hop0 は 302 で同 host の別 path へ → hop1 の再解決が private を引き遮断。
    const fetchImpl = vi.fn(async () => resp(302, { location: 'http://rebind.example/next' })) as unknown as typeof fetch;
    await expect(safeFetch('http://rebind.example/', { resolve, fetchImpl })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(call).toBeGreaterThanOrEqual(2); // 2 回解決 = hop 再検証が働いた
  });

  test('content-type allowlist 外 (application/pdf) を遮断', async () => {
    const fetchImpl = vi.fn(async () => resp(200, { 'content-type': 'application/pdf' }, '%PDF')) as unknown as typeof fetch;
    await expect(safeFetch('http://good.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl })).rejects.toThrow(/content-type/);
  });

  test('Content-Length 詐称なしの size 超過を stream 計数で遮断', async () => {
    const big = 'a'.repeat(5000);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(safeFetch('http://good.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl, maxBytes: 1000 })).rejects.toThrow(/too-large/);
  });

  test('Content-Length ヘッダ超過を事前遮断', async () => {
    const fetchImpl = vi.fn(async () => resp(200, { 'content-type': 'text/html', 'content-length': '9999999' }, 'x')) as unknown as typeof fetch;
    await expect(safeFetch('http://good.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl, maxBytes: 1000 })).rejects.toThrow(/too-large-header/);
  });

  test('全体 deadline 超過を遮断 (単一 AbortController)', async () => {
    const fetchImpl = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(safeFetch('http://slow.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl, deadlineMs: 5 })).rejects.toThrow(/deadline/);
  });

  test('redirect ループ上限を遮断', async () => {
    const fetchImpl = vi.fn(async () => resp(302, { location: 'http://good.example/loop' })) as unknown as typeof fetch;
    await expect(safeFetch('http://good.example/', { resolve: constResolve(['93.184.216.34']), fetchImpl, maxRedirects: 1 })).rejects.toThrow(/too-many-redirects/);
  });
});

describe('resolveViaDoh — 成功判定契約 (fail-closed / §3-4)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const doh = (payloadByType: Record<'A' | 'AAAA', { status: number; body: unknown }>) =>
    vi.fn(async (url: string) => {
      const type = url.includes('type=AAAA') ? 'AAAA' : 'A';
      const p = payloadByType[type];
      return new Response(typeof p.body === 'string' ? p.body : JSON.stringify(p.body), { status: p.status });
    });

  test('A が Status0+Answer / AAAA 非200 → 片側成功で A の IP を返す', async () => {
    vi.stubGlobal('fetch', doh({ A: { status: 200, body: { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] } }, AAAA: { status: 500, body: '' } }));
    await expect(resolveViaDoh('good.example', ac())).resolves.toEqual(['93.184.216.34']);
  });
  test('両 type 非200 → fail-closed (throw doh-failed)', async () => {
    vi.stubGlobal('fetch', doh({ A: { status: 500, body: '' }, AAAA: { status: 500, body: '' } }));
    await expect(resolveViaDoh('x.example', ac())).rejects.toThrow(/doh-failed/);
  });
  test('DNS Status≠0 (SERVFAIL) 両 type → fail-closed', async () => {
    vi.stubGlobal('fetch', doh({ A: { status: 200, body: { Status: 2 } }, AAAA: { status: 200, body: { Status: 2 } } }));
    await expect(resolveViaDoh('x.example', ac())).rejects.toThrow(/doh-failed/);
  });
  test('malformed JSON 両 type → fail-closed', async () => {
    vi.stubGlobal('fetch', doh({ A: { status: 200, body: 'not json{' }, AAAA: { status: 200, body: 'not json{' } }));
    await expect(resolveViaDoh('x.example', ac())).rejects.toThrow(/doh-failed/);
  });
  test('Status0 だが Answer 空 → [] を返す (呼出側が dns-empty で遮断)', async () => {
    vi.stubGlobal('fetch', doh({ A: { status: 200, body: { Status: 0, Answer: [] } }, AAAA: { status: 200, body: { Status: 0 } } }));
    await expect(resolveViaDoh('empty.example', ac())).resolves.toEqual([]);
  });
});
