/**
 * C2 — DB 層: broadcasts.messages の永続 + 全 read 経路で messages が載る。
 *
 * broadcast-combo-messages Batch 1。createBroadcast/updateBroadcast が messages(JSON文字列)を
 * 保存/差替でき、getBroadcastById / getBroadcasts / getQueuedBroadcasts(= 予約/queued を拾う
 * cron 側 SELECT) が messages 列を返すことを固定する。
 *
 * [指摘元: codex-independent-check / HIGH #1・#8] 送信サービスは自前 SELECT せず呼び側(cron)の
 * 行を使うため、getQueuedBroadcasts(SELECT *) が messages を含まないと「予約 combo が単発送信
 * される」silent 事故になる。ここで queued read が messages を返すことを assert する。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBroadcast,
  updateBroadcast,
  getBroadcastById,
  getBroadcasts,
  getQueuedBroadcasts,
} from '../src/broadcasts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIG_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function splitSql(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
}

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    for (const stmt of splitSql(readFileSync(join(MIG_DIR, f), 'utf8'))) {
      try {
        db.exec(stmt);
      } catch (e) {
        if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const COMBO = JSON.stringify([
  { type: 'image', content: '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}' },
  { type: 'text', content: 'せつめい' },
]);

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','tok','sec')`).run();
});

describe('C2 broadcasts.messages db round-trip', () => {
  it('createBroadcast persists messages JSON and getBroadcastById restores it', async () => {
    const b = await createBroadcast(db, { title: 'C', messageType: 'image', messageContent: '{}', targetType: 'all', messages: COMBO });
    const got = await getBroadcastById(db, b.id);
    expect(got?.messages).toBe(COMBO);
    expect(JSON.parse(got!.messages as string)).toHaveLength(2);
  });

  it('createBroadcast leaves messages NULL when omitted (single backward compat)', async () => {
    const b = await createBroadcast(db, { title: 'S', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    const got = await getBroadcastById(db, b.id);
    expect(got?.messages ?? null).toBeNull();
  });

  it('updateBroadcast replaces messages', async () => {
    const b = await createBroadcast(db, { title: 'C', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    const next = JSON.stringify([{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }, { type: 'text', content: 'c' }]);
    const updated = await updateBroadcast(db, b.id, { messages: next });
    expect(updated?.messages).toBe(next);
    // messages を触らない update は既存値を保持 (undefined は列不変)。
    const titleOnly = await updateBroadcast(db, b.id, { title: 'X' });
    expect(titleOnly?.messages).toBe(next);
    // 明示 null で単発へ戻せる。
    const cleared = await updateBroadcast(db, b.id, { messages: null });
    expect(cleared?.messages ?? null).toBeNull();
  });

  it('getBroadcasts (list read) returns messages column', async () => {
    await createBroadcast(db, { title: 'C', messageType: 'image', messageContent: '{}', targetType: 'all', messages: COMBO });
    const list = await getBroadcasts(db);
    expect(list.some((r) => r.messages === COMBO)).toBe(true);
  });

  it('getQueuedBroadcasts (cron SELECT) returns messages so 予約 combo restores at send time', async () => {
    // queued に拾われる条件: status='sending' / batch_offset>=0 / sent_at NULL / segment_conditions NOT NULL。
    raw.prepare(
      `INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, batch_offset, segment_conditions, line_account_id, messages)
       VALUES ('bq','T','image','{}','tag','sending',0,'{"rules":[]}','acc-1',?)`,
    ).run(COMBO);
    const queued = await getQueuedBroadcasts(db);
    const row = queued.find((r) => r.id === 'bq');
    expect(row, 'queued combo broadcast must be picked up').toBeTruthy();
    expect(row!.messages).toBe(COMBO);
    expect(JSON.parse(row!.messages as string)).toHaveLength(2);
  });
});
