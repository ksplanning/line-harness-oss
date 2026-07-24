import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  addInternalFormAttachmentFiles,
  removeInternalFormAttachmentFile,
} from '../client/internal-form-attachment.js';
import { signFriendToken } from '../services/formaloo-friend-token.js';
import { internalFormsPublic } from './internal-forms-public.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

const fields = [
  { id: 'text', type: 'text', label: '短文', required: true, position: 0, config: { description: '補足', placeholder: '短文の例', minLength: 2, maxLength: 5 } },
  { id: 'textarea', type: 'textarea', label: '長文', required: false, position: 1, config: { placeholder: '長文の例', minLength: 2, maxLength: 10 } },
  { id: 'number', type: 'number', label: '数量', required: true, position: 2, config: { placeholder: '2' } },
  { id: 'choice', type: 'choice', label: '単一', required: true, position: 3, config: { choices: ['赤', '青'], defaultValue: '青', placeholder: '色を選ぶ' } },
  { id: 'dropdown', type: 'dropdown', label: '一覧', required: true, position: 4, config: { choices: ['東', '西'], defaultValue: '西', placeholder: '地域を選ぶ' } },
  { id: 'multiple', type: 'multiple_select', label: '複数', required: true, position: 5, config: { choices: ['A', 'B'], defaultValues: ['B'], placeholder: '複数選択できます' } },
  { id: 'rating', type: 'rating', label: '星評価', required: true, position: 6, config: { placeholder: '星を選ぶ' } },
  { id: 'signature', type: 'signature', label: '署名', required: true, position: 7, config: { placeholder: '枠内に署名' } },
  { id: 'file', type: 'file', label: '資料', required: true, position: 8, config: { placeholder: 'PDFのみ', allowedExtensions: ['pdf'], maxSizeKb: 256 } },
  { id: 'matrix', type: 'matrix', label: '満足度表', required: true, position: 9, config: {
    placeholder: '各行を選ぶ',
    matrixChoiceItems: { low: { title: '低い' }, high: { title: '高い' } },
    matrixChoiceGroups: [{ title: '接客' }, { title: '商品' }],
  } },
  { id: 'repeat', type: 'repeating_section', label: '参加者', required: true, position: 10, config: {
    placeholder: '参加者を追加',
    repeatingColumns: [{ columnField: 'participant_name', title: '名前' }, { columnField: 'participant_count', title: '人数' }],
    minRows: 1,
    maxRows: 3,
  } },
  { id: 'calc', type: 'variable', label: '合計', required: false, position: 11, config: { variableSubType: 'formula', formula: '{number} * 2', decimalPlaces: 0 } },
  { id: 'yes', type: 'yes_no', label: '同意', required: true, position: 12, config: { placeholder: 'はい・いいえ' } },
  { id: 'time', type: 'time', label: '時刻', required: true, position: 13, config: { placeholder: '09:30' } },
  { id: 'website', type: 'website', label: 'サイト', required: true, position: 14, config: { placeholder: 'https://example.jp' } },
  { id: 'datetime', type: 'datetime', label: '日時', required: true, position: 15, config: { placeholder: '日時を指定' } },
  { id: 'country', type: 'country', label: '国', required: true, position: 16, config: { placeholder: '日本' } },
  { id: 'postal', type: 'postal_code', label: '郵便番号', required: true, position: 17, config: { placeholder: '100-0001' } },
  { id: 'prefecture', type: 'prefecture', label: '都道府県', required: true, position: 18, config: { placeholder: '東京都' } },
  { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 19, config: { placeholder: '千代田区' } },
  { id: 'street', type: 'address_street', label: '町名番地', required: true, position: 20, config: { placeholder: '千代田1-1' } },
  { id: 'building', type: 'address_building', label: '建物', required: false, position: 21, config: { placeholder: '本館101' } },
  { id: 'participant_name', type: 'text', label: '参加者名の型', required: true, position: 22, config: { placeholder: '参加者名' } },
  { id: 'participant_count', type: 'number', label: '参加人数の型', required: true, position: 23, config: { placeholder: '1' } },
  { id: 'section', type: 'section', label: 'ご案内', required: false, position: 24, config: { text: '説明本文' } },
  { id: 'page', type: 'page_break', label: '次のページ', required: false, position: 25, config: {} },
  { id: 'video', type: 'video', label: '紹介動画', required: false, position: 26, config: { videoUrl: 'https://www.youtube.com/embed/demo', videoHeight: '350px' } },
  { id: 'image', type: 'image', label: '案内画像', required: false, position: 27, config: { imageUrl: 'https://cdn.example.test/form.png', imageAlt: '会場案内', imageWidth: 'medium' } },
];

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

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(statement); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function r2Stub(options: { failAt?: number } = {}): {
  bucket: R2Bucket;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  let puts = 0;
  const put = vi.fn(async () => {
    puts += 1;
    if (puts === options.failAt) throw new Error('R2 put failed');
    return {};
  });
  const del = vi.fn(async () => undefined);
  return { bucket: { put, delete: del } as unknown as R2Bucket, put, del };
}

