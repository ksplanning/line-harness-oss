/**
 * form-edit-mail-link (弾L / T-A1) — migration 101 additive:
 *   formaloo_forms.allow_edit_mail (弾S allow_post_edit 同型) + edit_mail_field_slug (OD-3 送付先指定) +
 *   edit_link_epoch (T-B4 失効世代) / 新 table formaloo_edit_mail_sends (Codex G-3/G-4 outbox)。
 *   additive のみ (NULL 列 / NOT NULL DEFAULT 0 / CREATE TABLE)・既存行不変・POLICY_CUTOFF=041 準拠。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('form-edit-mail-link — migration 101 additive (T-A1)', () => {
  test('formaloo_forms に allow_edit_mail が存在し NOT NULL DEFAULT 0', () => {
    const cols = raw.prepare("PRAGMA table_info(formaloo_forms)").all() as { name: string; notnull: number; dflt_value: string | null }[];
    const col = cols.find((c) => c.name === 'allow_edit_mail');
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(1);
    expect(String(col!.dflt_value)).toBe('0');
  });

  test('formaloo_forms に edit_mail_field_slug (TEXT NULL 可) と edit_link_epoch (NOT NULL DEFAULT 0) が存在', () => {
    const cols = raw.prepare("PRAGMA table_info(formaloo_forms)").all() as { name: string; notnull: number; dflt_value: string | null }[];
    const slug = cols.find((c) => c.name === 'edit_mail_field_slug');
    expect(slug).toBeTruthy();
    expect(slug!.notnull).toBe(0); // NULL 可 (未指定 form)
    const epoch = cols.find((c) => c.name === 'edit_link_epoch');
    expect(epoch).toBeTruthy();
    expect(epoch!.notnull).toBe(1);
    expect(String(epoch!.dflt_value)).toBe('0');
  });

  test('既存 form 行は allow_edit_mail=0 / edit_link_epoch=0 / edit_mail_field_slug=NULL (additive 無破壊)', () => {
    raw.prepare(
      `INSERT INTO formaloo_forms (id, title, definition_json, builder_status) VALUES ('f1','t','{"fields":[],"logic":[]}','draft')`,
    ).run();
    const row = raw.prepare('SELECT allow_edit_mail AS m, edit_link_epoch AS e, edit_mail_field_slug AS s FROM formaloo_forms WHERE id=?').get('f1') as { m: number; e: number; s: string | null };
    expect(row.m).toBe(0);
    expect(row.e).toBe(0);
    expect(row.s).toBeNull();
  });

  test('formaloo_edit_mail_sends 表が outbox 列で存在する (Codex G-3/G-4)', () => {
    const cols = (raw.prepare("PRAGMA table_info(formaloo_edit_mail_sends)").all() as { name: string }[]).map((c) => c.name).sort();
    expect(cols).toEqual(
      ['attempt_count', 'error', 'form_id', 'id', 'last_attempt_at', 'provider_idempotency_key', 'provider_message_id', 'recipient_hash', 'requested_at', 'status', 'submission_id'].sort(),
    );
  });

  test('formaloo_edit_mail_sends.submission_id が UNIQUE (冪等 claim = 二重送信防止)', () => {
    raw.prepare(
      `INSERT INTO formaloo_edit_mail_sends (id, submission_id, form_id, recipient_hash, requested_at, status) VALUES ('m1','sub1','f1','h','2026-07-17T00:00:00+09:00','pending')`,
    ).run();
    expect(() =>
      raw.prepare(
        `INSERT INTO formaloo_edit_mail_sends (id, submission_id, form_id, recipient_hash, requested_at, status) VALUES ('m2','sub1','f1','h','2026-07-17T00:00:01+09:00','pending')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
  });

  test('migration 101 は additive のみ (DROP/RENAME/CHECK/ADD COLUMN NOT NULL without DEFAULT を含まない)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '101_formaloo_edit_mail.sql'), 'utf8')
      .split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+(COLUMN|TO)\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i);
    expect(sql).not.toMatch(/\bCHECK\s*\(/i);
    expect(sql).not.toMatch(/\bADD\s+COLUMN\s+\S+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i);
  });
});
