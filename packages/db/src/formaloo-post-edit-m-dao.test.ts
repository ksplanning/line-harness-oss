/**
 * form-post-edit (弾M / T-A2) — DAO: rowSlug COALESCE 保持 upsert / getFriendLatestSubmission (friend 厳密) /
 *   recordSubmissionEdit / getLatestEdit / updateSubmissionRowSlug (legacy backfill)。
 *   最重要 = getFriendLatestSubmission が friend_id 完全一致のみ (取り違え防止 / 別 friend の row を出さない)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  upsertFormalooSubmission,
  getFormalooSubmission,
  getFriendLatestSubmission,
  recordSubmissionEdit,
  getLatestEdit,
  updateSubmissionRowSlug,
} from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

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

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('form-post-edit — upsert rowSlug COALESCE 保持 (T-A2)', () => {
  test('rowSlug 付き upsert が formaloo_row_slug を保存する', async () => {
    await upsertFormalooSubmission(DB, { id: 's1', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00', rowSlug: 'ROW_ABC' });
    const row = await getFormalooSubmission(DB, 's1');
    expect(row?.formaloo_row_slug).toBe('ROW_ABC');
  });

  test('rowSlug=null の再 upsert は既存 row_slug を落とさない (COALESCE)', async () => {
    await upsertFormalooSubmission(DB, { id: 's2', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00', rowSlug: 'ROW_KEEP' });
    // 再送 (webhook) で rowSlug 未取得 = null。既存を上書きしない。
    await upsertFormalooSubmission(DB, { id: 's2', formId: 'f1', answersJson: '{"x":1}', submittedAt: '2026-07-17T01:00:00+09:00', rowSlug: null });
    const row = await getFormalooSubmission(DB, 's2');
    expect(row?.formaloo_row_slug).toBe('ROW_KEEP');
    expect(row?.answers_json).toBe('{"x":1}'); // 他フィールドは更新される
  });

  test('rowSlug 未指定 upsert は formaloo_row_slug = NULL', async () => {
    await upsertFormalooSubmission(DB, { id: 's3', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00' });
    const row = await getFormalooSubmission(DB, 's3');
    expect(row?.formaloo_row_slug).toBeNull();
  });

  test('F-H2: 既存が非 null なら再送の異なる非 null でも上書きしない (write-once)', async () => {
    await upsertFormalooSubmission(DB, { id: 's4', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00', rowSlug: 'ORIGINAL' });
    // 同 submission id の再送が異なる非 null rowSlug を持っても既存 mapping を守る (row_slug は Formaloo 側不変)。
    await upsertFormalooSubmission(DB, { id: 's4', formId: 'f1', answersJson: '{"x":1}', submittedAt: '2026-07-17T01:00:00+09:00', rowSlug: 'DIFFERENT' });
    const row = await getFormalooSubmission(DB, 's4');
    expect(row?.formaloo_row_slug).toBe('ORIGINAL'); // 上書きされない
    expect(row?.answers_json).toBe('{"x":1}');        // 他フィールドは更新される
  });

  test('F-H2: NULL の legacy row は再送の非 null で backfill される (null→値は許可)', async () => {
    await upsertFormalooSubmission(DB, { id: 's5', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00' }); // row_slug NULL
    await upsertFormalooSubmission(DB, { id: 's5', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T01:00:00+09:00', rowSlug: 'BACKFILLED' });
    expect((await getFormalooSubmission(DB, 's5'))?.formaloo_row_slug).toBe('BACKFILLED');
  });
});

describe('form-post-edit — getFriendLatestSubmission friend 厳密 (T-A2 / 取り違え防止)', () => {
  test('friend A の最新 row のみ返し friend B の row を絶対に返さない', async () => {
    await upsertFormalooSubmission(DB, { id: 'a1', formId: 'f1', friendId: 'frA', answersJson: '{"n":"A-old"}', submittedAt: '2026-07-17T00:00:00+09:00' });
    await upsertFormalooSubmission(DB, { id: 'a2', formId: 'f1', friendId: 'frA', answersJson: '{"n":"A-new"}', submittedAt: '2026-07-17T02:00:00+09:00' });
    await upsertFormalooSubmission(DB, { id: 'b1', formId: 'f1', friendId: 'frB', answersJson: '{"n":"B"}', submittedAt: '2026-07-17T03:00:00+09:00' });

    const latestA = await getFriendLatestSubmission(DB, 'f1', 'frA');
    expect(latestA?.id).toBe('a2'); // A の最新 (submitted_at DESC)
    expect(latestA?.answers_json).toBe('{"n":"A-new"}');
    // B の row (b1 が全体最新) を絶対に拾わない
    expect(latestA?.friend_id).toBe('frA');
  });

  test('別 form の同 friend row は混ぜない (form scope)', async () => {
    await upsertFormalooSubmission(DB, { id: 'x1', formId: 'f1', friendId: 'frA', answersJson: '{"f":1}', submittedAt: '2026-07-17T00:00:00+09:00' });
    await upsertFormalooSubmission(DB, { id: 'x2', formId: 'f2', friendId: 'frA', answersJson: '{"f":2}', submittedAt: '2026-07-17T05:00:00+09:00' });
    const latest = await getFriendLatestSubmission(DB, 'f1', 'frA');
    expect(latest?.id).toBe('x1');
  });

  test('該当 friend の row が無ければ null', async () => {
    const latest = await getFriendLatestSubmission(DB, 'f1', 'ghost');
    expect(latest).toBeNull();
  });

  test('F-I5: tz offset 混在でも時系列で最新を返す (lexical 順の罠を避ける)', async () => {
    // 実 instant: r_old=2026-07-16T20:00:00Z / r_new=2026-07-16T21:00:00Z (r_new が 1h 後 = 真の最新)。
    // だが r_new の TEXT '2026-07-16T21:00:00Z' は r_old の '2026-07-17T05:00:00+09:00' より lexical に小さい
    //   ('16'<'17') → 旧 lexical DESC は r_old を誤って最新に採る。julianday 正規化は r_new を正しく採る。
    await upsertFormalooSubmission(DB, { id: 'r_old', formId: 'f1', friendId: 'frA', answersJson: '{"n":"OLD"}', submittedAt: '2026-07-17T05:00:00+09:00' });
    await upsertFormalooSubmission(DB, { id: 'r_new', formId: 'f1', friendId: 'frA', answersJson: '{"n":"NEW"}', submittedAt: '2026-07-16T21:00:00Z' });
    const latest = await getFriendLatestSubmission(DB, 'f1', 'frA');
    expect(latest?.id).toBe('r_new'); // 真の最新 (21:00Z > 20:00Z)
    expect(latest?.answers_json).toBe('{"n":"NEW"}');
  });

  test('F-I5: 同一 instant は後挿入 (rowid DESC) で tie-break', async () => {
    await upsertFormalooSubmission(DB, { id: 't1', formId: 'f1', friendId: 'frB', answersJson: '{"n":"first"}', submittedAt: '2026-07-17T10:00:00+09:00' });
    await upsertFormalooSubmission(DB, { id: 't2', formId: 'f1', friendId: 'frB', answersJson: '{"n":"second"}', submittedAt: '2026-07-17T10:00:00+09:00' });
    expect((await getFriendLatestSubmission(DB, 'f1', 'frB'))?.id).toBe('t2');
  });
});

describe('form-post-edit — edits 記録/参照 + rowSlug backfill (T-A2)', () => {
  test('recordSubmissionEdit が edits に 1 行残し getLatestEdit で読める', async () => {
    await recordSubmissionEdit(DB, { submissionId: 's1', formId: 'f1', editorStaffId: 'staff1', fieldSlug: 'name', oldValue: 'before', newValue: 'after' });
    const latest = await getLatestEdit(DB, 's1');
    expect(latest?.editor_staff_id).toBe('staff1');
    expect(latest?.old_value).toBe('before');
    expect(latest?.new_value).toBe('after');
    expect(latest?.field_slug).toBe('name');
  });

  test('getLatestEdit は edited_at DESC で最新を返す', async () => {
    raw.prepare(
      `INSERT INTO formaloo_submission_edits (id, submission_id, form_id, editor_staff_id, edited_at, field_slug, old_value, new_value)
       VALUES ('e1','s9','f1','st','2026-07-17T01:00:00+09:00','a','1','2'),
              ('e2','s9','f1','st','2026-07-17T03:00:00+09:00','a','2','3')`,
    ).run();
    const latest = await getLatestEdit(DB, 's9');
    expect(latest?.id).toBe('e2');
  });

  test('getLatestEdit は編集履歴が無ければ null', async () => {
    expect(await getLatestEdit(DB, 'none')).toBeNull();
  });

  test('updateSubmissionRowSlug は NULL の legacy row のみ後埋めし既存値を上書きしない', async () => {
    await upsertFormalooSubmission(DB, { id: 'leg', formId: 'f1', answersJson: '{}', submittedAt: '2026-07-17T00:00:00+09:00' }); // row_slug NULL
    await updateSubmissionRowSlug(DB, 'leg', 'RESOLVED');
    expect((await getFormalooSubmission(DB, 'leg'))?.formaloo_row_slug).toBe('RESOLVED');
    // 既に値がある row は上書きしない
    await updateSubmissionRowSlug(DB, 'leg', 'SHOULD_NOT_REPLACE');
    expect((await getFormalooSubmission(DB, 'leg'))?.formaloo_row_slug).toBe('RESOLVED');
  });
});
