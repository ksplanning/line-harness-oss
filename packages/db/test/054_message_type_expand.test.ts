/**
 * T-C2 / A6 / D-3 — migration 054 broadcasts.message_type CHECK 拡張 (最高リスク rebuild)。
 *
 * broadcasts は列 CHECK `IN ('text','image','flex')` を持ち、SQLite は列 CHECK を
 * ALTER で変更できない → 表 rebuild (CREATE _new + INSERT SELECT + DROP + RENAME) が唯一の
 * 手段。broadcasts は FK 子表 broadcast_insights(CASCADE)/messages_log(SET NULL) を持つため
 * 最高リスク。本 test で以下を固定する:
 *
 *  - checkMigration が 054 を「documented 単一ファイル例外」として通す (filename scope・
 *    filename 無しなら DROP/RENAME で依然 block = 全体を緩めない)
 *  - 列テンプレの正典は bootstrap.sql の実行時集合 = 054 直前 broadcasts の 24 列と完全一致し
 *    sender 列を含まない (029/schema.sql をコピーしない・Codex CRITICAL[1][2][3])
 *  - rebuild 前後で broadcast_insights/messages_log の行数不変 + broadcast_id 値保存を
 *    foreign_keys=OFF(D1 パリティ) と ON(防御的・foreign_key_check 無違反) の両ケースで assert
 *  - 054 を2回 replay しても子表が消えず新旧 type INSERT 可 (冪等再実行安全)
 *  - 新 type(video/audio/imagemap/richvideo) INSERT 可・旧 type 可・'xyz' は CHECK で弾く
 *  - schema.sql 正本の broadcasts.message_type 行も新 type 込みに同期 (drift なし)
 *
 * FK 保全の依り所: D1 は migration をトランザクション内で FK 強制せず走らせる (029 rebuild が
 * 本番で broadcast_insights を消さず生存した実証)。migration 本体に PRAGMA を書くと D1 では
 * no-op なので書かず、runner の FK-suspend 挙動を本 test の apply helper で模す。
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
const M054_NAME = '054_broadcasts_message_type_expand.sql';
const sql054 = readFileSync(join(MIG_DIR, M054_NAME), 'utf8');

const BENIGN = /duplicate column name|already exists/i;
const NEW_TYPES = ['video', 'audio', 'imagemap', 'richvideo'] as const;
const OLD_TYPES = ['text', 'image', 'flex'] as const;

function splitSql(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/** schema.sql (full) + migrations 001..053 を replay して 054 直前の状態を作る。 */
function baselineDb(fk: boolean): Database.Database {
  const db = new Database(':memory:');
  db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && f.localeCompare('054') < 0)
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

/**
 * 054 を適用する。migration runner / D1 が migration-time に FK 強制を停止する挙動を模し、
 * DDL の前後で FK を suspend/restore する (migration 本体には PRAGMA を書かない = D1 no-op)。
 */
function apply054(db: Database.Database): void {
  const prev = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  for (const stmt of splitSql(sql054)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
  db.pragma(`foreign_keys = ${prev ? 'ON' : 'OFF'}`);
}

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','tok','sec')`).run();
  db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content) VALUES ('b-1','T','text','hi')`).run();
  db.prepare(`INSERT INTO broadcast_insights (id, broadcast_id, status) VALUES ('bi-1','b-1','ready')`).run();
  db.prepare(`INSERT INTO friends (id, line_account_id, line_user_id) VALUES ('f-1','acc-1','U1')`).run();
  db.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, broadcast_id) VALUES ('m-1','f-1','outgoing','text','x','push','acc-1','b-1')`).run();
}

