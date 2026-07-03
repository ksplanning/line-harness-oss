/**
 * F2 batch2 migration 051/052/053 の additive 性 + schema 不変検証 (T-C1 / A8)。
 *
 * 051 campaigns (account_id NOT NULL) / 052 broadcasts.campaign_id (ADD COLUMN REFERENCES) /
 * 053 template_packs + template_pack_items。
 *
 *   - checkMigration が 3 本とも ok (破壊操作ゼロ)
 *   - SQL に _new / INSERT ... SELECT / DROP / RENAME が無い (静的 grep — 表 rebuild 誘発なし)
 *   - 052 の ADD COLUMN ... REFERENCES が SQLite で適用可 (foreign_keys ON でも)
 *   - 3 本適用の前後で既存表 (broadcasts/message_templates/messages_log/rich_menu_areas) と
 *     FK 子表 (broadcast_insights/messages_log) の行数不変
 *   - 既存表の sqlite_schema (index/trigger/FK を含む CREATE 文) が不変 (行数だけでは表 rebuild を
 *     見逃すため CREATE 文そのものを比較)
 *   - 新表の列・index が正しく作られる
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

const M051 = join(MIG_DIR, '051_campaigns.sql');
const M052 = join(MIG_DIR, '052_broadcasts_campaign_id.sql');
const M053 = join(MIG_DIR, '053_template_packs.sql');

const sql051 = readFileSync(M051, 'utf8');
const sql052 = readFileSync(M052, 'utf8');
const sql053 = readFileSync(M053, 'utf8');

const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 本番 D1 (049 適用済) 相当の baseline を作る。実運用の migration runner は
 * schema.sql ではなく「現状の本番 D1」に未適用の 051-053 を当てる。この状態を
 * 再現するため、schema.sql + migrations 001..050 を replay して土台とする
 * (051-053 は含めない = campaign_id 無しの broadcasts / campaigns 表無し)。
 * これにより「049 状態から 051-053 を当てても既存が壊れない」= additive を検証できる。
 */
function baselineDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // schema.sql は 051-053 の DDL も含む (drift 防止) が、baseline では replay しない。
  // schema.sql をそのまま流すと campaigns/template_packs 表が先に出来てしまうため、
  // schema.sql からは本 batch の新 DDL ブロックを切り落として土台にする。
  const full = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
  const marker = '-- Campaigns (migration 051 / F2 G3)';
  const mi = full.indexOf(marker);
  const cut = mi === -1 ? full.length : full.lastIndexOf('-- ===', mi);
  db.exec(full.slice(0, cut === -1 ? mi : cut));

  // migrations 001..050 を replay (051 以降は除外 = 本 batch 未適用状態)。
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && f.localeCompare('051') < 0)
    .sort();
  for (const file of files) {
    for (const stmt of splitSqlStatements(readFileSync(join(MIG_DIR, file), 'utf8'))) {
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!BENIGN_SQLITE_ERROR.test(msg)) throw new Error(`${file}: ${msg}`);
      }
    }
  }
  return db;
}

function applyMigration(db: Database.Database, sql: string): void {
  // migration runner と同じく ; 区切りで 1 文ずつ適用。
  for (const stmt of splitSqlStatements(sql)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN_SQLITE_ERROR.test(msg)) throw err;
    }
  }
}

