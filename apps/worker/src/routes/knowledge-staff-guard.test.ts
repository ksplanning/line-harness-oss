/**
 * line-staff-docs-chat T-A7 (Codex BLOCKER-1) — 顧客 knowledge route の予約値拒否ガード。
 *
 * 顧客 route (account-scoped) が accountId='__staff_docs__' / '__global__' を要求されたら 400/403 で拒否し、
 * 顧客経路から staff/global corpus を閲覧/取込/削除できないことを assert。正常系 (実 account) は byte 不変
 * (拒否分岐のみ additive) = accountId='acc-1' の ingest/list/delete が従来どおり動く。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { knowledge } from './knowledge.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
    async batch(stmts: Array<{ __exec: () => unknown }>) { const tx = raw.transaction(() => stmts.map((st) => st.__exec())); tx(); return stmts.map(() => ({ success: true })); },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher, LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'k', LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}
function localApp() { const a = new Hono<Env>(); a.route('/', knowledge); return a; }
const call = (method: string, path: string, body?: unknown) =>
  localApp().request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env());

describe('T-A7 予約 sentinel の enforce (顧客 knowledge route)', () => {
  test.each(['__staff_docs__', '__global__'])('ingest?accountId=%s は拒否 (staff/global corpus に取込ませない)', async (reserved) => {
    const res = await call('POST', `/api/knowledge/ingest?accountId=${reserved}`, { kind: 'text', content: '侵入テキスト' });
    expect([400, 403]).toContain(res.status);
    // staff/global corpus に 1 件も書かれていない。
    const n = (raw.prepare(`SELECT COUNT(*) c FROM knowledge_documents`).get() as { c: number }).c;
    expect(n).toBe(0);
  });

  test.each(['__staff_docs__', '__global__'])('documents 一覧?accountId=%s は拒否 (閲覧させない)', async (reserved) => {
    const res = await call('GET', `/api/knowledge/documents?accountId=${reserved}`);
    expect([400, 403]).toContain(res.status);
  });

  test('DELETE documents/:id?accountId=__staff_docs__ は拒否 (削除させない)', async () => {
    const res = await call('DELETE', `/api/knowledge/documents/any-id?accountId=__staff_docs__`);
    expect([400, 403]).toContain(res.status);
  });

  test('正常系 byte 不変: 実 account の ingest は従来どおり 201 (拒否分岐は additive)', async () => {
    const res = await call('POST', `/api/knowledge/ingest?accountId=acc-1`, { kind: 'text', content: '営業時間は10時から19時です。\n\n駐車場は裏にございます。' });
    expect(res.status).toBe(201);
    const doc = (raw.prepare(`SELECT line_account_id a FROM knowledge_documents`).get() as { a: string });
    expect(doc.a).toBe('acc-1');
  });
});