function broadcastCols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info('broadcasts')").all() as Array<{ name: string }>).map((r) => r.name);
}
function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function insertType(db: Database.Database, id: string, type: string): void {
  db.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content) VALUES (?, 'T', ?, '{}')`).run(id, type);
}

describe('migration 054: broadcasts.message_type CHECK expand (FK-preserving rebuild)', () => {
  it('checkMigration passes 054 only as a documented single-file exception (not a blanket loosening)', () => {
    // filename scope で通す (rebuild 用の DROP TABLE / RENAME TO のみ免除)。
    expect(checkMigration(sql054, M054_NAME)).toEqual({ ok: true });
    // filename 無し (= 一般 migration 扱い) なら DROP/RENAME で依然 block される。
    const generic = checkMigration(sql054);
    expect(generic.ok).toBe(false);
  });

  it('is a table-rebuild (CREATE _new + DROP TABLE broadcasts + RENAME) and excludes any sender column', () => {
    expect(sql054).toMatch(/broadcasts_new/i);
    expect(sql054).toMatch(/\bDROP\s+TABLE\s+broadcasts\b/i);
    expect(sql054).toMatch(/ALTER\s+TABLE\s+broadcasts_new\s+RENAME\s+TO\s+broadcasts/i);
    // DDL のみを検査 (-- コメントは header で sender/PRAGMA に言及するため除外)。
    const ddl = sql054.split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    // sender は 055 で追加される (054 は 055 より先) — 054 の DDL に sender 列を含めてはならない。
    expect(ddl).not.toMatch(/sender_preset_id|sender_name|sender_icon/i);
    // 表本体には in-migration PRAGMA foreign_keys トグルを書かない (D1 no-op)。
    expect(ddl).not.toMatch(/PRAGMA\s+foreign_keys/i);
  });

  it('baseline (pre-054) rejects new types — proves the narrow CHECK really is widened by 054', () => {
    const db = baselineDb(false);
    expect(() => insertType(db, 'bx', 'video')).toThrow();
  });

  it('[FK OFF · D1 parity] preserves FK child rows/values and widens the CHECK', () => {
    const db = baselineDb(false);
    seed(db);
    const before = { bi: rowCount(db, 'broadcast_insights'), ml: rowCount(db, 'messages_log') };
    apply054(db);
    expect(rowCount(db, 'broadcast_insights'), 'broadcast_insights row count invariant').toBe(before.bi);
    expect(rowCount(db, 'messages_log'), 'messages_log row count invariant').toBe(before.ml);
    // broadcast_id 値が保存される (孤児化しない)。
    expect((db.prepare(`SELECT broadcast_id FROM broadcast_insights WHERE id='bi-1'`).get() as { broadcast_id: string }).broadcast_id).toBe('b-1');
    expect((db.prepare(`SELECT broadcast_id FROM messages_log WHERE id='m-1'`).get() as { broadcast_id: string }).broadcast_id).toBe('b-1');
    // 新 type + 旧 type INSERT 可・'xyz' は弾く。
    for (const t of NEW_TYPES) expect(() => insertType(db, `n-${t}`, t)).not.toThrow();
    for (const t of OLD_TYPES) expect(() => insertType(db, `o-${t}`, t)).not.toThrow();
    expect(() => insertType(db, 'bad', 'xyz')).toThrow();
  });

  it('[FK ON · defensive] no orphaned children after rebuild (foreign_key_check clean, child rows invariant)', () => {
    const db = baselineDb(true);
    seed(db);
    const before = { bi: rowCount(db, 'broadcast_insights'), ml: rowCount(db, 'messages_log') };
    apply054(db);
    // FK を ON に戻して整合性を検査 — rebuild が子行を孤児化していないこと。
    db.pragma('foreign_keys = ON');
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations, 'no foreign key violations after rebuild').toEqual([]);
    expect(rowCount(db, 'broadcast_insights')).toBe(before.bi);
    expect(rowCount(db, 'messages_log')).toBe(before.ml);
  });

  it('is idempotent-safe on re-replay (child rows survive, new/old types still insertable)', () => {
    const db = baselineDb(false);
    seed(db);
    apply054(db);
    apply054(db); // 2 回目 replay (台帳が無い replay 経路の安全性)
    expect(rowCount(db, 'broadcast_insights')).toBe(1);
    expect(rowCount(db, 'messages_log')).toBe(1);
    expect(() => insertType(db, 'again-video', 'video')).not.toThrow();
    expect(() => insertType(db, 'again-text', 'text')).not.toThrow();
    expect(() => insertType(db, 'again-bad', 'xyz')).toThrow();
  });

  it('broadcasts_new column set exactly equals the pre-054 broadcasts columns (24, no sender)', () => {
    const before = baselineDb(false);
    const beforeCols = broadcastCols(before);
    const after = baselineDb(false);
    apply054(after);
    const afterCols = broadcastCols(after);
    expect(afterCols).toEqual(beforeCols); // 名前・列数・順序が完全一致 (取りこぼし = データ喪失)
    expect(afterCols).toContain('campaign_id'); // 052 の列を落としていない
    expect(afterCols).toContain('dedup_progress'); // 030
    expect(afterCols).toContain('batch_lock_at'); // 031
    expect(afterCols).not.toContain('sender_preset_id'); // 054 は sender を含めない (055 で追加)
    expect(afterCols).not.toContain('sender_name');
  });

  it('keeps schema.sql (正本) broadcasts.message_type CHECK in sync with the new types', () => {
    const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
    // broadcasts の message_type CHECK 行を抽出 (scenario_steps 等の別表 CHECK と混同しない)。
    const m = schema.match(/CREATE TABLE IF NOT EXISTS broadcasts[\s\S]*?message_type\s+TEXT NOT NULL CHECK \(message_type IN \(([^)]*)\)\)/);
    expect(m, 'broadcasts message_type CHECK line must exist in schema.sql').not.toBeNull();
    const list = m![1];
    for (const t of [...OLD_TYPES, ...NEW_TYPES]) {
      expect(list, `schema.sql broadcasts CHECK must include '${t}'`).toContain(`'${t}'`);
    }
  });
});