let raw: Database.Database;
let DB: D1Database;

function env(bucket: R2Bucket): Env['Bindings'] {
  return {
    DB,
    IMAGES: bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://worker.example.test',
    FORMALOO_FRIEND_TOKEN_SECRET: 'secret',
  } as Env['Bindings'];
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormsPublic);
  return hono;
}

function seedForm(id = 'fa_w2', definitionFields: typeof fields = fields): void {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, title, description, definition_json, builder_status, render_backend, submit_message)
     VALUES (?, '全パーツ', '説明', ?, 'published', 'internal', '完了')`,
  ).run(id, JSON.stringify({ fields: definitionFields, logic: [] }));
}

function validMultipart(): FormData {
  const body = new FormData();
  const values: Record<number, string[]> = {
    0: ['太郎'], 1: ['よろしく'], 2: ['2'], 3: ['青'], 4: ['西'], 5: ['A', 'B'],
    6: ['5'], 7: ['data:image/png;base64,aGVsbG8='],
    9: ['unused'], 12: ['yes'], 13: ['09:30'], 14: ['https://example.jp'],
    15: ['2026-08-01T09:30'], 16: ['日本'], 17: ['100-0001'], 18: ['東京都'],
    19: ['千代田区'], 20: ['千代田1-1'], 21: ['本館101'],
  };
  for (const [index, entries] of Object.entries(values)) {
    for (const value of entries) body.append(`a_${index}`, value);
  }
  body.delete('a_9');
  body.append('a_9_m_0', 'high');
  body.append('a_9_m_1', 'low');
  body.append('a_10_count', '1');
  body.append('a_10_r_0_0', '花子');
  body.append('a_10_r_0_1', '3');
  body.append('a_8', new File(['%PDF-1.7'], 'answer.pdf', { type: 'application/pdf' }));
  return body;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => {
  raw.close();
});

describe('internal public form W2 rendering', () => {
  test('renders advanced, Japanese-address, and decoration parts with defaults and progressive behavior', async () => {
    seedForm();
    const r2 = r2Stub();
    const response = await app().request('/f/fa_w2', {}, env(r2.bucket));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toMatch(/<textarea[^>]+name="a_1"[^>]+placeholder="長文の例"/);
    expect(html).toContain('data-character-counter');
    expect(html).toContain('Array.from');
    expect(html).toMatch(/name="a_3" value="青"[^>]* checked/);
    expect(html).toMatch(/<option value="西" selected>/);
    expect(html).toMatch(/name="a_5" value="B"[^>]* checked/);
    expect(html).toMatch(/type="radio" name="a_6" value="5"/);
    expect(html).toMatch(/<canvas[^>]+data-signature-canvas/);
    expect(html).toMatch(/type="hidden"[^>]+name="a_7"/);
    expect(html).toMatch(/type="file"[^>]+name="a_8"[^>]+accept="\.pdf"/);
    expect(html).toContain('name="a_9_m_0"');
    expect(html).toContain('name="a_10_count"');
    expect(html).toContain('name="a_10_r_0_0"');
    expect(html).toMatch(/<output[^>]+data-formula[^>]+data-expression="\{number\} \* 2"/);
    expect(html).toMatch(/type="radio" name="a_12" value="yes"/);
    expect(html).toMatch(/type="time"[^>]+name="a_13"/);
    expect(html).toMatch(/type="url"[^>]+name="a_14"/);
    expect(html).toMatch(/type="datetime-local"[^>]+name="a_15"/);
    expect(html).toMatch(/name="a_13"[^>]+placeholder="09:30"/);
    expect(html).toMatch(/name="a_14"[^>]+placeholder="https:\/\/example\.jp"/);
    expect(html).toMatch(/name="a_15"[^>]+placeholder="日時を指定"/);
    expect(html).toMatch(/name="a_16"[^>]+placeholder="日本"/);
    expect(html).toMatch(/name="a_17"[^>]+placeholder="100-0001"/);
    expect(html).toMatch(/<select[^>]+name="a_18"[^>]*><option value="">東京都/);
    expect(html).toMatch(/name="a_19"[^>]+placeholder="千代田区"/);
    expect(html).toMatch(/name="a_20"[^>]+placeholder="千代田1-1"/);
    expect(html).toMatch(/name="a_21"[^>]+placeholder="本館101"/);
    expect(html).toContain('<section class="section-decoration"');
    expect(html).toContain('data-page-step');
    expect(html).toContain('data-page-next');
    expect(html).toContain('/_r_\\d+_/');
    expect(html).toContain("replace(/\\s+/g, '')");
    expect(html).toContain('(?:\\d+(?:\\.\\d*)?|\\.\\d+)');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(html).toContain('<iframe');
    expect(html).toContain('https://www.youtube.com/embed/demo');
    expect(html).toMatch(/<img[^>]+src="https:\/\/cdn\.example\.test\/form\.png"[^>]+alt="会場案内"/);
    expect(html).toContain('短文の例');
    expect(html).toContain('補足');
    expect(html).not.toContain('javascript:');
  });

  test('renders score ratings as a number input instead of a fixed star scale', async () => {
    seedForm('fa_score', [{
      id: 'score', type: 'rating', label: '点数', required: true, position: 0,
      config: { ratingSubType: 'score', placeholder: '点数を入力' },
    }] as typeof fields);

    const response = await app().request('/f/fa_score', {}, env(r2Stub().bucket));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toMatch(/type="number"[^>]+name="a_0"/);
    expect(html).toContain('placeholder="点数を入力"');
  });

  test('wires the attachment block and client asset for a simple file-only form', async () => {
    seedForm('fa_file_only', [{
      id: 'file', type: 'file', label: '資料', required: true, position: 0,
      config: {
        placeholder: 'PDFのみ', allowedExtensions: ['pdf'], maxSizeKb: 256,
        allowMultipleFiles: true,
      },
    }] as typeof fields);

    const response = await app().request('/f/fa_file_only', {}, env(r2Stub().bucket));
    const html = await response.text();
    const input = html.match(/<input type="file"[^>]*>/)?.[0] ?? '';

    expect(response.status).toBe(200);
    expect(html).toContain('data-file-attachment');
    expect(input).toContain('name="a_0"');
    expect(input).toContain('accept=".pdf"');
    expect(input).toContain('multiple');
    expect(input).toContain('required');
    expect(input).toContain('data-file-input');
    expect(input).toContain('data-max-files="10"');
    expect(input).toContain('data-max-size-kb="256"');
    expect(input).not.toContain('hidden');
    expect(input).not.toContain('disabled');
    expect(html).toContain('data-file-list');
    expect(html).toContain('data-file-status');
    expect(html).toContain('src="/assets/internal-form-logic.js"');
  });
});

describe('internal public form W2 multipart persistence', () => {
  test('uploads validated files privately and stores metadata with normalized advanced answers', async () => {
    seedForm();
    const r2 = r2Stub();
    const response = await app().request('/f/fa_w2', { method: 'POST', body: validMultipart() }, env(r2.bucket));

    expect(response.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(1);
    const key = String(r2.put.mock.calls[0]?.[0]);
    expect(key).toMatch(/^internal-form-submissions\/fa_w2\/file\/[0-9a-f-]+\.pdf$/);
    expect(key).not.toContain('/images/');
    const row = raw.prepare('SELECT answers_json FROM internal_form_submissions').get() as { answers_json: string };
    const answers = JSON.parse(row.answers_json) as Record<string, unknown>;
    expect(answers).toMatchObject({
      rating: 5,
      signature: 'data:image/png;base64,aGVsbG8=',
      matrix: { 接客: '高い', 商品: '低い' },
      repeat: [{ participant_name: '花子', participant_count: 3 }],
      calc: 4,
      yes: true,
      time: '09:30',
      website: 'https://example.jp',
      datetime: '2026-08-01T09:30',
      country: '日本',
      postal: '1000001',
      prefecture: '東京都',
      city: '千代田区',
      street: '千代田1-1',
      building: '本館101',
    });
    expect(answers.file).toEqual([{ key, name: 'answer.pdf', size: 8, type: 'application/pdf' }]);
    expect(JSON.stringify(answers)).not.toContain('/images/');
  });

  test('does not upload an invalid file', async () => {
    seedForm();
    const r2 = r2Stub();
    const body = validMultipart();
    body.delete('a_8');
    body.append('a_8', new File(['not allowed'], 'answer.exe', { type: 'application/octet-stream' }));

    const response = await app().request('/f/fa_w2', { method: 'POST', body }, env(r2.bucket));

    expect(response.status).toBe(400);
    expect(r2.put).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('persists the accumulated final client list in multipart order', async () => {
    const multipleFileFields = fields.map((field) => field.id === 'file'
      ? { ...field, config: { ...field.config, allowMultipleFiles: true } }
      : field);
    seedForm('fa_roundtrip', multipleFileFields);
    const r2 = r2Stub();
    const removed = new File(['remove'], 'removed.pdf', { type: 'application/pdf' });
    const kept = new File(['keep'], 'kept.pdf', { type: 'application/pdf' });
    const added = new File(['added'], 'added.pdf', { type: 'application/pdf' });
    let visibleFiles = addInternalFormAttachmentFiles([], [removed, kept], {
      accept: '.pdf', maxFiles: 10, maxSizeKb: 256,
    }).files;
    visibleFiles = removeInternalFormAttachmentFile(visibleFiles, 0);
    visibleFiles = addInternalFormAttachmentFiles(visibleFiles, [added], {
      accept: '.pdf', maxFiles: 10, maxSizeKb: 256,
    }).files;
    const body = validMultipart();
    body.delete('a_8');
    for (const file of visibleFiles) body.append('a_8', file);

    expect(visibleFiles.map((file) => file.name)).toEqual(['kept.pdf', 'added.pdf']);
    expect(body.getAll('a_8').map((entry) => (entry as File).name))
      .toEqual(visibleFiles.map((file) => file.name));

    const response = await app().request('/f/fa_roundtrip', { method: 'POST', body }, env(r2.bucket));

    expect(response.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(2);
    const row = raw.prepare(
      "SELECT answers_json FROM internal_form_submissions WHERE form_id = 'fa_roundtrip'",
    ).get() as { answers_json: string };
    const stored = (JSON.parse(row.answers_json) as {
      file: Array<{ key: string; name: string; size: number; type: string }>;
    }).file;
    expect(stored.map(({ name, size, type }) => ({ name, size, type }))).toEqual(
      visibleFiles.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    );
    expect(stored.map(({ key }) => key)).toEqual(r2.put.mock.calls.map(([key]) => key));
  });

  test('accepts a native file input submission without running the client enhancement', async () => {
    seedForm('fa_native_file', [{
      id: 'file', type: 'file', label: '資料', required: true, position: 0,
      config: { allowedExtensions: ['pdf'], maxSizeKb: 256 },
    }] as typeof fields);
    const r2 = r2Stub();
    const body = new FormData();
    body.append('a_0', new File(['native'], 'native.pdf', { type: 'application/pdf' }));

    const response = await app().request('/f/fa_native_file', { method: 'POST', body }, env(r2.bucket));

    expect(response.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(1);
    const row = raw.prepare(
      "SELECT answers_json FROM internal_form_submissions WHERE form_id = 'fa_native_file'",
    ).get() as { answers_json: string };
    expect((JSON.parse(row.answers_json) as { file: Array<{ name: string }> }).file)
      .toMatchObject([{ name: 'native.pdf' }]);
  });

  test('deduplicates the same uploaded bytes but preserves a different file as a new answer', async () => {
    seedForm('fa_file_dedup', [{
      id: 'file', type: 'file', label: '資料', required: true, position: 0,
      config: { allowedExtensions: ['pdf'], maxSizeKb: 256 },
    }] as typeof fields);
    raw.prepare(
      "INSERT INTO friends (id, line_user_id, display_name) VALUES ('friend-1', 'U1', '佐藤')",
    ).run();
    const token = await signFriendToken('friend-1', 'secret');
    const body = (contents: string) => {
      const value = new FormData();
      value.append('fr_id', token!);
      value.append('a_0', new File([contents], 'answer.pdf', { type: 'application/pdf' }));
      return value;
    };
    const r2 = r2Stub();

    expect((await app().request(
      '/f/fa_file_dedup',
      { method: 'POST', body: body('%PDF-same') },
      env(r2.bucket),
    )).status).toBe(200);
    expect((await app().request(
      '/f/fa_file_dedup',
      { method: 'POST', body: body('%PDF-same') },
      env(r2.bucket),
    )).status).toBe(200);
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_file_dedup'",
    ).get()).toEqual({ n: 1 });

    expect((await app().request(
      '/f/fa_file_dedup',
      { method: 'POST', body: body('%PDF-different') },
      env(r2.bucket),
    )).status).toBe(200);
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_file_dedup'",
    ).get()).toEqual({ n: 2 });
    expect(r2.put).toHaveBeenCalledTimes(3);
    expect(r2.del).toHaveBeenCalledTimes(1);
  });

  test('deletes uploaded objects when database persistence fails', async () => {
    seedForm();
    raw.exec(`CREATE TRIGGER fail_internal_submission BEFORE INSERT ON internal_form_submissions
      BEGIN SELECT RAISE(FAIL, 'forced persistence failure'); END`);
    const r2 = r2Stub();

    const response = await app().request('/f/fa_w2', { method: 'POST', body: validMultipart() }, env(r2.bucket));

    expect(response.status).toBe(500);
    expect(r2.put).toHaveBeenCalledTimes(1);
    expect(r2.del).toHaveBeenCalledWith(r2.put.mock.calls[0]?.[0]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('deletes every attempted object when one upload in a batch fails', async () => {
    const multipleFileFields = fields.map((field) => field.id === 'file'
      ? { ...field, config: { ...field.config, allowMultipleFiles: true } }
      : field);
    seedForm('fa_w2', multipleFileFields);
    const r2 = r2Stub({ failAt: 2 });
    const body = validMultipart();
    body.append('a_8', new File(['%PDF-second'], 'second.pdf', { type: 'application/pdf' }));

    const response = await app().request('/f/fa_w2', { method: 'POST', body }, env(r2.bucket));

    expect(response.status).toBe(500);
    expect(r2.put).toHaveBeenCalledTimes(2);
    expect(r2.del).toHaveBeenCalledTimes(2);
    expect(r2.del).toHaveBeenCalledWith(r2.put.mock.calls[0]?.[0]);
    expect(r2.del).toHaveBeenCalledWith(r2.put.mock.calls[1]?.[0]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });
});
