/**
 * T-C3 / A7 / D-4 — migration 055 sender_presets + broadcasts.sender_preset_id (additive)。
 *
 *   - checkMigration が 055 を通す (additive のみ = 例外登録不要・054 のみが例外)
 *   - SQL に _new / DROP TABLE broadcasts / RENAME 無し (表 rebuild を誘発しない) を static grep
 *   - sender_presets 表 (account-scoped・id server 生成) + broadcasts.sender_preset_id (id 参照) が
 *     additive に追加され、broadcasts に生 sender_name/sender_icon_url 列を持たせない
 *   - FK: line_account 削除で preset が CASCADE / preset 削除で broadcasts.sender_preset_id が
 *     SET NULL (配信は消えず送信者だけ既定に戻る)
 *   - BroadcastMessageType が新 type を含む / createBroadcast・updateBroadcast が sender_preset_id を保存
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigration } from '../../../scripts/check-migrations';
import {
  createBroadcast,
  updateBroadcast,
  getBroadcastById,
  type BroadcastMessageType,
} from '../src/broadcasts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIG_DIR = join(PKG_ROOT, 'migrations');
const M055_NAME = '055_sender_presets.sql';
const sql055 = readFileSync(join(MIG_DIR, M055_NAME), 'utf8');
const BENIGN = /duplicate column name|already exists/i;

function splitSql(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/** schema.sql + 全 migration を replay (FK OFF・054 rebuild は fresh のため安全)。 */
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

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','tok','sec')`).run();
});

describe('migration 055: sender_presets + broadcasts.sender_preset_id (additive)', () => {
  it('checkMigration passes 055 as a plain additive migration (no rebuild exception needed)', () => {
    expect(checkMigration(sql055, M055_NAME)).toEqual({ ok: true });
    // 一般 migration 扱い (filename 無し) でも通る = 破壊操作ゼロ。
    expect(checkMigration(sql055)).toEqual({ ok: true });
  });

  it('contains no table-rebuild patterns (_new / DROP TABLE broadcasts / RENAME)', () => {
    expect(sql055).not.toMatch(/broadcasts_new/i);
    expect(sql055).not.toMatch(/\bDROP\s+TABLE\s+broadcasts\b/i);
    expect(sql055).not.toMatch(/\bRENAME\s+(TO|COLUMN)\b/i);
    expect(sql055).toMatch(/CREATE TABLE IF NOT EXISTS sender_presets/i);
    expect(sql055).toMatch(/ALTER\s+TABLE\s+broadcasts\s+ADD\s+COLUMN\s+sender_preset_id\s+TEXT\s+REFERENCES\s+sender_presets/i);
  });

  it('creates sender_presets (account-scoped) and broadcasts keeps only sender_preset_id (no raw name/icon columns)', () => {
    const sp = (raw.prepare("PRAGMA table_info('sender_presets')").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(sp).toEqual(['created_at', 'icon_url', 'id', 'line_account_id', 'name']);
    const bcols = (raw.prepare("PRAGMA table_info('broadcasts')").all() as Array<{ name: string }>).map((r) => r.name);
    expect(bcols).toContain('sender_preset_id');
    expect(bcols).not.toContain('sender_name'); // 生 name/iconUrl は broadcasts に持たない (id 参照)
    expect(bcols).not.toContain('sender_icon_url');
  });

  it('[FK] deleting a line_account cascades its sender_presets', () => {
    raw.pragma('foreign_keys = ON');
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name) VALUES ('sp-1','acc-1','担当A')`).run();
    raw.prepare(`DELETE FROM line_accounts WHERE id='acc-1'`).run();
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM sender_presets`).get() as { n: number }).n).toBe(0);
  });

  it('[FK] deleting a preset sets broadcasts.sender_preset_id to NULL (broadcast survives)', () => {
    raw.pragma('foreign_keys = ON');
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name) VALUES ('sp-1','acc-1','担当A')`).run();
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, sender_preset_id) VALUES ('b-1','T','text','hi','sp-1')`).run();
    raw.prepare(`DELETE FROM sender_presets WHERE id='sp-1'`).run();
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM broadcasts`).get() as { n: number }).n).toBe(1);
    expect((raw.prepare(`SELECT sender_preset_id FROM broadcasts WHERE id='b-1'`).get() as { sender_preset_id: string | null }).sender_preset_id).toBeNull();
  });
});

describe('T-C3 db model: BroadcastMessageType + createBroadcast/updateBroadcast sender_preset_id', () => {
  it('BroadcastMessageType includes the new broadcast types', () => {
    const types: BroadcastMessageType[] = ['text', 'image', 'flex', 'video', 'audio', 'imagemap', 'richvideo'];
    expect(types).toHaveLength(7);
  });

  it('createBroadcast persists a new message type (video) — CHECK now allows it', async () => {
    const b = await createBroadcast(db, { title: 'V', messageType: 'video', messageContent: '{}', targetType: 'all' });
    expect(b.message_type).toBe('video');
  });

  it('createBroadcast stores sender_preset_id when provided, null when omitted', async () => {
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name) VALUES ('sp-1','acc-1','担当A')`).run();
    const withPreset = await createBroadcast(db, { title: 'T', messageType: 'text', messageContent: 'hi', targetType: 'all', senderPresetId: 'sp-1' });
    expect(withPreset.sender_preset_id).toBe('sp-1');
    const noPreset = await createBroadcast(db, { title: 'T2', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    expect(noPreset.sender_preset_id).toBeNull();
  });

  it('updateBroadcast sets sender_preset_id', async () => {
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name) VALUES ('sp-1','acc-1','担当A')`).run();
    const b = await createBroadcast(db, { title: 'T', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    const updated = await updateBroadcast(db, b.id, { sender_preset_id: 'sp-1' });
    expect(updated?.sender_preset_id).toBe('sp-1');
    const cleared = await updateBroadcast(db, b.id, { sender_preset_id: null });
    expect(cleared?.sender_preset_id).toBeNull();
  });
});
