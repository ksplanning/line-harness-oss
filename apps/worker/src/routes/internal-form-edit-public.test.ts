// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { File as NodeFile } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { editTokenExp, signEditToken } from '../services/formaloo-edit-token.js';
import { initInternalFormLogic } from '../client/internal-form-logic.js';
const sheetsSyncMocks = vi.hoisted(() => ({
  syncSheetsAfterFormMutation: vi.fn(),
}));
vi.mock('../services/sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/sheets-sync-jobs.js')>(),
  syncSheetsAfterFormMutation: sheetsSyncMocks.syncSheetsAfterFormMutation,
}));
import { internalFormEditPublic } from './internal-form-edit-public.js';
import { internalFormsAdmin } from './internal-forms-admin.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const EDIT_SECRET = 'internal-edit-route-secret';

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
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

const definition = {
  fields: [
    { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: { maxLength: 20 } },
    { id: 'email', type: 'email', label: 'メール', required: true, position: 1, config: {} },
    { id: 'attachment', type: 'file', label: '添付', required: true, position: 2, config: {} },
    { id: 'signature', type: 'signature', label: '署名', required: true, position: 3, config: {} },
    {
      id: 'matrix', type: 'matrix', label: '評価', required: true, position: 4,
      config: {
        matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
        matrixChoiceGroups: [{ title: '接客' }],
      },
    },
    { id: 'repeat_name', type: 'text', label: '参加者名', required: true, position: 5, config: {} },
    { id: 'repeat_age', type: 'number', label: '年齢', required: true, position: 6, config: {} },
    {
      id: 'repeat', type: 'repeating_section', label: '参加者', required: true, position: 7,
      config: {
        repeatingColumns: [
          { columnField: 'repeat_name', title: '氏名' },
          { columnField: 'repeat_age', title: '年齢' },
        ],
        minRows: 1,
        maxRows: 3,
      },
    },
  ],
  logic: [],
};

const originalAnswers = {
  name: '佐藤 <script>',
  email: 'old@example.test',
  attachment: [{ key: 'private/file.pdf', name: '申込書.pdf', size: 123, type: 'application/pdf' }],
  signature: 'data:image/png;base64,c2lnbmF0dXJl',
  matrix: { 接客: '良い' },
  repeat: [{ repeat_name: '田中', repeat_age: 20 }],
};

const attachmentDefinition = {
  fields: [{
    id: 'attachment', type: 'file', label: '添付資料', required: true, position: 0,
    config: {
      allowMultipleFiles: true,
      allowedExtensions: ['png', 'pdf'],
      maxSizeKb: 256,
    },
  }],
  logic: [],
};

const editLockedDefinition = {
  fields: [
    {
      id: 'locked_name',
      type: 'text',
      label: '確定済み氏名',
      required: true,
      position: 0,
      config: { editLocked: true },
    },
    {
      id: 'open_note',
      type: 'text',
      label: '追記事項',
      required: false,
      position: 1,
      config: {},
    },
  ],
  logic: [],
};

const editLockedAttachmentDefinition = {
  fields: [{
    ...attachmentDefinition.fields[0],
    config: {
      ...attachmentDefinition.fields[0].config,
      editLocked: true,
    },
  }],
  logic: [],
};

function storedAttachment(
  key: string,
  name: string,
  type: string,
  size = 8,
): { key: string; name: string; size: number; type: string } {
  return { key, name, size, type };
}

const conditionalDefinition = {
  fields: [
    { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: ['個人', '法人'] } },
    { id: 'personal', type: 'text', label: 'お名前', required: true, position: 1, config: {} },
    { id: 'company', type: 'text', label: '会社名', required: true, position: 2, config: {} },
  ],
  logic: [
    { id: 'show-personal', sourceFieldId: 'kind', operator: 'equals', value: '個人', action: 'show', targetFieldId: 'personal' },
    { id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'company' },
  ],
};

const fileSourceDefinition = {
  fields: [
    { ...attachmentDefinition.fields[0], required: false },
    { id: 'attachment_note', type: 'text', label: '添付後の連絡', required: true, position: 1, config: {} },
  ],
  logic: [{
    id: 'attachment-answered',
    sourceFieldId: 'attachment',
    operator: 'equals',
    value: 'unused',
    action: 'show',
    targetFieldId: 'attachment_note',
    conditionJoin: 'and',
    conditions: [{ sourceFieldId: 'attachment', operator: 'is_answered', value: '' }],
  }],
};

const initiallyHiddenAttachmentDefinition = {
  fields: [
    { id: 'gate', type: 'choice', label: '添付の有無', required: true, position: 0, config: { choices: ['隠す', '表示する'] } },
    { ...attachmentDefinition.fields[0], position: 1 },
  ],
  logic: [{
    id: 'show-attachment', sourceFieldId: 'gate', operator: 'equals', value: '表示する',
    action: 'show', targetFieldId: 'attachment',
  }],
};

let raw: Database.Database;
let DB: D1Database;

function bindings(
  db = DB,
  overrides: Partial<Env['Bindings']> = {},
): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://worker.example.test',
    FORMALOO_EDIT_TOKEN_SECRET: EDIT_SECRET,
    ...overrides,
  } as Env['Bindings'];
}

function r2Stub(entries: Record<string, { body: string; type: string }> = {}): {
  bucket: R2Bucket;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (key: string) => {
    const entry = entries[key];
    if (!entry) return null;
    return {
      body: new TextEncoder().encode(entry.body),
      httpMetadata: { contentType: entry.type },
    } as unknown as R2ObjectBody;
  });
  const put = vi.fn(async () => ({}));
  const del = vi.fn(async () => undefined);
  return {
    bucket: { get, put, delete: del } as unknown as R2Bucket,
    get,
    put,
    del,
  };
}

type MultipartTestEntry =
  | { name: string; value: string }
  | { name: string; filename: string; type: string; content: string };

function multipartRequest(entries: MultipartTestEntry[]): {
  headers: Record<string, string>;
  body: string;
} {
  const boundary = '----line-harness-edit-attachment-test';
  const body = entries.map((entry) => {
    if ('filename' in entry) {
      return `--${boundary}\r\nContent-Disposition: form-data; name="${entry.name}"; filename="${entry.filename}"\r\nContent-Type: ${entry.type}\r\n\r\n${entry.content}\r\n`;
    }
    return `--${boundary}\r\nContent-Disposition: form-data; name="${entry.name}"\r\n\r\n${entry.value}\r\n`;
  }).join('') + `--${boundary}--\r\n`;
  return {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  };
}

async function sendMultipart(
  path: string,
  request: ReturnType<typeof multipartRequest>,
  env: Env['Bindings'],
): Promise<Response> {
  const browserFile = globalThis.File;
  Object.defineProperty(globalThis, 'File', { configurable: true, value: NodeFile, writable: true });
  try {
    return await app().request(path, { method: 'POST', ...request }, env);
  } finally {
    Object.defineProperty(globalThis, 'File', { configurable: true, value: browserFile, writable: true });
  }
}

