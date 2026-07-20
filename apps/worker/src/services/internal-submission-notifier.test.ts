import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFormalooForm: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  getInternalFormSubmission: vi.fn(),
  getInternalFormNotificationSettings: vi.fn(),
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return { ...actual, ...dbMocks };
});

const lineMocks = vi.hoisted(() => ({ pushMessage: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage: lineMocks.pushMessage })),
}));

const mailMocks = vi.hoisted(() => ({ sendEditMail: vi.fn() }));
vi.mock('./edit-mail-sender.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./edit-mail-sender.js');
  return { ...actual, sendEditMail: mailMocks.sendEditMail };
});

import { LineClient } from '@line-crm/line-sdk';
import { notifyInternalFormSubmission } from './internal-submission-notifier.js';

const DB = {
  prepare: vi.fn(() => ({
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
  })),
} as unknown as D1Database;

const form = {
  id: 'form-1',
  title: '参加申込',
  builder_status: 'published',
  render_backend: 'internal',
  line_account_id: 'account-1',
  definition_json: JSON.stringify({
    fields: [
      { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
      { id: 'email', type: 'email', label: '本人メール', required: true, position: 1, config: {} },
      { id: 'other_email', type: 'email', label: '別の連絡先', required: false, position: 2, config: {} },
    ],
    logic: [],
  }),
};

const baseSubmission = {
  id: 'ifs-1',
  form_id: 'form-1',
  friend_id: null,
  origin_channel: 'embed',
  answers_json: JSON.stringify({
    name: '山田花子',
    email: 'hanako@example.test',
    other_email: 'third-party@example.test',
  }),
  submitted_at: '2026-07-21T07:00:00+09:00',
  created_at: '2026-07-21T07:00:00+09:00',
  edit_version: 0,
};

const settings = {
  formId: 'form-1',
  enabled: true,
  recipientEmailFieldId: 'email',
  messageTemplate: 'こんにちは {{display_name}}\n名前: {{回答:お名前}}\n{{編集リンク}}',
  editLinkEpoch: 3,
  createdAt: '2026-07-21T07:00:00+09:00',
  updatedAt: '2026-07-21T07:00:00+09:00',
};

function env() {
  return {
    DB,
    LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token',
    FORMALOO_EDIT_TOKEN_SECRET: 'edit-secret',
    WORKER_URL: 'https://worker.example.test',
    FORM_EDIT_MAIL_ENABLED: 'true',
    RESEND_API_KEY: 'resend-secret',
    FORM_EDIT_MAIL_FROM: 'Forms <forms@example.test>',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFormalooForm.mockResolvedValue(form);
  dbMocks.getInternalFormSubmission.mockResolvedValue(baseSubmission);
  dbMocks.getInternalFormNotificationSettings.mockResolvedValue(settings);
  dbMocks.getFriendById.mockResolvedValue(null);
  dbMocks.getLineAccountById.mockResolvedValue(null);
  lineMocks.pushMessage.mockResolvedValue(undefined);
  mailMocks.sendEditMail.mockResolvedValue({
    status: 'sent',
    providerMessageId: 'mail-1',
    providerIdempotencyKey: 'internal-form-notification/ifs-1',
  });
});

describe('notifyInternalFormSubmission channel and recipient boundary', () => {
  test('an unconfigured form is OFF and performs no external delivery', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue(null);

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ status: 'skipped', reason: 'disabled' });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('per-form OFF performs no external delivery', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({ ...settings, enabled: false });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ status: 'skipped', reason: 'disabled' });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('signed LINE-origin submission pushes only to its persisted friend and never falls back to email', async () => {
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
    });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U_RESPONDENT',
      display_name: '山田花子',
      line_account_id: 'account-1',
    });
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-1',
      channel_access_token: 'account-token',
      is_active: 1,
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toMatchObject({ status: 'sent', channel: 'line' });
    expect(LineClient).toHaveBeenCalledWith('account-token');
    expect(lineMocks.pushMessage).toHaveBeenCalledWith('U_RESPONDENT', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('山田花子') }),
    ]);
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('embedded submission emails only the explicitly configured answer field', async () => {
    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toMatchObject({ status: 'sent', channel: 'email' });

    expect(mailMocks.sendEditMail).toHaveBeenCalledWith(
      expect.objectContaining({ FORM_EDIT_MAIL_ENABLED: 'true' }),
      expect.objectContaining({
        to: 'hanako@example.test',
        subject: '【参加申込】回答内容のご確認',
        text: expect.stringMatching(/山田花子[\s\S]+https:\/\/worker\.example\.test\/ife\//),
        idempotencyKey: 'internal-form-notification/ifs-1',
      }),
    );
    expect(JSON.stringify(mailMocks.sendEditMail.mock.calls)).not.toContain('third-party@example.test');
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('invalid signed LINE origin never degrades to email', async () => {
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'invalid',
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid_origin' });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('LINE account mismatch fails closed before constructing a sender', async () => {
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
    });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U_OTHER', display_name: '別人', line_account_id: 'account-2',
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ status: 'skipped', reason: 'account_mismatch' });
    expect(LineClient).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('recipient setting must still point at an email field in the current definition', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      recipientEmailFieldId: 'name',
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid_recipient_field' });
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });
});
