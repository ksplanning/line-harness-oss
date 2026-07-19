import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEditMailSend,
  saveFormalooDefinition,
  upsertFormalooSubmission,
} from '@line-crm/db';
import { verifyEditToken } from './formaloo-edit-token.js';
import {
  extractFormalooReceiptMetadata,
  processFormalooEditMail,
  runFormalooEditMailOutbox,
} from './formaloo-edit-mail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((sql) => sql.trim()).filter(Boolean);
    for (const sql of statements) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

const env = (patch: Record<string, unknown> = {}) => ({
  DB,
  FORM_EDIT_MAIL_ENABLED: 'true',
  RESEND_API_KEY: 'resend-secret',
  FORM_EDIT_MAIL_FROM: '受付 <no-reply@testline.example>',
  FORMALOO_EDIT_TOKEN_SECRET: 'edit-token-secret',
  WORKER_PUBLIC_URL: 'https://worker.example.test',
  ...patch,
});

async function seed(opts: { explicitSlug?: string | null; fieldType?: string; recipient?: string } = {}) {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, formaloo_slug, title, definition_json, builder_status, allow_post_edit, allow_edit_mail, edit_mail_field_slug)
     VALUES ('form-1', 'remote-form', '資料請求', '{"fields":[],"logic":[]}', 'published', 1, 1, ?)`,
  ).run(opts.explicitSlug === undefined ? 'mail-slug' : opts.explicitSlug);
  await saveFormalooDefinition(DB, 'form-1', {
    definitionJson: '{"fields":[],"logic":[]}',
    fields: [
      { id: 'name', formalooFieldSlug: 'name-slug', fieldType: 'text', label: 'お名前', position: 0, configJson: '{}' },
      { id: 'mail', formalooFieldSlug: 'mail-slug', fieldType: opts.fieldType ?? 'email', label: 'メール', position: 1, configJson: '{}' },
    ],
  });
  await upsertFormalooSubmission(DB, {
    id: 'submission-1', formId: 'form-1', formalooSlug: 'remote-form', verified: true,
    answersJson: JSON.stringify({ 'name-slug': '山田 太郎', 'mail-slug': opts.recipient ?? 'owner@example.test' }),
    submittedAt: '2026-07-19T00:00:00Z', trackingCode: 'TRACK-1', submitNumber: '42',
    pdfLink: 'https://files.example.test/receipt.pdf',
  });
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('extractFormalooReceiptMetadata', () => {
  it('top-levelとdataから明示3キーだけを抽出する', () => {
    expect(extractFormalooReceiptMetadata({
      tracking_code: 'TRACK-9',
      data: { submit_number: 9, pdf_link: 'https://files.example.test/9.pdf', generate_pdf: 'forbidden' },
    })).toEqual({ trackingCode: 'TRACK-9', submitNumber: '9', pdfLink: 'https://files.example.test/9.pdf' });
  });
});

describe('processFormalooEditMail', () => {
  it.each([
    ['FORM_EDIT_MAIL_ENABLED', undefined, 'disabled'],
    ['RESEND_API_KEY', undefined, 'missing_api_key'],
    ['FORM_EDIT_MAIL_FROM', undefined, 'missing_from'],
    ['FORMALOO_EDIT_TOKEN_SECRET', undefined, 'missing_edit_secret'],
    ['WORKER_PUBLIC_URL', undefined, 'missing_public_url'],
  ])('%s 不足はclaimも送信もしない', async (key, value, reason) => {
    await seed();
    const send = vi.fn();

    await expect(processFormalooEditMail(env({ [key]: value }), { submissionId: 'submission-1', mode: 'initial' }, { send }))
      .resolves.toEqual({ status: 'skipped', reason });
    expect(send).not.toHaveBeenCalled();
    expect(await getEditMailSend(DB, 'submission-1')).toBeNull();
  });

  it('明示email slugだけを宛先にし、token/控え/受付番号/PDFを送ってsent記録する', async () => {
    await seed();
    const send = vi.fn(async (_senderEnv, input) => ({
      status: 'sent' as const,
      providerMessageId: 'resend-message-1',
      providerIdempotencyKey: input.idempotencyKey,
    }));

    await expect(processFormalooEditMail(env(), { submissionId: 'submission-1', mode: 'initial' }, { send }))
      .resolves.toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][1];
    expect(message.to).toBe('owner@example.test');
    expect(message.text).toContain('受付番号: TRACK-1');
    expect(message.text).toContain('お名前: 山田 太郎');
    expect(message.text).toContain('控えPDF: https://files.example.test/receipt.pdf');
    const editUrl = message.text.match(/編集用URL: (\S+)/)?.[1];
    expect(editUrl?.startsWith('https://worker.example.test/fe/')).toBe(true);
    const token = decodeURIComponent(editUrl!.split('/fe/')[1]);
    await expect(verifyEditToken(token, 'edit-token-secret', 1_753_000_000)).resolves.toMatchObject({
      formId: 'form-1', rowRef: 'submission-1', epoch: 0,
    });

    expect(await getEditMailSend(DB, 'submission-1')).toMatchObject({
      status: 'sent', attempt_count: 1, provider_message_id: 'resend-message-1',
    });
  });

  it.each([
    [{ explicitSlug: null }, 'missing_recipient_slug'],
    [{ explicitSlug: 'mail-slug', fieldType: 'text' }, 'invalid_recipient_slug'],
    [{ explicitSlug: 'other-slug' }, 'invalid_recipient_slug'],
    [{ recipient: 'not-an-email' }, 'invalid_recipient'],
  ])('先頭fallbackせず不正な明示宛先をskipする (%s)', async (seedOpts, reason) => {
    await seed(seedOpts);
    const send = vi.fn();
    await expect(processFormalooEditMail(env(), { submissionId: 'submission-1', mode: 'initial' }, { send }))
      .resolves.toEqual({ status: 'skipped', reason });
    expect(send).not.toHaveBeenCalled();
    expect(await getEditMailSend(DB, 'submission-1')).toBeNull();
  });

  it('failedをoutboxへ残し、cron retryは同じprovider key・同じ本文で成功する', async () => {
    await seed();
    const requests: Array<{ idempotencyKey: string; text: string }> = [];
    const send = vi.fn(async (_senderEnv, input) => {
      requests.push({ idempotencyKey: input.idempotencyKey, text: input.text });
      return requests.length === 1
        ? { status: 'failed' as const, error: 'resend_http_500', providerIdempotencyKey: input.idempotencyKey }
        : { status: 'sent' as const, providerMessageId: 'resend-message-2', providerIdempotencyKey: input.idempotencyKey };
    });

    await expect(processFormalooEditMail(env(), { submissionId: 'submission-1', mode: 'initial' }, { send }))
      .resolves.toEqual({ status: 'failed', reason: 'resend_http_500' });
    expect(await getEditMailSend(DB, 'submission-1')).toMatchObject({ status: 'failed', attempt_count: 1 });

    await expect(runFormalooEditMailOutbox(env(), { send })).resolves.toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(requests[1]).toEqual(requests[0]);
    expect(await getEditMailSend(DB, 'submission-1')).toMatchObject({ status: 'sent', attempt_count: 2 });
  });

  it('再送時にmirrorの宛先が変わっていたら第三者へ送らずterminal skipにする', async () => {
    await seed();
    const firstSend = vi.fn(async (_senderEnv, input) => ({
      status: 'failed' as const, error: 'resend_http_500', providerIdempotencyKey: input.idempotencyKey,
    }));
    await processFormalooEditMail(env(), { submissionId: 'submission-1', mode: 'initial' }, { send: firstSend });
    raw.prepare("UPDATE formaloo_submissions SET answers_json=? WHERE id='submission-1'")
      .run(JSON.stringify({ 'name-slug': '山田', 'mail-slug': 'other@example.test' }));
    const retrySend = vi.fn();

    await expect(runFormalooEditMailOutbox(env(), { send: retrySend }))
      .resolves.toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(retrySend).not.toHaveBeenCalled();
    expect(await getEditMailSend(DB, 'submission-1')).toMatchObject({ status: 'skipped', attempt_count: 1, error: 'recipient_changed' });
  });
});
