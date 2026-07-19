/**
 * form-edit-mail-link (弾L / T-A2) — DAO: allow_edit_mail present-key upsert / edit_mail_field_slug present-key /
 *   claimEditMailSend (submission_id UNIQUE で 1 回だけ true = 二重送信防止) / recordEditMailResult /
 *   resolveFormEmailFieldSlug (email 型 slug 解決 / OD-3・S-3) / bumpEditLinkEpoch (失効世代 bump / G-5)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  saveFormalooDefinition,
  getFormalooForm,
  claimEditMailSend,
  claimEditMailAttempt,
  listRetryableEditMailSends,
  recordEditMailResult,
  resolveFormEmailFieldSlug,
  bumpEditLinkEpoch,
  getEditMailSend,
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

function seedForm(id: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, builder_status) VALUES (?, 'フォーム', '{"fields":[],"logic":[]}', 'draft')`,
  ).run(id);
}
function seedField(id: string, formId: string, slug: string | null, type: string, position: number) {
  raw.prepare(
    `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, '2026-07-17T00:00:00+09:00','2026-07-17T00:00:00+09:00')`,
  ).run(id, formId, slug, type, `L_${id}`, position, '{}');
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('form-edit-mail-link — allow_edit_mail / edit_mail_field_slug present-key upsert (T-A2)', () => {
  test('allowEditMail present-key: 指定で更新・未指定は既存値不変 (弾S allow_post_edit 同型)', async () => {
    seedForm('f1');
    await saveFormalooDefinition(DB, 'f1', { definitionJson: '{"fields":[],"logic":[]}', fields: [], allowEditMail: 1 });
    expect((await getFormalooForm(DB, 'f1'))?.allow_edit_mail).toBe(1);
    // 未指定 PUT は allow_edit_mail を変えない
    await saveFormalooDefinition(DB, 'f1', { definitionJson: '{"fields":[],"logic":[]}', fields: [], title: '改題' });
    expect((await getFormalooForm(DB, 'f1'))?.allow_edit_mail).toBe(1);
    // 0 指定で 0 に
    await saveFormalooDefinition(DB, 'f1', { definitionJson: '{"fields":[],"logic":[]}', fields: [], allowEditMail: 0 });
    expect((await getFormalooForm(DB, 'f1'))?.allow_edit_mail).toBe(0);
  });

  test('editMailFieldSlug present-key: 指定で更新・未指定は不変', async () => {
    seedForm('f2');
    await saveFormalooDefinition(DB, 'f2', { definitionJson: '{"fields":[],"logic":[]}', fields: [], editMailFieldSlug: 'email_fld' });
    expect((await getFormalooForm(DB, 'f2'))?.edit_mail_field_slug).toBe('email_fld');
    await saveFormalooDefinition(DB, 'f2', { definitionJson: '{"fields":[],"logic":[]}', fields: [], title: 'x' });
    expect((await getFormalooForm(DB, 'f2'))?.edit_mail_field_slug).toBe('email_fld');
  });
});

describe('form-edit-mail-link — claimEditMailSend 冪等 (T-A2 / 二重送信防止)', () => {
  test('1 回目 true・2 回目 (同 submission_id) は false (UNIQUE claim)', async () => {
    expect(await claimEditMailSend(DB, { submissionId: 'sub1', formId: 'f1', recipientHash: 'h1' })).toBe(true);
    expect(await claimEditMailSend(DB, { submissionId: 'sub1', formId: 'f1', recipientHash: 'h1' })).toBe(false);
    const row = await getEditMailSend(DB, 'sub1');
    expect(row?.status).toBe('pending'); // claim=pending 予約 (喪失防止)
    expect(row?.recipient_hash).toBe('h1');
    expect(row?.attempt_count).toBe(0);
  });

  test('別 submission は各々 claim できる', async () => {
    expect(await claimEditMailSend(DB, { submissionId: 'subA', formId: 'f1', recipientHash: 'h' })).toBe(true);
    expect(await claimEditMailSend(DB, { submissionId: 'subB', formId: 'f1', recipientHash: 'h' })).toBe(true);
  });

  test('provider 冪等キーを pending 作成時に永続化する', async () => {
    await claimEditMailSend(DB, {
      submissionId: 'sub-key',
      formId: 'f1',
      recipientHash: 'h',
      providerIdempotencyKey: 'formaloo-edit-mail/sub-key',
    });
    expect((await getEditMailSend(DB, 'sub-key'))?.provider_idempotency_key).toBe('formaloo-edit-mail/sub-key');
  });
});

describe('form-edit-mail-link — recordEditMailResult 状態遷移 (T-A2)', () => {
  test('pending → sent (provider ack) を記録', async () => {
    await claimEditMailSend(DB, { submissionId: 'sub1', formId: 'f1', recipientHash: 'h' });
    await recordEditMailResult(DB, { submissionId: 'sub1', status: 'sent', providerMessageId: 'msg_123' });
    const row = await getEditMailSend(DB, 'sub1');
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('msg_123');
    expect(row?.attempt_count).toBe(1); // 試行 +1
  });

  test('pending → failed (error) を記録し attempt_count を +1', async () => {
    await claimEditMailSend(DB, { submissionId: 'sub2', formId: 'f1', recipientHash: 'h' });
    await recordEditMailResult(DB, { submissionId: 'sub2', status: 'failed', error: 'timeout' });
    const row = await getEditMailSend(DB, 'sub2');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('timeout');
    expect(row?.attempt_count).toBe(1);
  });
});

describe('form-edit-mail Phase B — bounded outbox attempt', () => {
  test('attempt を送信前に CAS claim し、同じ expected count の並行取得を拒否する', async () => {
    await claimEditMailSend(DB, {
      submissionId: 'sub-cas',
      formId: 'f1',
      recipientHash: 'h',
      providerIdempotencyKey: 'formaloo-edit-mail/sub-cas',
    });

    expect(await claimEditMailAttempt(DB, {
      submissionId: 'sub-cas', expectedAttemptCount: 0, maxAttempts: 3,
      providerIdempotencyKey: 'formaloo-edit-mail/sub-cas',
    })).toBe(true);
    expect(await claimEditMailAttempt(DB, {
      submissionId: 'sub-cas', expectedAttemptCount: 0, maxAttempts: 3,
      providerIdempotencyKey: 'formaloo-edit-mail/sub-cas',
    })).toBe(false);
    expect((await getEditMailSend(DB, 'sub-cas'))?.attempt_count).toBe(1);

    await recordEditMailResult(DB, {
      submissionId: 'sub-cas', status: 'failed', error: 'resend_http_500', attemptClaimed: true,
    });
    const row = await getEditMailSend(DB, 'sub-cas');
    expect(row?.attempt_count).toBe(1);
    expect(row?.status).toBe('failed');
  });

  test('pending/failed のみを古い順・limit・maxAttempts 未満で列挙する', async () => {
    for (const id of ['old', 'new', 'sent']) {
      await claimEditMailSend(DB, { submissionId: id, formId: 'f1', recipientHash: `h-${id}` });
    }
    raw.prepare("UPDATE formaloo_edit_mail_sends SET requested_at='2026-07-18T00:00:00+09:00' WHERE submission_id='old'").run();
    raw.prepare("UPDATE formaloo_edit_mail_sends SET requested_at='2026-07-19T00:00:00+09:00' WHERE submission_id='new'").run();
    raw.prepare("UPDATE formaloo_edit_mail_sends SET status='sent' WHERE submission_id='sent'").run();

    expect((await listRetryableEditMailSends(DB, { maxAttempts: 3, limit: 1 })).map((r) => r.submission_id)).toEqual(['old']);
    raw.prepare("UPDATE formaloo_edit_mail_sends SET attempt_count=3 WHERE submission_id='old'").run();
    expect((await listRetryableEditMailSends(DB, { maxAttempts: 3, limit: 10 })).map((r) => r.submission_id)).toEqual(['new']);
  });
});

describe('form-edit-mail-link — resolveFormEmailFieldSlug (T-A2 / S-3 / OD-3)', () => {
  test('email 型フィールドの slug を返す', async () => {
    seedForm('f1');
    seedField('fld_name', 'f1', 'name_slug', 'text', 0);
    seedField('fld_mail', 'f1', 'mail_slug', 'email', 1);
    expect(await resolveFormEmailFieldSlug(DB, 'f1')).toBe('mail_slug');
  });

  test('email 型が 0 個なら null (宛先解決不能 = skip 対象)', async () => {
    seedForm('f2');
    seedField('fld_name', 'f2', 'name_slug', 'text', 0);
    expect(await resolveFormEmailFieldSlug(DB, 'f2')).toBeNull();
  });

  test('slug 未確定 (NULL) の email 型は宛先に使えないため除外', async () => {
    seedForm('f3');
    seedField('fld_mail', 'f3', null, 'email', 0);
    expect(await resolveFormEmailFieldSlug(DB, 'f3')).toBeNull();
  });

  test('複数 email 欄は position 先頭を返す (OD-3 明示指定の enforce は Phase B fire 側)', async () => {
    seedForm('f4');
    seedField('m2', 'f4', 'mail2', 'email', 2);
    seedField('m1', 'f4', 'mail1', 'email', 1);
    expect(await resolveFormEmailFieldSlug(DB, 'f4')).toBe('mail1');
  });
});

describe('form-edit-mail-link — bumpEditLinkEpoch 失効世代 (T-A2 / G-5)', () => {
  test('bump で edit_link_epoch が +1 される (既発行 token 一括失効の芯)', async () => {
    seedForm('f1');
    expect((await getFormalooForm(DB, 'f1'))?.edit_link_epoch).toBe(0);
    await bumpEditLinkEpoch(DB, 'f1');
    expect((await getFormalooForm(DB, 'f1'))?.edit_link_epoch).toBe(1);
    await bumpEditLinkEpoch(DB, 'f1');
    expect((await getFormalooForm(DB, 'f1'))?.edit_link_epoch).toBe(2);
  });
});
