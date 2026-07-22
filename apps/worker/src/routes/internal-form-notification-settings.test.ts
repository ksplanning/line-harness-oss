import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  getFormalooForm: vi.fn(),
  getInternalFormNotificationSettings: vi.fn(),
  upsertInternalFormNotificationSettings: vi.fn(),
  bumpInternalFormEditLinkEpoch: vi.fn(),
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return { ...actual, ...dbMocks };
});

import { internalFormNotificationSettings } from './internal-form-notification-settings.js';

const DB = {} as D1Database;
const internalForm = {
  id: 'form-1',
  render_backend: 'internal',
  deleted: 0,
  definition_json: JSON.stringify({
    fields: [
      { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
      { id: 'mail', type: 'email', label: '本人メール', required: true, position: 1, config: {} },
    ],
    logic: [],
  }),
};
const stored = {
  formId: 'form-1',
  enabled: false,
  recipientEmailFieldId: null,
  messageTemplate: null,
  editLinkEpoch: 0,
  createdAt: '2026-07-21T07:00:00+09:00',
  updatedAt: '2026-07-21T07:00:00+09:00',
};

function app() {
  const hono = new Hono<Env>();
  hono.route('/', internalFormNotificationSettings);
  return hono;
}

function env(): Env['Bindings'] {
  return { DB } as Env['Bindings'];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFormalooForm.mockResolvedValue(internalForm);
  dbMocks.getInternalFormNotificationSettings.mockResolvedValue(stored);
  dbMocks.upsertInternalFormNotificationSettings.mockImplementation(async (_db, input) => ({
    ...stored,
    enabled: input.enabled,
    recipientEmailFieldId: input.recipientEmailFieldId,
    messageTemplate: input.messageTemplate,
  }));
  dbMocks.bumpInternalFormEditLinkEpoch.mockResolvedValue(1);
});

describe('internal submission notification settings API', () => {
  test('GET materializes an OFF default when settings have never been saved', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue(null);

    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {}, env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        formId: 'form-1',
        enabled: false,
        recipientEmailFieldId: null,
        messageTemplate: null,
        editLinkEpoch: 0,
      },
    });
    expect(dbMocks.upsertInternalFormNotificationSettings).not.toHaveBeenCalled();
  });

  test('GET exposes the internal-only default without mutating the form definition', async () => {
    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {}, env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: stored });
    expect(dbMocks.upsertInternalFormNotificationSettings).not.toHaveBeenCalled();
  });

  test('PUT validates and persists an explicit respondent email field and custom template', async () => {
    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        recipientEmailFieldId: 'mail',
        messageTemplate: 'こんにちは {{display_name}}\n{{回答:お名前}}\n{{編集リンク}}',
      }),
    }, env());

    expect(response.status).toBe(200);
    expect(dbMocks.upsertInternalFormNotificationSettings).toHaveBeenCalledWith(DB, {
      formId: 'form-1',
      enabled: true,
      recipientEmailFieldId: 'mail',
      messageTemplate: 'こんにちは {{display_name}}\n{{回答:お名前}}\n{{編集リンク}}',
    });
  });

  test('allows LINE-only notification when the form has no email field', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({
      ...internalForm,
      definition_json: JSON.stringify({
        fields: [
          { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
        ],
        logic: [],
      }),
    });

    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, recipientEmailFieldId: null, messageTemplate: null }),
    }, env());

    expect(response.status).toBe(200);
    expect(dbMocks.upsertInternalFormNotificationSettings).toHaveBeenCalledWith(DB, {
      formId: 'form-1',
      enabled: true,
      recipientEmailFieldId: null,
      messageTemplate: null,
    });
  });

  test('rejects a selected recipient field that is absent or not email typed', async () => {
    for (const recipientEmailFieldId of ['name', 'missing']) {
      const response = await app().request('/api/forms-advanced/form-1/submission-notification', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, recipientEmailFieldId, messageTemplate: null }),
      }, env());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: '選択したメール欄が見つかりません。メール欄を選び直してください',
      });
    }
    expect(dbMocks.upsertInternalFormNotificationSettings).not.toHaveBeenCalled();
  });

  test('rejects an email field used only as a repeating-section column', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({
      ...internalForm,
      definition_json: JSON.stringify({
        fields: [
          { id: 'row_mail', type: 'email', label: '同行者メール', required: false, position: 0, config: {} },
          {
            id: 'participants',
            type: 'repeating_section',
            label: '同行者',
            required: false,
            position: 1,
            config: { repeatingColumns: [{ columnField: 'row_mail', title: 'メール' }] },
          },
        ],
        logic: [],
      }),
    });

    for (const enabled of [true, false]) {
      const response = await app().request('/api/forms-advanced/form-1/submission-notification', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, recipientEmailFieldId: 'row_mail', messageTemplate: null }),
      }, env());

      expect(response.status).toBe(400);
    }
    expect(dbMocks.upsertInternalFormNotificationSettings).not.toHaveBeenCalled();
  });

  test('rejects an ambiguous answer variable instead of silently choosing one duplicate label', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({
      ...internalForm,
      definition_json: JSON.stringify({
        fields: [
          { id: 'first', type: 'text', label: '氏名', required: true, position: 0, config: {} },
          { id: 'second', type: 'text', label: '氏名', required: true, position: 1, config: {} },
          { id: 'mail', type: 'email', label: '本人メール', required: true, position: 2, config: {} },
        ],
        logic: [],
      }),
    });

    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        recipientEmailFieldId: 'mail',
        messageTemplate: '{{回答:氏名}}',
      }),
    }, env());

    expect(response.status).toBe(400);
    expect((await response.json()) as object).toMatchObject({ success: false });
  });

  test('Formaloo-backed forms are outside this endpoint and remain untouched', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({ ...internalForm, render_backend: 'formaloo' });

    const response = await app().request('/api/forms-advanced/form-1/submission-notification', {}, env());
    expect(response.status).toBe(404);
    expect(dbMocks.getInternalFormNotificationSettings).not.toHaveBeenCalled();
  });

  test('revoke endpoint bumps the epoch used by all previously issued links', async () => {
    const response = await app().request('/api/forms-advanced/form-1/submission-notification/revoke-links', {
      method: 'POST',
    }, env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { editLinkEpoch: 1 } });
    expect(dbMocks.bumpInternalFormEditLinkEpoch).toHaveBeenCalledWith(DB, 'form-1');
  });
});
