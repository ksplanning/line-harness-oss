// =============================================================================
// Formaloo API クライアント (F-1 / T-A1 / line-formaloo-forms)
// -----------------------------------------------------------------------------
// Cloudflare Workers ネイティブ raw fetch 実装 (公式 SDK は Python + 旧依存で Workers 非互換 = 不採用)。
// 認証レシピ (§15 実機 200 確認済):
//   1) POST /v1.0/oauth2/authorization-token/  (Authorization: Basic {SECRET} + x-api-key: {KEY}
//      + body grant_type=client_credentials) → { authorization_token: JWT }
//   2) GET/POST /v3.0/...  (x-api-key: {KEY} + Authorization: JWT {token})  ※ prefix は JWT / Bearer 不可
//
// 設計:
//   - token は per-isolate in-memory Map にキャッシュ (30s TTL 安全側 cap / help=30s, 実測 exp=30日)。
//     **永続化しない** (KV/D1 非使用 / M-23)。isolate 破棄でキャッシュも消える = 短命 token は再取得が安い。
//   - 401 (Error decoding signature 等) は token を 1 回だけ強制再取得してリトライ (bounded = 無限ループ禁止)。
//   - 429 (rate limit) は retry-after / 指数 backoff で bounded リトライ (Workers subrequest 上限を静的 cap で符号化 / 地雷#2)。
//   - fail-soft: ネットワーク例外・非 2xx は throw せず構造化 result を返す (N-6 / 呼び出し側が degrade 判断)。
//   - token 抽出は res.json() (JSON parse)。rtk jq は使わない (§15.2 教訓 / 地雷#1)。
// =============================================================================

/** token キャッシュ TTL (help doc の 30 秒。安全側 cap = 実 exp より短く / 実 invalidation は 401)。 */
export const FORMALOO_TOKEN_TTL_MS = 30_000;

/** 429 backoff の最大リトライ回数 (Workers subrequest 上限を保護する静的 bound / 地雷#2)。 */
export const FORMALOO_MAX_RATE_LIMIT_RETRIES = 3;

/** backoff の基準遅延 (指数 backoff の底 / retry-after ヘッダがあればそちらを優先)。 */
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 8_000;

const DEFAULT_BASE_URL = 'https://api.formaloo.net';

export interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

/** per-isolate in-memory token cache 型 (apiKey → token+expiry)。 */
export type FormalooTokenCache = Map<string, TokenCacheEntry>;

/** module-level singleton = 「per-isolate」キャッシュ (isolate 内の全 request で共有 / 破棄で消える)。 */
const moduleTokenCache: FormalooTokenCache = new Map();

export interface FormalooConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  /** テスト注入用 fetch (default = globalThis.fetch)。 */
  fetchImpl?: typeof fetch;
  /** テスト注入用 clock (default = Date.now)。 */
  now?: () => number;
  /** テスト注入用 sleep (default = setTimeout)。 */
  sleep?: (ms: number) => Promise<void>;
  /** テスト注入用 token cache (default = module singleton = per-isolate)。 */
  cache?: FormalooTokenCache;
}

/** fail-soft な構造化 result (throw しない / N-6)。 */
export type FormalooResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

class FormalooAuthError extends Error {}

export class FormalooClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache: FormalooTokenCache;

  constructor(config: FormalooConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? Date.now;
    this.sleep =
      config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.cache = config.cache ?? moduleTokenCache;
  }

  /**
   * 認証トークンを取得。TTL 内はキャッシュを返し、force=true or 期限切れで再取得。
   * 非 2xx / token 欠落は FormalooAuthError を throw (request() が fail-soft で捕捉)。
   */
  async getToken(force = false): Promise<string> {
    const cached = this.cache.get(this.apiKey);
    if (!force && cached && cached.expiresAt > this.now()) return cached.token;

    const res = await this.fetchImpl(`${this.baseUrl}/v1.0/oauth2/authorization-token/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.apiSecret}`,
        'x-api-key': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    if (!res.ok) throw new FormalooAuthError(`Formaloo auth failed: HTTP ${res.status}`);
    // token 抽出は JSON parse (rtk jq 破損を避ける / §15.2)
    const json = (await res.json()) as { authorization_token?: string };
    const token = json?.authorization_token;
    if (!token) throw new FormalooAuthError('Formaloo auth: authorization_token missing');
    this.cache.set(this.apiKey, { token, expiresAt: this.now() + FORMALOO_TOKEN_TTL_MS });
    return token;
  }

  async get<T = unknown>(path: string): Promise<FormalooResult<T>> {
    return this.request<T>('GET', path);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<FormalooResult<T>> {
    return this.request<T>('POST', path, body);
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<FormalooResult<T>> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T = unknown>(path: string): Promise<FormalooResult<T>> {
    return this.request<T>('DELETE', path);
  }

  /**
   * 共通リクエスト。401 → token 1 回再取得リトライ / 429 → bounded backoff リトライ / 例外 → fail-soft。
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<FormalooResult<T>> {
    try {
      let token = await this.getToken();
      let res = await this.doFetch(method, path, token, body);
      let did401Retry = false;
      let rateAttempts = 0;

      // bounded: 401 は最大 1 回再取得 / 429 は最大 FORMALOO_MAX_RATE_LIMIT_RETRIES 回。無限ループ禁止。
      while (true) {
        if (res.status === 401 && !did401Retry) {
          did401Retry = true;
          token = await this.getToken(true); // 強制再取得 (1 回のみ)
          res = await this.doFetch(method, path, token, body);
          continue;
        }
        if (res.status === 429 && rateAttempts < FORMALOO_MAX_RATE_LIMIT_RETRIES) {
          await this.sleep(this.backoffMs(rateAttempts, res.headers.get('retry-after')));
          rateAttempts += 1;
          res = await this.doFetch(method, path, token, body);
          continue;
        }
        break;
      }

      if (res.ok) {
        const data = (await this.safeJson(res)) as T;
        return { ok: true, status: res.status, data };
      }
      return { ok: false, status: res.status, error: await this.safeError(res) };
    } catch (e) {
      // fail-soft: ネットワーク例外 / auth 失敗は status 0 で返す (throw しない / N-6)
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async doFetch(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-type': 'application/json',
        'x-api-key': this.apiKey,
        Authorization: `JWT ${token}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** retry-after (秒) 優先。無ければ指数 backoff (base * 2^attempt, cap 8s)。必ず > 0。 */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, BACKOFF_MAX_MS);
    return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private async safeError(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return text.slice(0, 500);
    } catch {
      return `HTTP ${res.status}`;
    }
  }
}

/**
 * env から Formaloo クライアントを生成。KEY/SECRET が無ければ null (fail-soft / secret 未配備 dev)。
 * 生成されるクライアントは module-level token cache (per-isolate) を共有する。
 */
export function createFormalooClient(env: {
  FORMALOO_API_KEY?: string;
  FORMALOO_API_SECRET?: string;
}): FormalooClient | null {
  if (!env.FORMALOO_API_KEY || !env.FORMALOO_API_SECRET) return null;
  return new FormalooClient({ apiKey: env.FORMALOO_API_KEY, apiSecret: env.FORMALOO_API_SECRET });
}
