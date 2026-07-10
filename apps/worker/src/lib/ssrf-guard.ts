/**
 * Phase B B-3 (T-C2) — SSRF ガード (取込 URL の外部 fetch 専用・新設)。
 *
 * safe-redirect.ts は post-OAuth の scheme denylist で DNS/IP 検証をしない (SSRF 非対応) ため流用不可。
 * 本モジュールが worker で初めて「user 供給 URL の外部 fetch」の攻撃面 (内部 IP・メタデータ到達) を封じる。
 *
 * 設計 (spec §3):
 *  - **default-deny**: IANA special-purpose で globally-reachable な IP だけ通す (未知/予約/private は遮断)。
 *  - literal-IP エンコード正規化: 10/16/8 進・短縮 IPv4・IPv4-mapped/compatible/6to4/NAT64 を実 IP へ。
 *  - hostname denylist (localhost/.internal/.local/末尾ドット) + port 80/443 制限 + http(s) のみ。
 *  - redirect:'manual' で hop ごとに DNS 再解決・再検証 (DNS rebinding 封じ)。
 *  - 単一 AbortController で DNS+全 hop+body に**総**時間 deadline (個別 timeout×N を防ぐ)。
 *  - size / content-type 上限 + DoH 成功判定 fail-closed。
 *  - resolve / fetchImpl を注入可能に = network なしで fixture 機械検証。
 *
 * 残余 TOCTOU (DoH 検証後の fetch 独自再解決) は app 層単独では閉じ切れない → wrangler の
 * `global_fetch_strictly_public` platform backstop (公開 IP 限定 route) と二層で封じる (§3-5)。
 */

// ── リソース上限 (module 定数・後で env 昇格可 / spec §3-6 の 1 契約に統一) ──
export const INGEST_TOTAL_DEADLINE_MS = 8_000; // DNS+全 hop+body の総上限 (単一 signal)
export const INGEST_MAX_BYTES = 2_000_000; // 2MB (Content-Length 事前 check ∧ stream 実バイト計数)
export const INGEST_MAX_REDIRECTS = 5;
export const INGEST_ALLOWED_PORTS = new Set(['', '80', '443']); // scheme default(空) / 80 / 443 のみ
export const INGEST_ALLOWED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

export class SsrfBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly target: string,
  ) {
    super(`SSRF blocked: ${reason} (${target})`);
    this.name = 'SsrfBlockedError';
  }
}

export type NormalizedIp = { family: 4 | 6; ip: string };
export type DnsResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

// =============================================================================
// 純関数 (network 不要・fixture で直接 test)
// =============================================================================

/** IPv4 を任意エンコード (10/16/8 進・1〜4 パート inet_aton) で uint32 に。非 IPv4 は null。 */
function parseV4Any(str: string): number | null {
  if (str.length === 0 || str.includes(':')) return null;
  const parts = str.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.length - 1;
  let addr = 0;
  for (let i = 0; i < last; i += 1) {
    if (nums[i] > 255) return null; // 先頭パートは 1 バイト上限
    addr = addr * 256 + nums[i];
  }
  const remainingBytes = 4 - last;
  const maxLast = remainingBytes === 4 ? 0xffffffff : 2 ** (8 * remainingBytes) - 1;
  if (nums[last] > maxLast) return null;
  addr = addr * 2 ** (8 * remainingBytes) + nums[last];
  if (addr > 0xffffffff) return null;
  return addr;
}

