import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const { processSpy, metadataSpy } = vi.hoisted(() => ({
  processSpy: vi.fn(),
  metadataSpy: vi.fn(() => ({ trackingCode: 'TRACK-77', submitNumber: '77', pdfLink: 'https://files.example.test/77.pdf' })),
}));

vi.mock('../services/formaloo-edit-mail.js', () => ({
  processFormalooEditMail: processSpy,
  extractFormalooReceiptMetadata: metadataSpy,
}));

import { formalooPublic } from './formaloo-public.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const TOKEN = 'webhook-token';
const HMAC_SECRET = 'webhook-secret';

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
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function bindings(patch: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'k',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://worker.example.test',
    FORMALOO_WEBHOOK_TOKEN: TOKEN, FORMALOO_WEBHOOK_SECRET: HMAC_SECRET,
    FORM_EDIT_MAIL_ENABLED: 'true',
    ...patch,
  } as Env['Bindings'];
}

function seedForm(allowPostEdit = 1, allowEditMail = 1) {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, formaloo_slug, title, definition_json, builder_status, allow_post_edit, allow_edit_mail, edit_mail_field_slug)
     VALUES ('form-1','remote-form','資料請求','{"fields":[],"logic":[]}','published',?,?,'mail-slug')`,
  ).run(allowPostEdit, allowEditMail);
  raw.prepare(
    `INSERT INTO formaloo_field_map
       (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES ('mail','form-1','mail-slug','email','メール',0,'{}','2026-07-19','2026-07-19')`,
  ).run();
}

async function signature(body: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(HMAC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function post(patch: Partial<Env['Bindings']> = {}) {
  const payload = {
    submit_code: 'submission-1', form: 'remote-form', slug: 'row-slug',
    data: { 'mail-slug': 'owner@example.test' },
    tracking_code: 'TRACK-77', submit_number: 77, pdf_link: 'https://files.example.test/77.pdf',
  };
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const waitUntil = vi.fn();
  const executionCtx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const app = new Hono<Env>();
  app.route('/', formalooPublic);
  const response = await app.request(`/formaloo/webhook/${TOKEN}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-formaloo-signature': await signature(body, timestamp),
      'x-formaloo-timestamp': timestamp,
    },
    body,
  }, bindings(patch), executionCtx);
  return { response, waitUntil, payload };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  processSpy.mockReset();
  metadataSpy.mockClear();
});

describe('Formaloo webhook edit-mail Phase B', () => {
  it('metadataをmirrorへ保存し、送信処理をwaitUntilへ渡して失敗しても200を返す', async () => {
    seedForm();
    processSpy.mockRejectedValueOnce(new Error('provider failed'));

    const { response, waitUntil, payload } = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(metadataSpy).toHaveBeenCalledWith(payload);
    expect(raw.prepare("SELECT tracking_code, submit_number, pdf_link FROM formaloo_submissions WHERE id='submission-1'").get())
      .toEqual({ tracking_code: 'TRACK-77', submit_number: '77', pdf_link: 'https://files.example.test/77.pdf' });
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({ DB }), { submissionId: 'submission-1', mode: 'initial' });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('env kill-switch未設定ならmail jobをqueueしない', async () => {
    seedForm();
    const { response, waitUntil } = await post({ FORM_EDIT_MAIL_ENABLED: undefined });
    expect(response.status).toBe(200);
    expect(processSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([[0, 1], [1, 0]])('form gateがOFFならmail jobをqueueしない (%s/%s)', async (postEdit, editMail) => {
    seedForm(postEdit, editMail);
    const { response, waitUntil } = await post();
    expect(response.status).toBe(200);
    expect(processSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
