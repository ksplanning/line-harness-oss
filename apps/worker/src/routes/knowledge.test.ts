/**
 * T-C4 / T-C1 (Phase B B-3) — 取込 route (ingest/list/delete) + URL 範囲 + mount + account スコープ。
 *  - text/url 両 kind が document+chunks を作り search_text が FTS 反映 (実 FTS5)。url は ssrf-guard 経由。
 *  - content-type allowlist 外/範囲外 (SSRF) を [制約] 拒否 (T-C1)。JS 実行/headless 経路 grep 0。
 *  - **index.ts に mount + 実 app (auth+permission 経由) の統合テストで保存到達** (未 mount=404 dead-code / M-15)。
 *  - POST=認証スコープ (global 非露出・不一致 403) / GET-one・DELETE=accountScopeReject (D-4)。送信ゼロ (grep 0)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

vi.mock('../lib/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ssrf-guard.js')>();
  return { ...actual, safeFetch: vi.fn() };
});

const { knowledge, extractHtmlBodyText } = await import('./knowledge.js');
const { app } = await import('../index.js');
const { safeFetch, SsrfBlockedError } = await import('../lib/ssrf-guard.js');
const mockedSafeFetch = safeFetch as unknown as ReturnType<typeof vi.fn>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const SRC = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(raw: Database.Database): D1Database {
  const makeStmt = (sql: string) => {
    const s = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...a: unknown[]) { params = a; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      __exec() { return s.run(...(params as never[])); },
    };
    return api;
  };
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      const tx = raw.transaction(() => stmts.map((st) => st.__exec()));
      tx();
      return stmts.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  mockedSafeFetch.mockReset();
});

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}
// permission なしの局所 app (route ロジック単体)。
function localApp() {
  const a = new Hono<Env>();
  a.route('/', knowledge);
  return a;
}
const call = (method: string, path: string, body?: unknown) =>
  localApp().request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env());
const docCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_documents`).get() as { c: number }).c;
const chunkCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_chunks`).get() as { c: number }).c;
const ftsCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c;

describe('extractHtmlBodyText — 静的 HTML 本文抽出 (JS 非実行 / T-C1)', () => {
  test('script/style/nav/footer を除去しタグを剥がしエンティティ復号', () => {
    const html = '<html><head><title>t</title><style>.x{color:red}</style></head><body><script>alert(1)</script><h1>見出し</h1><p>本文&amp;詳細。</p><nav>メニュー</nav><footer>フッタ</footer></body></html>';
    const text = extractHtmlBodyText(html);
    expect(text).toContain('見出し');
    expect(text).toContain('本文&詳細'); // エンティティ復号
    expect(text).not.toContain('alert'); // script 除去
    expect(text).not.toContain('color:red'); // style 除去
    expect(text).not.toContain('メニュー'); // nav 除去
    expect(text).not.toContain('フッタ'); // footer 除去
  });
});

describe('POST /api/knowledge/ingest — text kind (T-C4)', () => {
  test('text 取込が document+chunks を作り search_text が FTS 反映', async () => {
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'text', content: '営業時間は10時から19時です。\n\n駐車場は店舗の裏に10台分ございます。' });
    expect(res.status).toBe(201);
    const j = await res.json() as { data: { sourceType: string; chunkCount: number } };
    expect(j.data.sourceType).toBe('text');
    expect(docCount()).toBe(1);
    expect(chunkCount()).toBeGreaterThanOrEqual(1);
    expect(ftsCount()).toBe(chunkCount()); // 全 chunk が FTS 反映
    // chunk の account が document と同値。
    const acct = (raw.prepare(`SELECT DISTINCT line_account_id a FROM knowledge_chunks`).all() as { a: string }[]).map((r) => r.a);
    expect(acct).toEqual(['acc-1']);
  });
  test('content 空は 400 (保存されない)', async () => {
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'text', content: '   ' });
    expect(res.status).toBe(400);
    expect(docCount()).toBe(0);
  });
});

describe('POST /api/knowledge/ingest — url kind (ssrf-guard 経由 / T-C4・T-C1)', () => {
  test('url 取込が safeFetch→本文抽出→document(source_url)+chunks を作る', async () => {
    mockedSafeFetch.mockResolvedValue({ finalUrl: 'https://shop.example/info', contentType: 'text/html', text: '<h1>店舗案内</h1><p>当店は駅から徒歩5分です。ご来店お待ちしております。</p>' });
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'url', url: 'https://shop.example/info' });
    expect(res.status).toBe(201);
    const doc = raw.prepare(`SELECT source_type, source_url FROM knowledge_documents`).get() as { source_type: string; source_url: string };
    expect(doc.source_type).toBe('url');
    expect(doc.source_url).toBe('https://shop.example/info');
    expect(chunkCount()).toBeGreaterThanOrEqual(1);
  });
  test('SSRF/content-type 非allowlist は [制約] 400 で拒否 (保存されない)', async () => {
    mockedSafeFetch.mockRejectedValue(new SsrfBlockedError('content-type:application/pdf', 'https://x/'));
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'url', url: 'https://x/' });
    expect(res.status).toBe(400);
    expect(docCount()).toBe(0);
  });
  test('内部 IP URL は ssrf-guard が遮断し 400', async () => {
    mockedSafeFetch.mockRejectedValue(new SsrfBlockedError('ip:169.254.169.254', 'http://169.254.169.254/'));
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'url', url: 'http://169.254.169.254/' });
    expect(res.status).toBe(400);
    expect(docCount()).toBe(0);
  });
  test('kind 不正は 400', async () => {
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'pdf', url: 'https://x/' });
    expect(res.status).toBe(400);
  });
});

describe('POST スコープ (Codex #11 / D-4)', () => {
  test('accountId 無し (global 作成) は 403', async () => {
    const res = await call('POST', '/api/knowledge/ingest', { kind: 'text', content: '本文テキストです' });
    expect(res.status).toBe(403);
    expect(docCount()).toBe(0);
  });
  test('body.accountId が query と不一致は 403', async () => {
    const res = await call('POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'text', content: '本文テキストです', accountId: 'acc-2' });
    expect(res.status).toBe(403);
    expect(docCount()).toBe(0);
  });
});

describe('GET/DELETE — account スコープ (accountScopeReject / D-4)', () => {
  async function seedDoc(acct: string | null) {
    mockedSafeFetch.mockReset();
    const res = await call('POST', `/api/knowledge/ingest?accountId=${acct}`, { kind: 'text', content: '駐車場は店舗の裏に10台分ございます。' });
    return (await res.json() as { data: { id: string } }).data.id;
  }
  test('GET /documents は account スコープ (global + 指定) を返す', async () => {
    await seedDoc('acc-1');
    const res = await call('GET', '/api/knowledge/documents?accountId=acc-1');
    const j = await res.json() as { data: unknown[] };
    expect(j.data.length).toBe(1);
  });
  test('GET /documents/:id は他 account を 403', async () => {
    const id = await seedDoc('acc-1');
    const res = await call('GET', `/api/knowledge/documents/${id}?accountId=acc-2`);
    expect(res.status).toBe(403);
  });
  test('DELETE は他 account を 403・同 account は chunks/FTS ごと削除', async () => {
    const id = await seedDoc('acc-1');
    expect((await call('DELETE', `/api/knowledge/documents/${id}?accountId=acc-2`)).status).toBe(403);
    expect(docCount()).toBe(1);
    const ok = await call('DELETE', `/api/knowledge/documents/${id}?accountId=acc-1`);
    expect(ok.status).toBe(200);
    expect(docCount()).toBe(0);
    expect(chunkCount()).toBe(0);
    expect(ftsCount()).toBe(0); // ad トリガで FTS も除去
  });
});

describe('mount + 実 app 統合 (auth+permission 経由・M-15 dead-code 検知)', () => {
  test('実 app 経由 (Bearer env-owner) で POST /ingest が 201 保存到達 (未 mount=404)', async () => {
    const res = await app.request('/api/knowledge/ingest?accountId=acc-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer env-owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', content: '営業時間は10時から19時です。\n\n駐車場は店舗の裏にございます。' }),
    }, env());
    expect(res.status).not.toBe(404); // mount 漏れなら 404 = M-15 dead-code
    expect(res.status).toBe(201);
    expect(docCount()).toBe(1);
    expect(chunkCount()).toBeGreaterThanOrEqual(1);
  });
  test('実 app で GET 一覧も auth+permission を通り 200', async () => {
    const res = await app.request('/api/knowledge/documents?accountId=acc-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer env-owner-key' },
    }, env());
    expect(res.status).toBe(200);
  });
});

describe('送信ゼロ + ssrf import + JS 実行経路なし (D-2 / T-C1 grep)', () => {
  // コメント除去後の**実行コード**を対象に grep (IP 用語 'multicast' や「headless 経路なし」等の説明文を誤検知しない)。
  const readCode = (p: string) =>
    readFileSync(join(SRC, p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  test('ingest/list/delete 経路に reply/push/multicast の送信呼出が無い', () => {
    for (const f of ['routes/knowledge.ts', 'services/knowledge.ts', 'lib/ssrf-guard.ts']) {
      expect(readCode(f)).not.toMatch(/replyMessage|pushMessage|multicast|lineClient|sendMessage/);
    }
  });
  test('url kind は ssrf-guard を import し worker に headless/JS 実行経路が無い', () => {
    expect(readFileSync(join(SRC, 'routes/knowledge.ts'), 'utf8')).toMatch(/from ['"]\.\.\/lib\/ssrf-guard\.js['"]/);
    for (const f of ['routes/knowledge.ts', 'services/knowledge.ts', 'lib/ssrf-guard.ts']) {
      expect(readCode(f)).not.toMatch(/puppeteer|playwright|headless|new Function\(|\beval\(/);
    }
  });
});