/** 既存表の CREATE 文 (index/trigger 含む) を name→sql の Map で返す。 */
function schemaObjectsFor(db: Database.Database, tables: string[]): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          AND (tbl_name IN (${tables.map(() => '?').join(',')}))
        ORDER BY type, name`,
    )
    .all(...tables) as Array<{ name: string; sql: string }>;
  return new Map(rows.map((r) => [r.name, r.sql]));
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const EXISTING_TABLES = ['broadcasts', 'message_templates', 'messages_log', 'rich_menu_areas'];
const FK_CHILD_TABLES = ['broadcast_insights', 'messages_log'];

describe('F2 batch2 migrations 051/052/053 (additive)', () => {
  it('checkMigration passes for all three (no destructive DDL)', () => {
    expect(checkMigration(sql051)).toEqual({ ok: true });
    expect(checkMigration(sql052)).toEqual({ ok: true });
    expect(checkMigration(sql053)).toEqual({ ok: true });
  });

  it('contains no table-rebuild patterns (_new / INSERT..SELECT / DROP / RENAME)', () => {
    for (const sql of [sql051, sql052, sql053]) {
      expect(sql).not.toMatch(/_new\b/i);
      expect(sql).not.toMatch(/\bINSERT\s+INTO\s+\S+\s*(\([^)]*\))?\s*SELECT\b/i);
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
      expect(sql).not.toMatch(/\bRENAME\s+(TO|COLUMN)\b/i);
    }
  });

  it('052 uses a plain ADD COLUMN ... REFERENCES (not a rebuild)', () => {
    expect(sql052).toMatch(/ALTER\s+TABLE\s+broadcasts\s+ADD\s+COLUMN\s+campaign_id\s+TEXT\s+REFERENCES\s+campaigns/i);
  });

  it('applies cleanly with foreign_keys ON and adds campaign_id (D1-compatible ADD COLUMN REFERENCES)', () => {
    const db = baselineDb();
    // 052 は 051 の campaigns 表に REFERENCES するため 051 → 052 の順で適用する。
    applyMigration(db, sql051);
    applyMigration(db, sql052);
    applyMigration(db, sql053);
    const cols = (db.prepare("PRAGMA table_info('broadcasts')").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain('campaign_id');
  });

  it('leaves existing tables and FK child tables row-count-invariant', () => {
    const db = baselineDb();
    // 既存表にデータを入れて、migration 適用でデータが消えない (表 rebuild なし) ことを確認。
    db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','tok','sec')`).run();
    db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content) VALUES ('b-1','T','text','hi')`).run();
    db.prepare(`INSERT INTO broadcast_insights (id, broadcast_id, status) VALUES ('bi-1','b-1','ready')`).run();
    db.prepare(`INSERT INTO friends (id, line_account_id, line_user_id) VALUES ('f-1','acc-1','U1')`).run();
    db.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id) VALUES ('m-1','f-1','incoming','text','x','postback','acc-1')`).run();
    db.prepare(`INSERT INTO message_templates (id, name, message_type, message_content) VALUES ('t-1','T','text','hi')`).run();

    const before = new Map<string, number>();
    for (const t of [...new Set([...EXISTING_TABLES, ...FK_CHILD_TABLES])]) before.set(t, rowCount(db, t));

    applyMigration(db, sql051);
    applyMigration(db, sql052);
    applyMigration(db, sql053);

    for (const [t, n] of before) {
      expect(rowCount(db, t), `row count of ${t} must be unchanged`).toBe(n);
    }
    // 子行が親削除で消えないか (紐付けが SET NULL/CASCADE で意図通り) は route test 側。
    // ここでは migration による副作用 (表 rebuild で FK 子行が孤立/消失) がないことのみ担保。
    expect(rowCount(db, 'broadcast_insights')).toBe(1);
  });

  it('leaves the CREATE statements of existing tables/indexes unchanged (no rebuild)', () => {
    const db = baselineDb();
    const before = schemaObjectsFor(db, EXISTING_TABLES);
    applyMigration(db, sql051);
    applyMigration(db, sql052);
    applyMigration(db, sql053);
    const after = schemaObjectsFor(db, EXISTING_TABLES);

    for (const [name, beforeSql] of before) {
      expect(after.get(name), `${name} schema object must survive`).toBeDefined();
      const afterSql = after.get(name)!;
      if (name === 'broadcasts') {
        // SQLite の ADD COLUMN は表 rebuild せず sqlite_master の CREATE 文の末尾に列定義を
        // 追記するだけ。したがって「元の CREATE 文がそのまま prefix として残る」+「末尾に
        // campaign_id 列が 1 つだけ足される」= 非破壊の additive を検証する
        // (もし表 rebuild していたら CREATE 文の構造や列順が変わり prefix 一致が崩れる)。
        const trimmedBefore = beforeSql.replace(/\s*\)\s*$/, '');
        expect(afterSql.startsWith(trimmedBefore), 'broadcasts CREATE prefix must be preserved (no rebuild)').toBe(true);
        expect(afterSql).toMatch(/campaign_id TEXT REFERENCES campaigns/i);
      } else {
        // 触れていない既存表は CREATE 文が byte-identical。
        expect(afterSql, `${name} CREATE statement must be unchanged (no rebuild)`).toBe(beforeSql);
      }
    }
  });

  it('creates campaigns with account_id NOT NULL and its index', () => {
    const db = baselineDb();
    applyMigration(db, sql051);
    const cols = db.prepare("PRAGMA table_info('campaigns')").all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(['account_id', 'created_at', 'id', 'name', 'updated_at']);
    expect(byName.get('account_id')?.notnull).toBe(1);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_campaigns_account'`).get();
    expect(idx).toBeDefined();
  });

  it('creates template_packs + template_pack_items with ordered items and CASCADE', () => {
    const db = baselineDb();
    db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','tok','sec')`).run();
    applyMigration(db, sql053);
    const packCols = (db.prepare("PRAGMA table_info('template_packs')").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(packCols).toEqual(['account_id', 'created_at', 'id', 'name', 'updated_at']);
    const itemCols = (db.prepare("PRAGMA table_info('template_pack_items')").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(itemCols).toEqual(['created_at', 'id', 'message_content', 'message_type', 'order_index', 'pack_id', 'updated_at']);

    // CASCADE: pack 削除で items も消える。
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO template_packs (id, account_id, name) VALUES ('p-1','acc-1','set')`).run();
    db.prepare(`INSERT INTO template_pack_items (id, pack_id, order_index, message_type, message_content) VALUES ('i-1','p-1',0,'text','hi')`).run();
    db.prepare(`DELETE FROM template_packs WHERE id='p-1'`).run();
    expect(rowCount(db, 'template_pack_items')).toBe(0);

    // message_type CHECK: 'image' は弾く (text/flex のみ)。
    db.prepare(`INSERT INTO template_packs (id, account_id, name) VALUES ('p-2','acc-1','set2')`).run();
    expect(() =>
      db.prepare(`INSERT INTO template_pack_items (id, pack_id, order_index, message_type, message_content) VALUES ('i-2','p-2',0,'image','x')`).run(),
    ).toThrow();
  });
});