function v4ToString(n: number): string {
  return `${Math.floor(n / 16777216) % 256}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

/** IPv6 テキスト (:: 圧縮 / 末尾 dotted-v4 埋込対応) を 8 個の uint16 group に。非 IPv6 は null。 */
function parseV6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  // 末尾 dotted-v4 埋込 (例 ::ffff:1.2.3.4) を hex 2 group に畳む。
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const oc = tail.split('.');
    if (oc.length !== 4) return null;
    const q = oc.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (q.some((n) => Number.isNaN(n) || n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const x of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(x)) return null;
      out.push(parseInt(x, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 2) {
    const back = toGroups(halves[1]);
    if (back === null) return null;
    const missing = 8 - head.length - back.length;
    if (missing < 1) return null; // "::" は 1 group 以上のゼロを表す
    return [...head, ...Array<number>(missing).fill(0), ...back];
  }
  return head.length === 8 ? head : null;
}

/** IPv6 group から埋込 IPv4 (mapped/6to4/NAT64) を実 IP に unwrap。無ければ null。 */
function extractEmbeddedV4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // IPv4-mapped ::ffff:0:0/96
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return v4(g[6], g[7]);
  // 6to4 2002::/16 (埋込 v4 = bits 16..47) — **2000::/3 内なので unwrap 必須** (§3-3)
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  // NAT64 well-known 64:ff9b::/96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6], g[7]);
  // NAT64 local-use 64:ff9b:1::/48
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return v4(g[6], g[7]);
  return null;
}

/**
 * literal-IP エンコードを正規化。dotted-v4 (family 4) / 埋込 v4 は unwrap して v4 /
 * それ以外の IPv6 は expanded 8-group hex (family 6)。IP でなければ null (= DNS 要)。
 */
export function normalizeToIp(hostname: string): NormalizedIp | null {
  if (!hostname) return null;
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.includes(':')) {
    const g = parseV6(h);
    if (!g) return null;
    const emb = extractEmbeddedV4(g);
    if (emb) return { family: 4, ip: emb };
    return { family: 6, ip: g.map((x) => x.toString(16).padStart(4, '0')).join(':') };
  }
  const v4 = parseV4Any(h);
  if (v4 !== null) return { family: 4, ip: v4ToString(v4) };
  return null;
}

function v4InCidr(n: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

// IANA special-purpose (globally-reachable=false) の IPv4 レンジ (spec §3-3)。default-deny の実体。
const NON_GLOBAL_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16 (メタデータ)
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // 192.0.2/24
  [0xc0586300, 24], // 192.88.99/24 (6to4 relay anycast)
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15
  [0xc6336400, 24], // 198.51.100/24
  [0xcb007100, 24], // 203.0.113/24
  [0xe0000000, 4], // 224/4 (multicast)
  [0xf0000000, 4], // 240/4 (reserved + 255.255.255.255)
];

/**
 * **default-deny**: IANA globally-reachable な IP のみ true。未知/予約/private は false (遮断)。
 * v4 = 非 global レンジ以外を許可 (v4 特殊レジストリは非 global を全列挙するので allowlist と等価)。
 * v6 = 埋込 v4 は内側で判定 / global unicast 2000::/3 かつ doc レンジ (2001:db8/2001:2) 以外のみ許可。
 */
export function isGloballyReachable(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    const n = parseV4Any(ip);
    if (n === null) return false;
    return !NON_GLOBAL_V4.some(([base, prefix]) => v4InCidr(n, base, prefix));
  }
  const g = parseV6(ip);
  if (!g) return false;
  const emb = extractEmbeddedV4(g);
  if (emb) return isGloballyReachable(emb, 4);
  if ((g[0] & 0xe000) !== 0x2000) return false; // 2000::/3 (global unicast) 以外は遮断
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 (documentation)
  if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0x0000) return false; // 2001:2::/48 (benchmarking)
  return true;
}

/**
 * localhost / *.localhost / .local / .internal / metadata.google.internal / 末尾ドット等の denylist。
 * 末尾ドット (example.com.) は denylist exact-match / DNS を迂回する bypass 手口ゆえ一律拒否 (§3-3)。
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === '') return true;
  if (h.endsWith('.')) return true; // 末尾ドット bypass (localhost. / metadata.google.internal.)
  const exact = new Set(['localhost', 'metadata', 'metadata.google.internal']);
  if (exact.has(h)) return true;
  return ['.localhost', '.local', '.internal', '.localdomain'].some((s) => h.endsWith(s));
}

export interface HostCheckOpts {
  allowedPorts?: Set<string>;
  allowlist?: string[]; // opt-in: 与えると host は allowlist と完全一致必須 (既定 off = 任意公開 host 可)
}
export type HostCheck = { url: URL } | { blocked: string };

/**
 * scheme (http/https) + port (80/443/空) + literal-IP default-deny + hostname denylist を検査。
 * literal IP でない host は null を返さず url を通す (DNS 検証は assertUrlSafe が担当)。
 */
export function assertSchemeAndHostAndPort(rawUrl: string, opts: HostCheckOpts = {}): HostCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: 'invalid-url' };
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return { blocked: `scheme:${proto}` };
  const allowedPorts = opts.allowedPorts ?? INGEST_ALLOWED_PORTS;
  if (!allowedPorts.has(url.port)) return { blocked: `port:${url.port}` };
  const host = url.hostname.toLowerCase();
  if (isBlockedHostname(host.replace(/^\[|\]$/g, ''))) return { blocked: `host-denylist:${host}` };
  const literal = normalizeToIp(host);
  if (literal && !isGloballyReachable(literal.ip, literal.family)) return { blocked: `ip:${literal.ip}` };
  if (opts.allowlist && opts.allowlist.length > 0) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (!opts.allowlist.some((a) => bare === a.toLowerCase())) return { blocked: `not-in-allowlist:${host}` };
  }
  return { url };
}

// =============================================================================
// 注入付き非同期 (test は resolve/fetchImpl を mock)
// =============================================================================

export interface AssertUrlSafeOpts {
  resolve: DnsResolver;
  signal: AbortSignal;
  allowedPorts?: Set<string>;
  allowlist?: string[];
}

/**
 * scheme+host+port を検査し、非 literal-IP host は resolve(signal) して全解決 IP を
 * isGloballyReachable 検査。1 つでも非到達/空/未解決なら SsrfBlockedError。
 */
export async function assertUrlSafe(rawUrl: string, opts: AssertUrlSafeOpts): Promise<URL> {
  const checked = assertSchemeAndHostAndPort(rawUrl, { allowedPorts: opts.allowedPorts, allowlist: opts.allowlist });
  if ('blocked' in checked) throw new SsrfBlockedError(checked.blocked, rawUrl);
  const url = checked.url;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalizeToIp(host)) return url; // literal IP は既に default-deny 検査済
  const ips = await opts.resolve(host, opts.signal);
  if (!ips || ips.length === 0) throw new SsrfBlockedError('dns-empty', rawUrl);
  for (const ip of ips) {
    const n = normalizeToIp(ip);
    if (!n || !isGloballyReachable(n.ip, n.family)) throw new SsrfBlockedError(`dns-ip:${ip}`, rawUrl);
  }
  return url;
}

export interface SafeFetchOpts {
  resolve: DnsResolver;
  fetchImpl: typeof fetch;
  deadlineMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: Set<string>;
  allowedPorts?: Set<string>;
  allowlist?: string[];
}
export interface SafeFetchResult {
  finalUrl: string;
  contentType: string;
  text: string;
}

async function readCapped(resp: Response, maxBytes: number, controller: AbortController): Promise<string> {
  const body = resp.body;
  if (!body) {
    const t = await resp.text();
    if (new TextEncoder().encode(t).byteLength > maxBytes) throw new SsrfBlockedError('too-large', '');
    return t;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new SsrfBlockedError('too-large', '');
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * SSRF-safe fetch: 単一 AbortController(全体 deadlineMs) 下で redirect:'manual' の hop ループを回し、
 * **各 hop で assertUrlSafe を再検証** (DNS rebinding: hop ごとに resolve 再解決)。3xx は Location を
 * 絶対 URL 化して次 hop (maxRedirects 上限)。2xx は content-type allowlist → size 上限で body を stream 読み。
 * DNS/hop/body 全て同一 deadline signal 下 (総時間 = deadlineMs 上限)。
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  const deadlineMs = opts.deadlineMs ?? INGEST_TOTAL_DEADLINE_MS;
  const maxBytes = opts.maxBytes ?? INGEST_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? INGEST_MAX_REDIRECTS;
  const allowedContentTypes = opts.allowedContentTypes ?? INGEST_ALLOWED_CONTENT_TYPES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = await assertUrlSafe(current, {
        resolve: opts.resolve,
        signal: controller.signal,
        allowedPorts: opts.allowedPorts,
        allowlist: opts.allowlist,
      });
      const resp = await opts.fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml,text/plain' },
      });
      if (resp.status >= 300 && resp.status < 400) {
        if (hop >= maxRedirects) throw new SsrfBlockedError('too-many-redirects', current);
        const loc = resp.headers.get('location');
        if (!loc) throw new SsrfBlockedError('redirect-no-location', current);
        current = new URL(loc, url).toString(); // 相対 Location を絶対化 → 次 hop で再検証
        continue;
      }
      const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!allowedContentTypes.has(ct)) throw new SsrfBlockedError(`content-type:${ct}`, current);
      const cl = resp.headers.get('content-length');
      if (cl && Number(cl) > maxBytes) throw new SsrfBlockedError('too-large-header', current);
      const text = await readCapped(resp, maxBytes, controller);
      return { finalUrl: url.toString(), contentType: ct, text };
    }
    throw new SsrfBlockedError('too-many-redirects', rawUrl);
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    if (controller.signal.aborted) throw new SsrfBlockedError('deadline', rawUrl);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本番 DNS 解決 (DoH / Cloudflare 1.1.1.1)。A+AAAA を引き全 IP を返す。成功判定契約 (§3-4):
 *  非200 / DNS Status≠0 / malformed → その type は失敗扱い。両 type 失敗 → fail-closed (throw)。
 *  片側成功なら取れた側で判定 (空 Answer は呼出側 assertUrlSafe が dns-empty で遮断)。
 */
export async function resolveViaDoh(hostname: string, signal: AbortSignal): Promise<string[]> {
  const ips: string[] = [];
  let anyOk = false;
  for (const type of ['A', 'AAAA'] as const) {
    try {
      const resp = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal,
      });
      if (resp.status !== 200) continue;
      const data = (await resp.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
      if (data.Status !== 0) continue; // NOERROR 以外は失敗扱い
      anyOk = true;
      for (const ans of data.Answer ?? []) {
        if (ans.type === 1 || ans.type === 28) ips.push(ans.data); // A(1) / AAAA(28)。CNAME(5) 等は無視
      }
    } catch {
      // この type は失敗 (timeout/network/malformed)。両側失敗のみ下で fail-closed。
    }
  }
  if (!anyOk) throw new SsrfBlockedError('doh-failed', hostname);
  return ips;
}