function rotateEpochBeforeSubmissionUpdate(): D1Database {
  let rotated = false;
  return {
    prepare(sql: string) {
      if (!rotated && /^\s*UPDATE internal_form_submissions\b/.test(sql)) {
        raw.prepare(
          'UPDATE internal_form_notification_settings SET edit_link_epoch = edit_link_epoch + 1 WHERE form_id = ?',
        ).run('form-1');
        rotated = true;
      }
      return DB.prepare(sql);
    },
  } as D1Database;
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormEditPublic);
  return hono;
}

function adminApp(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormsAdmin);
  return hono;
}

function seedForm(options: {
  id?: string;
  backend?: 'formaloo' | 'internal';
  status?: string;
  epoch?: number;
  withSettings?: boolean;
  definition?: unknown;
  allowBranchEdit?: number;
} = {}): string {
  const id = options.id ?? 'form-1';
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, builder_status, render_backend, allow_branch_edit)
     VALUES (?, '回答編集テスト', ?, ?, ?, ?)`,
  ).run(
    id,
    JSON.stringify(options.definition ?? definition),
    options.status ?? 'published',
    options.backend ?? 'internal',
    options.allowBranchEdit ?? 0,
  );
  if (options.withSettings !== false) {
    raw.prepare(
      `INSERT INTO internal_form_notification_settings
         (form_id, enabled, recipient_email_field_id, message_template, edit_link_epoch, created_at, updated_at)
       VALUES (?, 1, 'email', NULL, ?, '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00')`,
    ).run(id, options.epoch ?? 4);
  }
  return id;
}

function seedSubmissionAs(
  id: string,
  formId = 'form-1',
  answers: unknown = originalAnswers,
  editVersion = 3,
): string {
  raw.prepare(
    `INSERT INTO internal_form_submissions
       (id, form_id, friend_id, answers_json, origin_channel, edit_version, submitted_at, created_at)
     VALUES (?, ?, NULL, ?, 'embed', ?, '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00')`,
  ).run(id, formId, JSON.stringify(answers), editVersion);
  return id;
}

function seedSubmission(formId = 'form-1', answers = originalAnswers, editVersion = 3): string {
  return seedSubmissionAs('ifs-1', formId, answers, editVersion);
}

async function token(formId = 'form-1', submissionId = 'ifs-1', options: {
  epoch?: number;
  expired?: boolean;
  secret?: string;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signed = await signEditToken({
    formId,
    rowRef: submissionId,
    epoch: options.epoch ?? 4,
    exp: options.expired ? now - 1 : editTokenExp(now, 30),
  }, options.secret ?? EDIT_SECRET);
  return signed!;
}

beforeEach(() => {
  sheetsSyncMocks.syncSheetsAfterFormMutation.mockReset().mockResolvedValue(undefined);
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => {
  vi.restoreAllMocks();
  raw.close();
});

describe('GET /ife/:token', () => {
  test('prefills current editable answers, exposes a hidden CAS version, and renders complex answers read-only', async () => {
    seedForm();
    seedSubmission();

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="editVersion" value="3"');
    expect(html).toContain('value="佐藤 &lt;script&gt;"');
    expect(html).toContain('value="old@example.test"');
    expect(html).toContain('申込書.pdf');
    expect(html).toContain('接客');
    expect(html).toContain('田中');
    expect(html).toContain('type="file" id="answer-2" name="a_2"');
    expect(html).not.toContain('name="a_3"');
    expect(html).not.toContain('name="a_4"');
    expect(html).not.toContain('name="a_7"');
    expect(html).not.toContain('<script>');
  });

  test('renders editLocked answers read-only while a legacy field remains editable', async () => {
    seedForm({ definition: editLockedDefinition });
    seedSubmission('form-1', { locked_name: '変更前の氏名', open_note: '変更できます' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const locked = document.querySelector<HTMLElement>('[data-field-id="locked_name"]');
    const open = document.querySelector<HTMLElement>('[data-field-id="open_note"]');

    expect(response.status).toBe(200);
    expect(locked?.querySelector('pre')?.textContent).toBe('変更前の氏名');
    expect(locked?.querySelector('[name="a_0"]')).toBeNull();
    expect(open?.querySelector<HTMLInputElement>('[name="a_1"]')?.value).toBe('変更できます');
  });

  test('keeps an editLocked branch source as a safe fixed answer for client-side branching', async () => {
    const lockedBranchDefinition = {
      ...conditionalDefinition,
      fields: conditionalDefinition.fields.map((field) => field.id === 'kind'
        ? { ...field, config: { ...field.config, editLocked: true } }
        : field),
    };
    seedForm({ definition: lockedBranchDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤' });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    initInternalFormLogic(document);

    expect(document.querySelector('[data-field-id="kind"] input, [data-field-id="kind"] select')).toBeNull();
    expect(document.querySelector('[data-internal-form-logic-config]')?.textContent).toContain('fixedAnswers');
    expect(document.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(true);
  });

  test('renders saved attachments separately from the reused A3 upload block', async () => {
    seedForm({ definition: attachmentDefinition });
    const signed = await token();
    const imageKey = 'internal-form-submissions/form-1/attachment/existing-image.png';
    const pdfKey = 'internal-form-submissions/form-1/attachment/existing-document.pdf';
    seedSubmission('form-1', {
      attachment: [
        storedAttachment(imageKey, '会場写真.png', 'image/png', 12),
        storedAttachment(pdfKey, '申込書<script>.pdf', 'application/pdf', 34),
      ],
    });

    const response = await app().request(`/ife/${signed}`, {}, bindings());
    const html = await response.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const wrapper = document.querySelector<HTMLElement>('[data-field-id="attachment"]');
    const input = wrapper?.querySelector<HTMLInputElement>('input[type="file"][data-file-input]');
    const existing = wrapper?.querySelectorAll<HTMLElement>('[data-existing-file-item]') ?? [];
    const additions = wrapper?.querySelector<HTMLElement>('[data-file-list]');

    expect(response.status).toBe(200);
    expect(document.querySelector('form')?.getAttribute('enctype')).toBe('multipart/form-data');
    expect(wrapper?.querySelector('[data-file-attachment]')).not.toBeNull();
    expect(wrapper?.querySelector('pre')).toBeNull();
    expect(existing).toHaveLength(2);
    expect(existing[0]?.querySelector<HTMLImageElement>('img.attachment-thumbnail')?.getAttribute('src'))
      .toBe(`/ife/${signed}/attachment/attachment/0`);
    expect(existing[0]?.querySelector('img')?.getAttribute('alt')).toContain('会場写真.png');
    expect(existing[1]?.querySelector('.attachment-icon')?.textContent).toBe('PDF');
    expect(existing[1]?.textContent).toContain('申込書<script>.pdf');
    expect(existing[1]?.innerHTML).not.toContain('<script>');
    expect(Array.from(wrapper?.querySelectorAll<HTMLInputElement>('[data-existing-file-remove]') ?? [])
      .map((control) => ({ name: control.name, value: control.value })))
      .toEqual([
        { name: 'remove_a_0', value: '0' },
        { name: 'remove_a_0', value: '1' },
      ]);
    expect(input?.name).toBe('a_0');
    expect(input?.multiple).toBe(true);
    expect(input?.accept).toBe('.png,.pdf');
    expect(input?.dataset.maxFiles).toBe('10');
    expect(input?.dataset.maxSizeKb).toBe('256');
    expect(input?.required).toBe(false);
    expect(wrapper?.querySelectorAll('[data-file-status]')).toHaveLength(1);
    expect(additions?.children).toHaveLength(0);
    expect(additions?.querySelector('[data-existing-file-item]')).toBeNull();
    expect(document.querySelectorAll('script[data-internal-form-logic-client]')).toHaveLength(1);
    expect(document.querySelector('[data-internal-form-logic-config]')).toBeNull();
    expect(html).toContain('.attachment-size{margin-top:3px');
    expect(html).toContain('.attachment-remove{width:auto');
    expect(html).not.toContain(imageKey);
    expect(html).not.toContain(pdfKey);
  });

  test('renders an editLocked attachment block with downloads but no add or remove controls', async () => {
    seedForm({ definition: editLockedAttachmentDefinition });
    const key = 'internal-form-submissions/form-1/attachment/locked.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(key, '確定済み資料.pdf', 'application/pdf')],
    });
    const signed = await token();

    const response = await app().request(`/ife/${signed}`, {}, bindings());
    const html = await response.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const wrapper = document.querySelector<HTMLElement>('[data-field-id="attachment"]');

    expect(response.status).toBe(200);
    expect(wrapper?.querySelector('[data-readonly-file-attachment]')).not.toBeNull();
    expect(wrapper?.querySelector('[data-existing-file-item]')?.textContent).toContain('確定済み資料.pdf');
    expect(wrapper?.querySelector<HTMLAnchorElement>('.attachment-name')?.getAttribute('href'))
      .toBe(`/ife/${signed}/attachment/attachment/0`);
    expect(wrapper?.querySelector('[data-existing-file-remove]')).toBeNull();
    expect(wrapper?.querySelector('[data-file-input]')).toBeNull();
    expect(wrapper?.querySelector('.attachment-add-label')).toBeNull();
    expect(document.querySelector('form')?.hasAttribute('enctype')).toBe(false);
    expect(html).not.toContain(key);
  });

  test('re-enables a full single-file input when the saved file is marked for replacement', async () => {
    seedForm({
      definition: {
        fields: [{
          ...attachmentDefinition.fields[0],
          config: { allowMultipleFiles: false, allowedExtensions: ['pdf'], maxSizeKb: 256 },
        }],
        logic: [],
      },
      allowBranchEdit: 1,
    });
    seedSubmission('form-1', {
      attachment: [storedAttachment(
        'internal-form-submissions/form-1/attachment/existing.pdf',
        'existing.pdf',
        'application/pdf',
      )],
    });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const page = new DOMParser().parseFromString(html, 'text/html');
    const capacityClient = page.querySelector<HTMLScriptElement>(
      'script[data-edit-attachment-capacity-client]',
    );

    expect(capacityClient).not.toBeNull();
    const runCapacityClient = () => new Function(
      'document',
      capacityClient?.textContent ?? '',
    )(page);
    if (capacityClient?.type === 'module') {
      initInternalFormLogic(page);
      runCapacityClient();
    } else {
      runCapacityClient();
      initInternalFormLogic(page);
    }
    const input = page.querySelector<HTMLInputElement>('[data-file-input]')!;
    const removal = page.querySelector<HTMLInputElement>('[data-existing-file-remove]')!;
    expect(input.multiple).toBe(false);
    expect(input.dataset.maxFiles).toBe('1');
    expect(input.disabled).toBe(true);

    removal.checked = true;
    removal.dispatchEvent(new Event('change', { bubbles: true }));

    expect(input.disabled).toBe(false);

    let selectedFiles: File[] = [new File(['new'], 'new.pdf', { type: 'application/pdf' })];
    Object.defineProperty(input, 'files', {
      configurable: true,
      get: () => selectedFiles as unknown as FileList,
    });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    removal.checked = false;
    removal.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.disabled).toBe(false);

    selectedFiles = [];
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.disabled).toBe(true);
  });

  test('renders an empty optional attachment input without changing a no-file edit page', async () => {
    seedForm({
      definition: {
        fields: [{
          ...attachmentDefinition.fields[0],
          required: false,
          config: { allowedExtensions: ['pdf'], maxSizeKb: 128 },
        }],
        logic: [],
      },
    });
    seedSubmission('form-1', {});

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const document = new DOMParser().parseFromString(html, 'text/html');

    expect(document.querySelectorAll('[data-existing-file-item]')).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('[data-file-input]')?.required).toBe(false);
    expect(document.querySelector('form')?.getAttribute('enctype')).toBe('multipart/form-data');
    expect(document.querySelectorAll('script[data-internal-form-logic-client]')).toHaveLength(1);
  });

  test('serves only the token-bound submission attachment reference', async () => {
    seedForm({ definition: attachmentDefinition });
    const firstKey = 'internal-form-submissions/form-1/attachment/first.pdf';
    const secondKey = 'internal-form-submissions/form-1/attachment/second.pdf';
    seedSubmissionAs('ifs-1', 'form-1', {
      attachment: [storedAttachment(firstKey, 'first.pdf', 'application/pdf')],
    });
    seedSubmissionAs('ifs-2', 'form-1', {
      attachment: [
        storedAttachment(firstKey, 'shared-position.pdf', 'application/pdf'),
        storedAttachment(secondKey, 'second.pdf', 'application/pdf'),
      ],
    });
    const r2 = r2Stub({
      [firstKey]: { body: 'FIRST', type: 'application/pdf' },
      [secondKey]: { body: 'SECOND', type: 'application/pdf' },
    });
    const firstToken = await token('form-1', 'ifs-1');
    const secondToken = await token('form-1', 'ifs-2');

    const own = await app().request(
      `/ife/${firstToken}/attachment/attachment/0`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('FIRST');
    expect(own.headers.get('Content-Type')).toBe('application/pdf');
    expect(own.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(own.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r2.get).toHaveBeenLastCalledWith(firstKey);

    r2.get.mockClear();
    const crossSubmission = await app().request(
      `/ife/${firstToken}/attachment/attachment/1`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(crossSubmission.status).toBe(404);
    expect(r2.get).not.toHaveBeenCalled();

    const secondOwn = await app().request(
      `/ife/${secondToken}/attachment/attachment/1`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(secondOwn.status).toBe(200);
    expect(await secondOwn.text()).toBe('SECOND');
    expect(r2.get).toHaveBeenLastCalledWith(secondKey);
  });

  test.each([
    ['invalid token', 'not-a-token', 'attachment', '0', 403],
    ['unknown field', null, 'unknown', '0', 404],
    ['non-numeric index', null, 'attachment', 'nope', 404],
    ['out-of-range index', null, 'attachment', '9', 404],
  ])('rejects an %s before reading R2', async (_label, tokenOverride, fieldId, index, status) => {
    seedForm({ definition: attachmentDefinition });
    const key = 'internal-form-submissions/form-1/attachment/known.pdf';
    seedSubmission('form-1', { attachment: [storedAttachment(key, 'known.pdf', 'application/pdf')] });
    const r2 = r2Stub({ [key]: { body: 'KNOWN', type: 'application/pdf' } });
    const signed = tokenOverride ?? await token();

    const response = await app().request(
      `/ife/${signed}/attachment/${fieldId}/${index}`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );

    expect(response.status).toBe(status);
    expect(r2.get).not.toHaveBeenCalled();
  });

  test('rejects a stored foreign-prefix key and redacts token and key from R2 errors', async () => {
    seedForm({ definition: attachmentDefinition });
    const foreignKey = 'internal-form-submissions/other-form/attachment/secret.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(foreignKey, 'secret.pdf', 'application/pdf')],
    });
    const foreignR2 = r2Stub();
    const signed = await token();
    const foreign = await app().request(
      `/ife/${signed}/attachment/attachment/0`,
      {},
      bindings(DB, { IMAGES: foreignR2.bucket }),
    );
    expect(foreign.status).toBe(404);
    expect(foreignR2.get).not.toHaveBeenCalled();

    const ownKey = 'internal-form-submissions/form-1/attachment/private.pdf';
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ attachment: [storedAttachment(ownKey, 'private.pdf', 'application/pdf')] }), 'ifs-1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const get = vi.fn(async () => { throw new Error(`${signed} ${ownKey}`); });
    const failed = await app().request(
      `/ife/${signed}/attachment/attachment/0`,
      {},
      bindings(DB, { IMAGES: { get } as unknown as R2Bucket }),
    );

    expect(failed.status).toBe(500);
    expect(JSON.stringify(error.mock.calls)).not.toContain(signed);
    expect(JSON.stringify(error.mock.calls)).not.toContain(ownKey);
  });

  test('returns 404 for a missing R2 object and never serves SVG inline', async () => {
    seedForm({ definition: attachmentDefinition });
    const missingKey = 'internal-form-submissions/form-1/attachment/missing.pdf';
    const svgKey = 'internal-form-submissions/form-1/attachment/vector.svg';
    seedSubmission('form-1', {
      attachment: [
        storedAttachment(missingKey, 'missing.pdf', 'application/pdf'),
        storedAttachment(svgKey, 'vector.svg', 'image/svg+xml'),
      ],
    });
    const r2 = r2Stub({ [svgKey]: { body: '<svg></svg>', type: 'image/svg+xml' } });
    const signed = await token();

    const missing = await app().request(
      `/ife/${signed}/attachment/attachment/0`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(missing.status).toBe(404);
    expect(r2.get).toHaveBeenCalledWith(missingKey);

    const svg = await app().request(
      `/ife/${signed}/attachment/attachment/1`,
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(svg.status).toBe(200);
    expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(svg.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(svg.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test.each([
    ['expired token', { token: { expired: true } }],
    ['wrong signing key', { token: { secret: 'wrong-secret' } }],
    ['revoked epoch', { form: { epoch: 5 } }],
    ['missing settings', { form: { withSettings: false } }],
    ['draft form', { form: { status: 'draft' } }],
    ['Formaloo backend', { form: { backend: 'formaloo' as const } }],
  ])('rejects %s without exposing the stored answers', async (_label, setup) => {
    seedForm(setup.form);
    seedSubmission();
    const response = await app().request(`/ife/${await token('form-1', 'ifs-1', setup.token)}`, {}, bindings());
    const html = await response.text();

    expect(response.status).not.toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).not.toContain('old@example.test');
  });

  test('never writes the bearer token to logs when an unexpected DB error occurs', async () => {
    const signed = await token();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const brokenDb = {
      prepare() { throw new Error('database unavailable'); },
    } as unknown as D1Database;

    const response = await app().request(`/ife/${signed}`, {}, bindings(brokenDb));

    expect(response.status).toBe(500);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(signed);
  });

  test('allow_branch_edit=0 は分岐元を readonly にし、client 再評価 asset を載せない', async () => {
    seedForm({ definition: conditionalDefinition });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('aria-label="区分"');
    expect(html).not.toContain('name="a_0"');
    expect(html).toContain('name="a_1"');
    expect(html).not.toContain('data-internal-form-logic-client');
    expect(html).not.toContain('data-file-attachment');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('form')?.hasAttribute('enctype'))
      .toBe(false);
  });

  test('allow_branch_edit=1 は全分岐候補を安全な DOM に載せ、共有 client が入力時に出し分ける', async () => {
    seedForm({ definition: conditionalDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤', company: '初期非表示の秘密' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-internal-form-logic-config');
    expect(html).toContain('src="/assets/internal-form-logic.js"');
    expect(html).not.toContain('初期非表示の秘密');

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    initInternalFormLogic(parsed);
    const kind = parsed.querySelector<HTMLSelectElement>('select[name="a_0"]')!;
    const personal = parsed.querySelector<HTMLElement>('[data-field-id="personal"]')!;
    const company = parsed.querySelector<HTMLElement>('[data-field-id="company"]')!;
    expect(personal.hidden).toBe(false);
    expect(company.hidden).toBe(true);

    kind.value = '法人';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(personal.hidden).toBe(true);
    expect(personal.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(company.hidden).toBe(false);
    expect(company.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
    expect(company.querySelector<HTMLInputElement>('input')?.required).toBe(true);
  });

  test('logic JSON の script 終端文字列を escape して設定 script から脱出させない', async () => {
    const attack = '</script><script>globalThis.__editBranchXss = true</script>';
    const dangerousDefinition = {
      fields: [
        { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: [attack] } },
        { id: 'target', type: 'text', label: '対象', required: false, position: 1, config: {} },
      ],
      logic: [{ id: 'danger', sourceFieldId: 'kind', operator: 'equals', value: attack, action: 'show', targetFieldId: 'target' }],
    };
    seedForm({ definition: dangerousDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: attack });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();

    expect(html).not.toContain(attack);
    expect(html).toContain('\\u003c/script\\u003e');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script')).toHaveLength(2);
  });

  test('control を持たない既存 readonly source も固定回答で client 評価を維持する', async () => {
    const readonlySourceDefinition = {
      fields: [
        { id: 'approval', type: 'signature', label: '承認署名', required: false, position: 0, config: {} },
        { id: 'approved_note', type: 'text', label: '承認後の連絡', required: false, position: 1, config: {} },
      ],
      logic: [{
        id: 'approved', sourceFieldId: 'approval', operator: 'equals', value: 'approved',
        action: 'show', targetFieldId: 'approved_note',
      }],
    };
    seedForm({ definition: readonlySourceDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { approval: 'approved', approved_note: '連絡済み' });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    initInternalFormLogic(parsed);
    expect(parsed.querySelector<HTMLElement>('[data-field-id="approved_note"]')?.hidden).toBe(false);
    expect(parsed.querySelector('[data-internal-form-logic-config]')?.textContent).toContain('fixedAnswers');
  });

  test('file 分岐の固定回答は R2 key を HTML に出さず回答済み状態だけを client へ渡す', async () => {
    seedForm({ definition: fileSourceDefinition, allowBranchEdit: 1 });
    const privateKey = 'internal-form-submissions/form-1/attachment/private.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(privateKey, 'branch-source.pdf', 'application/pdf')],
      attachment_note: '表示中',
    });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    expect(html).not.toContain(privateKey);
    expect(parsed.querySelector('[data-internal-form-logic-config]')?.textContent).not.toContain(privateKey);
    initInternalFormLogic(parsed);
    expect(parsed.querySelector<HTMLElement>('[data-field-id="attachment_note"]')?.hidden).toBe(false);

    const removal = parsed.querySelector<HTMLInputElement>('[data-existing-file-remove]')!;
    removal.checked = true;
    removal.dispatchEvent(new Event('change', { bubbles: true }));
    expect(parsed.querySelector<HTMLElement>('[data-field-id="attachment_note"]')?.hidden).toBe(true);

    const input = parsed.querySelector<HTMLInputElement>('[data-file-input]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['new'], 'new.pdf', { type: 'application/pdf' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(parsed.querySelector<HTMLElement>('[data-field-id="attachment_note"]')?.hidden).toBe(false);
  });

  test('editLocked file 分岐は安全な固定回答を使い、添付操作なしでも表示状態を保つ', async () => {
    const lockedFileSourceDefinition = {
      ...fileSourceDefinition,
      fields: fileSourceDefinition.fields.map((field) => field.id === 'attachment'
        ? { ...field, config: { ...field.config, editLocked: true } }
        : field),
    };
    seedForm({ definition: lockedFileSourceDefinition, allowBranchEdit: 1 });
    const privateKey = 'internal-form-submissions/form-1/attachment/locked-branch.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(privateKey, 'locked-branch.pdf', 'application/pdf')],
      attachment_note: '表示中',
    });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const logicConfig = parsed.querySelector('[data-internal-form-logic-config]')?.textContent ?? '';

    expect(html).not.toContain(privateKey);
    expect(logicConfig).toContain('fixedAnswers');
    expect(logicConfig).not.toContain(privateKey);
    expect(parsed.querySelector('[data-file-input]')).toBeNull();
    expect(parsed.querySelector('[data-existing-file-remove]')).toBeNull();
    initInternalFormLogic(parsed);
    expect(parsed.querySelector<HTMLElement>('[data-field-id="attachment_note"]')?.hidden).toBe(false);
  });

  test('field type changed after submission still projects a stale attachment descriptor without its R2 key', async () => {
    const changedTypeDefinition = {
      fields: [
        { id: 'attachment', type: 'signature', label: '旧添付欄', required: false, position: 0, config: {} },
        { id: 'attachment_note', type: 'text', label: '添付後の連絡', required: false, position: 1, config: {} },
      ],
      logic: [{
        id: 'stale-attachment-answered',
        sourceFieldId: 'attachment',
        operator: 'equals',
        value: 'unused',
        action: 'show',
        targetFieldId: 'attachment_note',
        conditionJoin: 'and',
        conditions: [{ sourceFieldId: 'attachment', operator: 'is_answered', value: '' }],
      }],
    };
    seedForm({ definition: changedTypeDefinition, allowBranchEdit: 1 });
    const staleKey = 'internal-form-submissions/form-1/attachment/stale.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(staleKey, 'stale.pdf', 'application/pdf')],
      attachment_note: '表示中',
    });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    expect(html).not.toContain(staleKey);
    initInternalFormLogic(parsed);
    expect(parsed.querySelector<HTMLElement>('[data-field-id="attachment_note"]')?.hidden).toBe(false);
  });

  test('初期非表示の必須 file は保存値を隠し、分岐表示後に required を復元する', async () => {
    seedForm({ definition: initiallyHiddenAttachmentDefinition, allowBranchEdit: 1 });
    const hiddenKey = 'internal-form-submissions/form-1/attachment/hidden.pdf';
    seedSubmission('form-1', {
      gate: '隠す',
      attachment: [storedAttachment(hiddenKey, '初期非表示の秘密.pdf', 'application/pdf')],
    });

    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const wrapper = parsed.querySelector<HTMLElement>('[data-field-id="attachment"]')!;
    const input = wrapper.querySelector<HTMLInputElement>('[data-file-input]')!;

    expect(html).not.toContain(hiddenKey);
    expect(html).not.toContain('初期非表示の秘密.pdf');
    expect(wrapper.hidden).toBe(true);
    expect(input.dataset.required).toBe('true');
    expect(input.required).toBe(false);

    initInternalFormLogic(parsed);
    const gate = parsed.querySelector<HTMLSelectElement>('select[name="a_0"]')!;
    gate.value = '表示する';
    gate.dispatchEvent(new Event('change', { bubbles: true }));

    expect(wrapper.hidden).toBe(false);
    expect(input.disabled).toBe(false);
    expect(input.required).toBe(true);
  });

  test('初期状態で非表示の readonly source は保存値を client 設定へ埋め込まない', async () => {
    const hiddenReadonlySourceDefinition = {
      fields: [
        { id: 'gate', type: 'choice', label: '表示条件', required: false, position: 0, config: { choices: ['表示する', '隠す'] } },
        { id: 'approval', type: 'signature', label: '承認署名', required: false, position: 1, config: {} },
        { id: 'approved_note', type: 'text', label: '承認後の連絡', required: false, position: 2, config: {} },
      ],
      logic: [
        { id: 'show-approval', sourceFieldId: 'gate', operator: 'equals', value: '表示する', action: 'show', targetFieldId: 'approval' },
        { id: 'approved', sourceFieldId: 'approval', operator: 'equals', value: '承認済み', action: 'show', targetFieldId: 'approved_note' },
      ],
    };
    seedForm({ definition: hiddenReadonlySourceDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { gate: '隠す', approval: '初期非表示の署名秘密値' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const config = parsed.querySelector('[data-internal-form-logic-config]');

    expect(response.status).toBe(200);
    expect(config).not.toBeNull();
    expect(config?.textContent).not.toContain('初期非表示の署名秘密値');
  });

  test('compound conditions の各 source も分岐元として readonly にする', async () => {
    const compound = {
      fields: [
        { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: ['法人'] } },
        { id: 'region', type: 'choice', label: '地域', required: true, position: 1, config: { choices: ['関東'] } },
        { id: 'target', type: 'text', label: '法人名', required: true, position: 2, config: {} },
      ],
      logic: [{
        id: 'compound', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'target',
        conditionJoin: 'and',
        conditions: [
          { sourceFieldId: 'kind', operator: 'equals', value: '法人' },
          { sourceFieldId: 'region', operator: 'equals', value: '関東' },
        ],
      }],
    };
    seedForm({ definition: compound });
    seedSubmission('form-1', { kind: '法人', region: '関東', target: 'テスト社' });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    expect(html).not.toContain('name="a_0"');
    expect(html).not.toContain('name="a_1"');
    expect(html).toContain('name="a_2"');
  });
});

describe('POST /ife/:token', () => {
  test('rejects a forged editLocked field and preserves its stored value and edit version', async () => {
    seedForm({ definition: editLockedDefinition });
    seedSubmission('form-1', { locked_name: '変更前の氏名', open_note: '変更前の追記' });
    const signed = await token();

    const response = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        editVersion: '3',
        a_0: '改ざんされた氏名',
        a_1: '同時に送った追記',
      }),
    }, bindings());

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('編集不可の項目は変更できません。');
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual({
      locked_name: '変更前の氏名',
      open_note: '変更前の追記',
    });

    const readback = await app().request(`/ife/${signed}`, {}, bindings());
    const readbackHtml = await readback.text();
    expect(readbackHtml).toContain('変更前の氏名');
    expect(readbackHtml).not.toContain('改ざんされた氏名');
  });

  test('updates an unlocked legacy field while preserving an omitted editLocked answer', async () => {
    seedForm({ definition: editLockedDefinition });
    seedSubmission('form-1', { locked_name: '変更前の氏名', open_note: '変更前の追記' });

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_1: '更新後の追記' }),
    }, bindings());

    expect(response.status).toBe(200);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toEqual({
      locked_name: '変更前の氏名',
      open_note: '更新後の追記',
    });
  });

  test('rejects forged add and remove controls for an editLocked file before any upload', async () => {
    seedForm({ definition: editLockedAttachmentDefinition });
    const key = 'internal-form-submissions/form-1/attachment/locked.pdf';
    const answers = {
      attachment: [storedAttachment(key, '確定済み資料.pdf', 'application/pdf')],
    };
    seedSubmission('form-1', answers);
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
      { name: 'a_0', filename: 'forged.pdf', type: 'application/pdf', content: 'forged' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('編集不可の項目は変更できません。');
    expect(r2.put).not.toHaveBeenCalled();
    expect(raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1')).toEqual({
      answers_json: JSON.stringify(answers),
      edit_version: 3,
    });
  });

  test('does not erase an editLocked answer when another field change hides it', async () => {
    const lockedTargetDefinition = {
      fields: conditionalDefinition.fields.map((field) => field.id === 'company'
        ? { ...field, config: { ...field.config, editLocked: true } }
        : { ...field, required: false }),
      logic: conditionalDefinition.logic,
    };
    seedForm({ definition: lockedTargetDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: '法人', company: '保存しておく会社名' });

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '個人', a_1: '佐藤' }),
    }, bindings());

    expect(response.status).toBe(200);
    const stored = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    expect(JSON.parse(stored.answers_json)).toEqual({
      kind: '個人',
      personal: '佐藤',
      company: '保存しておく会社名',
    });
    const readbackHtml = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    expect(readbackHtml).not.toContain('保存しておく会社名');
  });

  test('re-evaluates file-source branches from the final retained plus added attachment state', async () => {
    seedForm({ definition: fileSourceDefinition, allowBranchEdit: 1 });
    const existingKey = 'internal-form-submissions/form-1/attachment/existing.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(existingKey, 'existing.pdf', 'application/pdf')],
      attachment_note: 'この回答も非表示になれば外れる',
    });
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings());

    expect(response.status).toBe(200);
    const stored = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toEqual({});
  });

  test('re-renders real stored attachment metadata instead of logic sentinels after validation fails', async () => {
    seedForm({ definition: fileSourceDefinition, allowBranchEdit: 1 });
    const existingKey = 'internal-form-submissions/form-1/attachment/existing.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(existingKey, 'existing.pdf', 'application/pdf')],
      attachment_note: '表示中',
    });
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
      { name: 'a_0', filename: 'blocked.exe', type: 'application/octet-stream', content: 'blocked' },
      { name: 'a_1', value: '表示中' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings());
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('添付資料 の拡張子は許可されていません');
    expect(html).toContain('existing.pdf');
    expect(html).not.toContain('添付ファイル 1');
    expect(html).not.toContain(existingKey);
  });

  test('does not resurrect an initially hidden stored attachment when its branch becomes visible', async () => {
    seedForm({ definition: initiallyHiddenAttachmentDefinition, allowBranchEdit: 1 });
    const hiddenKey = 'internal-form-submissions/form-1/attachment/hidden.pdf';
    seedSubmission('form-1', {
      gate: '隠す',
      attachment: [storedAttachment(hiddenKey, 'hidden.pdf', 'application/pdf')],
    });
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'a_0', value: '表示する' },
      { name: 'a_1', filename: 'visible.pdf', type: 'application/pdf', content: 'visible' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(200);
    const addedKey = String(r2.put.mock.calls[0]?.[0]);
    const stored = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    expect(JSON.parse(stored.answers_json)).toEqual({
      gate: '表示する',
      attachment: [storedAttachment(addedKey, 'visible.pdf', 'application/pdf', 7)],
    });
    expect(r2.del).not.toHaveBeenCalledWith(hiddenKey);
  });

  test('persists an uploaded file field whose id is __proto__ as an own answer property', async () => {
    const reservedDefinition = {
      fields: [{
        ...attachmentDefinition.fields[0],
        id: '__proto__',
        label: '予約名の添付',
        required: false,
        config: { allowMultipleFiles: false, allowedExtensions: ['pdf'], maxSizeKb: 256 },
      }],
      logic: [],
    };
    seedForm({ definition: reservedDefinition });
    seedSubmission('form-1', {});
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'a_0', filename: 'reserved.pdf', type: 'application/pdf', content: 'reserved' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(200);
    const stored = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    const answers = JSON.parse(stored.answers_json) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(answers, '__proto__')).toBe(true);
    expect(answers.__proto__).toEqual([
      storedAttachment(String(r2.put.mock.calls[0]?.[0]), 'reserved.pdf', 'application/pdf', 8),
    ]);
  });

  test('allows a single-file field to delete its existing file and add one new file', async () => {
    const singleDefinition = {
      fields: [{
        ...attachmentDefinition.fields[0],
        config: { allowMultipleFiles: false, allowedExtensions: ['pdf'], maxSizeKb: 256 },
      }],
      logic: [],
    };
    seedForm({ definition: singleDefinition });
    const oldKey = 'internal-form-submissions/form-1/attachment/old.pdf';
    seedSubmission('form-1', {
      attachment: [storedAttachment(oldKey, 'old.pdf', 'application/pdf')],
    });
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
      { name: 'a_0', filename: 'new.pdf', type: 'application/pdf', content: 'new' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(200);
    const addedKey = String(r2.put.mock.calls[0]?.[0]);
    const stored = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    expect(JSON.parse(stored.answers_json)).toEqual({
      attachment: [storedAttachment(addedKey, 'new.pdf', 'application/pdf', 3)],
    });
    expect(r2.del).not.toHaveBeenCalledWith(oldKey);
  });

  test('saves final attachments as kept existing followed by validated additions and round-trips every read path', async () => {
    seedForm({ definition: attachmentDefinition });
    const removedKey = 'internal-form-submissions/form-1/attachment/removed.pdf';
    const keptKey = 'internal-form-submissions/form-1/attachment/kept.png';
    seedSubmission('form-1', {
      attachment: [
        storedAttachment(removedKey, '削除対象.pdf', 'application/pdf', 7),
        storedAttachment(keptKey, '残す写真.png', 'image/png', 9),
      ],
    });
    const signed = await token();
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
      { name: 'a_0', filename: '追加資料.pdf', type: 'application/pdf', content: 'new-pdf' },
    ]);

    const response = await sendMultipart(`/ife/${signed}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(200);
    expect(r2.put).toHaveBeenCalledTimes(1);
    const addedKey = String(r2.put.mock.calls[0]?.[0]);
    expect(addedKey).toMatch(/^internal-form-submissions\/form-1\/attachment\/[0-9a-f-]+\.pdf$/);
    expect(r2.del).not.toHaveBeenCalledWith(removedKey);
    expect(r2.del).not.toHaveBeenCalledWith(keptKey);

    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    const finalAttachments = (JSON.parse(stored.answers_json) as {
      attachment: Array<{ key: string; name: string; size: number; type: string }>;
    }).attachment;
    expect(stored.edit_version).toBe(4);
    expect(finalAttachments).toEqual([
      storedAttachment(keptKey, '残す写真.png', 'image/png', 9),
      storedAttachment(addedKey, '追加資料.pdf', 'application/pdf', 7),
    ]);

    const editReadback = await app().request(`/ife/${signed}`, {}, bindings(DB, { IMAGES: r2.bucket }));
    const readbackHtml = await editReadback.text();
    expect(editReadback.status).toBe(200);
    expect(readbackHtml).toContain('name="editVersion" value="4"');
    expect(readbackHtml).toContain('残す写真.png');
    expect(readbackHtml).toContain('追加資料.pdf');
    expect(readbackHtml).not.toContain('削除対象.pdf');

    const adminReadback = await adminApp().request(
      '/api/forms-advanced/form-1/rows/ifs-1',
      {},
      bindings(DB, { IMAGES: r2.bucket }),
    );
    expect(adminReadback.status).toBe(200);
    const adminData = (await adminReadback.json() as {
      data: { answers: { attachment: unknown[] }; fields: Array<{ slug: string; editable: boolean }> };
    }).data;
    expect(adminData.answers.attachment).toEqual(finalAttachments);
    expect(adminData.fields).toContainEqual(expect.objectContaining({ slug: 'attachment', editable: false }));
  });

  test('rejects deleting the last required attachment without an addition', async () => {
    seedForm({ definition: attachmentDefinition });
    const key = 'internal-form-submissions/form-1/attachment/only.pdf';
    seedSubmission('form-1', { attachment: [storedAttachment(key, 'only.pdf', 'application/pdf')] });
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('添付資料 は必須項目です');
    expect(r2.put).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT edit_version FROM internal_form_submissions WHERE id = ?').get('ifs-1'))
      .toEqual({ edit_version: 3 });
  });

  test('rejects a forged attachment removal index without mutating the row', async () => {
    seedForm({ definition: attachmentDefinition });
    const key = 'internal-form-submissions/form-1/attachment/only.pdf';
    seedSubmission('form-1', { attachment: [storedAttachment(key, 'only.pdf', 'application/pdf')] });
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '999' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings());

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('添付の削除指定が正しくありません');
    expect(raw.prepare('SELECT edit_version FROM internal_form_submissions WHERE id = ?').get('ifs-1'))
      .toEqual({ edit_version: 3 });
  });

  test('applies the existing total-count limit before uploading additions', async () => {
    seedForm({ definition: attachmentDefinition });
    const attachment = Array.from({ length: 10 }, (_, index) => storedAttachment(
      `internal-form-submissions/form-1/attachment/existing-${index}.pdf`,
      `existing-${index}.pdf`,
      'application/pdf',
    ));
    seedSubmission('form-1', { attachment });
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'a_0', filename: 'extra.pdf', type: 'application/pdf', content: 'extra' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('添付資料 の添付は最大10件です');
    expect(r2.put).not.toHaveBeenCalled();
  });

  test.each([
    ['extension', 'bad.exe', 'application/octet-stream', 'bad', '添付資料 の拡張子は許可されていません'],
    ['size', 'large.pdf', 'application/pdf', 'x'.repeat(256 * 1024 + 1), '添付資料 のファイルサイズが上限を超えています'],
  ])('reuses initial-upload %s validation without writing R2', async (
    _label,
    filename,
    type,
    content,
    expectedError,
  ) => {
    seedForm({ definition: attachmentDefinition });
    seedSubmission('form-1', {});
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'a_0', filename, type, content },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(expectedError);
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('rolls back only the new upload when CAS conflicts', async () => {
    seedForm({ definition: attachmentDefinition });
    const existingKey = 'internal-form-submissions/form-1/attachment/existing.pdf';
    seedSubmission('form-1', { attachment: [storedAttachment(existingKey, 'existing.pdf', 'application/pdf')] }, 4);
    const r2 = r2Stub();
    const request = multipartRequest([
      { name: 'editVersion', value: '3' },
      { name: 'remove_a_0', value: '0' },
      { name: 'a_0', filename: 'new.pdf', type: 'application/pdf', content: 'new' },
    ]);

    const response = await sendMultipart(`/ife/${await token()}`, request, bindings(DB, {
      IMAGES: r2.bucket,
    }));

    expect(response.status).toBe(409);
    expect(r2.put).toHaveBeenCalledTimes(1);
    const newKey = String(r2.put.mock.calls[0]?.[0]);
    expect(r2.del).toHaveBeenCalledWith(newKey);
    expect(r2.del).not.toHaveBeenCalledWith(existingKey);
    const stored = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toEqual({
      attachment: [storedAttachment(existingKey, 'existing.pdf', 'application/pdf')],
    });
  });

  test('queues an immediate Sheets sync after a respondent edit is read back', async () => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const signed = await token();
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const executionCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await app().fetch(new Request(`https://worker.example.test/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        editVersion: '3',
        a_0: '鈴木',
        a_1: 'new@example.test',
      }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), executionCtx);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).toHaveBeenCalledWith(expect.objectContaining({
      db: DB,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      submissionId: 'ifs-1',
      actor: 'system_internal_form_edit',
      credentialsJson: '{}',
    }));
  });

  test('keeps a respondent edit successful when the background Sheets sync fails', async () => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockRejectedValueOnce(new Error('sync failed'));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '鈴木', a_1: 'new@example.test' }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(raw.prepare('SELECT edit_version FROM internal_form_submissions WHERE id = ?').get('ifs-1'))
      .toEqual({ edit_version: 4 });
    expect(error).toHaveBeenCalledWith('Immediate Google Sheets sync after respondent edit failed');
  });

  test('overwrites with the final W3 logic branch, preserves unknown keys, and reads back only the active answer', async () => {
    seedForm({ definition: conditionalDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', {
      kind: '個人', personal: '佐藤', company: '旧会社名', legacy_unknown: { keep: true },
    }, 3);
    const signed = await token();

    const initial = await app().request(`/ife/${signed}`, {}, bindings());
    const initialHtml = await initial.text();
    const initialDocument = new DOMParser().parseFromString(initialHtml, 'text/html');
    expect(initialDocument.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(false);
    expect(initialDocument.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(true);
    expect(initialHtml).not.toContain('旧会社名');

    const changedBranch = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人' }),
    }, bindings());
    const changedHtml = await changedBranch.text();
    expect(changedBranch.status).toBe(400);
    const changedDocument = new DOMParser().parseFromString(changedHtml, 'text/html');
    expect(changedDocument.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(true);
    expect(changedDocument.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(false);

    const saved = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人', a_1: '偽造された非表示値', a_2: '株式会社テスト' }),
    }, bindings());
    expect(saved.status).toBe(200);
    const row = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    expect(JSON.parse(row.answers_json)).toEqual({
      kind: '法人',
      company: '株式会社テスト',
      legacy_unknown: { keep: true },
    });

    const readback = await app().request(`/ife/${signed}`, {}, bindings());
    const readbackHtml = await readback.text();
    const readbackDocument = new DOMParser().parseFromString(readbackHtml, 'text/html');
    expect(readback.status).toBe(200);
    expect(readbackDocument.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(true);
    expect(readbackDocument.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(false);
    expect(readbackHtml).toContain('name="editVersion" value="4"');
    expect(readbackHtml).toContain('value="株式会社テスト"');
    expect(readbackHtml).not.toContain('佐藤');
    expect(readbackHtml).not.toContain('偽造された非表示値');
    expect(readbackHtml).not.toContain('旧会社名');
  });

  test('allow_branch_edit=0 は forged branch POST を 403 で拒否し回答と版を変えない', async () => {
    seedForm({ definition: conditionalDefinition });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤' }, 3);

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人', a_2: '攻撃者の会社' }),
    }, bindings());

    expect(response.status).toBe(403);
    const stored = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual({ kind: '個人', personal: '佐藤' });
  });

  test('validates and saves editable answers with CAS, ignores forged fields, preserves complex answers, and reads back the change', async () => {
    seedForm();
    seedSubmission('form-1', { ...originalAnswers, legacy_unknown: { keep: true } });
    const signed = await token();
    const body = new URLSearchParams({
      editVersion: '3',
      a_0: '鈴木',
      a_1: 'new@example.test',
      a_999: 'unknown answer',
      fr_id: 'attacker-friend',
      friend_id: 'attacker-friend',
      form_id: 'attacker-form',
      answers_json: '{"admin":true}',
      edit_version: '999',
    });

    const response = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).toContain('保存しました');

    const stored = raw.prepare(
      'SELECT form_id, friend_id, answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { form_id: string; friend_id: string | null; answers_json: string; edit_version: number };
    const answers = JSON.parse(stored.answers_json) as Record<string, unknown>;
    expect(stored.form_id).toBe('form-1');
    expect(stored.friend_id).toBeNull();
    expect(stored.edit_version).toBe(4);
    expect(answers).toMatchObject({ name: '鈴木', email: 'new@example.test' });
    expect(answers.attachment).toEqual(originalAnswers.attachment);
    expect(answers.signature).toBe(originalAnswers.signature);
    expect(answers.matrix).toEqual(originalAnswers.matrix);
    expect(answers.repeat).toEqual(originalAnswers.repeat);
    expect(answers.legacy_unknown).toEqual({ keep: true });
    expect(answers).not.toHaveProperty('fr_id');
    expect(answers).not.toHaveProperty('friend_id');
    expect(answers).not.toHaveProperty('admin');

    const readback = await app().request(`/ife/${signed}`, {}, bindings());
    expect(await readback.text()).toContain('value="鈴木"');
  });

  test.each([
    ['required', { a_0: '', a_1: 'new@example.test' }],
    ['email type', { a_0: '鈴木', a_1: 'not-an-email' }],
  ])('returns 400 for invalid %s input and leaves the row unchanged', async (_label, values) => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const waitUntil = vi.fn();
    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', ...values }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual(originalAnswers);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('returns 409 for a stale hidden editVersion and does not overwrite newer answers', async () => {
    seedForm();
    seedSubmission('form-1', { ...originalAnswers, name: '先に更新済み' }, 4);
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const waitUntil = vi.fn();
    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '古い画面から更新', a_1: 'new@example.test' }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toMatchObject({ name: '先に更新済み' });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('returns 403 without mutation when the edit link is revoked immediately before UPDATE', async () => {
    seedForm();
    seedSubmission();

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '失効後の更新', a_1: 'new@example.test' }),
    }, bindings(rotateEpochBeforeSubmissionUpdate()));

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual(originalAnswers);
  });

  test('round-trips edit URL save through pending review and approval APIs', async () => {
    seedForm();
    seedSubmission();
    const signed = await token();

    const edited = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        editVersion: '3',
        a_0: '外部編集後',
        a_1: 'external@example.test',
      }),
    }, bindings());
    expect(edited.status).toBe(200);

    const pending = await adminApp().request(
      '/api/forms-advanced/form-1/rows?externalEdit=pending&page=1&pageSize=25',
      {},
      bindings(),
    );
    expect(pending.status).toBe(200);
    const pendingData = (await pending.json() as {
      data: {
        rows: Array<{
          id: string;
          externalEditSource: string | null;
          externalEditedAt: string | null;
          externalEditApprovedAt: string | null;
        }>;
        total: number;
        externalEditPendingCount: number;
      };
    }).data;
    expect(pendingData).toMatchObject({
      rows: [{
        id: 'ifs-1',
        externalEditSource: 'edit_link',
        externalEditedAt: expect.any(String),
        externalEditApprovedAt: null,
      }],
      total: 1,
      externalEditPendingCount: 1,
    });

    const answersBeforeApproval = (raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'ifs-1'`,
    ).get() as { answers_json: string }).answers_json;
    const approved = await adminApp().request(
      '/api/forms-advanced/form-1/rows/ifs-1/approve-external-edit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedExternalEditSource: 'edit_link',
          expectedExternalEditedAt: pendingData.rows[0]?.externalEditedAt,
        }),
      },
      bindings(),
    );
    expect(approved.status).toBe(200);
    expect((raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'ifs-1'`,
    ).get() as { answers_json: string }).answers_json).toBe(answersBeforeApproval);

    const cleared = await adminApp().request(
      '/api/forms-advanced/form-1/rows?externalEdit=pending&page=1&pageSize=25',
      {},
      bindings(),
    );
    expect((await cleared.json() as {
      data: { rows: unknown[]; total: number; externalEditPendingCount: number };
    }).data).toEqual(expect.objectContaining({
      rows: [],
      total: 0,
      externalEditPendingCount: 0,
    }));
  });
});
