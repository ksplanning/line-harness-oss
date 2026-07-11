/**
 * C1 — migration 097: broadcasts.messages 追加 (combo messages / additive ADD COLUMN)。
 *
 * broadcast-combo-messages Batch 1 の芯: 1配信=1メッセージの構造制約を additive に解く。
 * 本 test で以下を固定する:
 *  - checkMigration が 097 を「additive」として通す (filename 例外 不要 = 一般 migration 扱いでも ok)。
 *    → 054 と違い rebuild でないので、blanket 例外に登録せず素の additive gate を通ること自体を assert。
 *  - schema.sql + migrations 001..096 を replay した broadcasts に messages 列が無い状態から、
 *    097 適用で messages TEXT 列が additive に生える (既存行は messages IS NULL = 後方互換)。
 *  - 097 適用後、messages に JSON 文字列を保存/復元でき、NULL のままの行も維持される。
 *  - inline CHECK を付けない (D1 の ADD COLUMN 制約列拒否リスク回避) — DDL に CHECK/NOT NULL が無いこと。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIG_DIR = join(PKG_ROOT, 'migrations');
const M097_NAME = '097_broadcasts_messages_column.sql';
const sql097 = readFileSync(join(MIG_DIR, M097_NAME), 'utf8');

const BENIGN = /duplicate column name|already exists/i;

function splitSql(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/** schema.sql (full) + migrations 001..096 を replay して 097 直前の状態を作る。 */
function baselineDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && f.localeCompare(M097_NAME) < 0)
    .sort();
  for (const file of files) {
    for (const stmt of splitSql(readFileSync(join(MIG_DIR, file), 'utf8'))) {
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!BENIGN.test(msg)) throw new Error(`${file}: ${msg}`);
      }
    }
  }
  return db;
}

function apply097(db: Database.Database): void {
  for (const stmt of splitSql(sql097)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function broadcastCols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info('broadcasts')").all() as Array<{ name: string }>).map((r) => r.name);
}

describe('migration 097: broadcasts.messages additive column', () => {
  it('passes checkMigration as a plain additive migration (no filename exception needed)', () => {
    // additive ADD COLUMN (nullable) は素の gate を通る — 054 のような blanket 例外に頼らない。
    expect(checkMigration(sql097, M097_NAME)).toEqual({ ok: true });
    // filename 無し (一般 migration 扱い) でも ok (destructive でないため)。
    expect(checkMigration(sql097)).toEqual({ ok: true });
  });

  it('is a pure additive ADD COLUMN (no rebuild, no inline CHECK / NOT NULL)', () => {
    // DDL のみ検査 (-- コメントに CHECK/NOT NULL 等の語が出るため除外)。
    const ddl = sql097.split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(ddl).toMatch(/ALTER\s+TABLE\s+broadcasts\s+ADD\s+COLUMN\s+messages\s+TEXT/i);
    expect(ddl).not.toMatch(/DROP\s+TABLE|RENAME\s+TO|broadcasts_new/i);
    expect(ddl).not.toMatch(/NOT\s+NULL/i);
    expect(ddl).not.toMatch(/CHECK\s*\(/i);
  });

  it('baseline (pre-097) broadcasts has no messages column', () => {
    const db = baselineDb();
    expect(broadcastCols(db)).not.toContain('messages');
  });

  it('adds messages column additively; existing rows are NULL (backward compatible)', () => {
    const db = baselineDb();
    // 097 直前の broadcasts に単発配信行を1件入れる。
    db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content) VALUES ('b-old','T','text','hi')`).run();
    apply097(db);
    expect(broadcastCols(db)).toContain('messages');
    const old = db.prepare(`SELECT messages FROM broadcasts WHERE id='b-old'`).get() as { messages: string | null };
    expect(old.messages).toBeNull();
  });

  it('stores and round-trips a messages JSON string after 097', () => {
    const db = baselineDb();
    apply097(db);
    const payload = JSON.stringify([
      { type: 'image', content: '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}' },
      { type: 'text', content: 'せつめい' },
    ]);
    db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, messages) VALUES ('b-combo','T','image','{}',?)`).run(payload);
    const row = db.prepare(`SELECT messages FROM broadcasts WHERE id='b-combo'`).get() as { messages: string };
    expect(JSON.parse(row.messages)).toHaveLength(2);
    // messages を書かない行は依然 NULL。
    db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content) VALUES ('b-single','T','text','hi')`).run();
    const single = db.prepare(`SELECT messages FROM broadcasts WHERE id='b-single'`).get() as { messages: string | null };
    expect(single.messages).toBeNull();
  });
});
