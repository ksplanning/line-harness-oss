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

const dbStatement = {
  bind: vi.fn().mockReturnThis(),
  run: vi.fn().mockResolvedValue({ success: true }),
};
const DB = {
  prepare: vi.fn(() => dbStatement),
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

function bothSkipped(reason: string) {
  return {
    line: { status: 'skipped', reason },
    email: { status: 'skipped', reason },
  };
}

function mockLineSubmission(): void {
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
    is_following: 1,
  });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1',
    channel_access_token: 'account-token',
    is_active: 1,
  });
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
      .resolves.toEqual(bothSkipped('disabled'));
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('per-form OFF performs no external delivery', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({ ...settings, enabled: false });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual(bothSkipped('disabled'));
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('an unpublished form skips both channels', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({ ...form, builder_status: 'draft' });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual(bothSkipped('ineligible_form'));
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('a LINE friend with an email answer receives both channels for one submission', async () => {
    mockLineSubmission();

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({ line: { status: 'sent' }, email: { status: 'sent' } });
    expect(LineClient).toHaveBeenCalledWith('account-token');
    expect(lineMocks.pushMessage).toHaveBeenCalledWith('U_RESPONDENT', [
      expect.objectContaining({ type: 'text', text: expect.stringContaining('山田花子') }),
    ]);
    expect(mailMocks.sendEditMail).toHaveBeenCalledWith(
      expect.objectContaining({ FORM_EDIT_MAIL_ENABLED: 'true' }),
      expect.objectContaining({
        to: 'hanako@example.test',
        idempotencyKey: 'internal-form-notification/ifs-1',
      }),
    );
    expect(JSON.stringify(mailMocks.sendEditMail.mock.calls)).not.toContain('third-party@example.test');

    const deliveredText = lineMocks.pushMessage.mock.calls[0]?.[1]?.[0]?.text;
    const loggedText = dbStatement.bind.mock.calls[0]?.[2];
    expect(deliveredText).toMatch(/https:\/\/worker\.example\.test\/ife\//);
    expect(loggedText).toContain('[編集リンクを送信済み]');
    expect(loggedText).not.toContain('/ife/');
  });

  test('a LINE-only form without a recipient email field still pushes LINE', async () => {
    mockLineSubmission();
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      recipientEmailFieldId: null,
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'sent' },
        email: { status: 'skipped', reason: 'no_email_field' },
      });
    expect(lineMocks.pushMessage).toHaveBeenCalled();
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test.each([
    { length: 5_000, expectedLengths: [5_000] },
    { length: 5_001, expectedLengths: [5_000, 1] },
  ])('splits $length UTF-16 code units into valid LINE text messages', async ({ length, expectedLengths }) => {
    mockLineSubmission();
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      messageTemplate: 'a'.repeat(length),
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toMatchObject({ line: { status: 'sent' } });

    const messages = lineMocks.pushMessage.mock.calls[0]?.[1] as Array<{ type: string; text: string }>;
    expect(messages.map((message) => message.text.length)).toEqual(expectedLengths);
    expect(messages.map((message) => message.text).join('')).toBe('a'.repeat(length));
  });

  test('does not split a surrogate pair at the 5000-code-unit boundary', async () => {
    mockLineSubmission();
    const text = `${'a'.repeat(4_999)}😀b`;
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({ ...settings, messageTemplate: text });

    await notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' });

    const messages = lineMocks.pushMessage.mock.calls[0]?.[1] as Array<{ type: string; text: string }>;
    expect(messages.map((message) => message.text.length)).toEqual([4_999, 3]);
    expect(messages.map((message) => message.text).join('')).toBe(text);
  });

  test('keeps an edit URL whole when its original position crosses a chunk boundary', async () => {
    mockLineSubmission();
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      messageTemplate: `${'a'.repeat(4_990)}{{編集リンク}}`,
    });

    await notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' });

    const messages = lineMocks.pushMessage.mock.calls[0]?.[1] as Array<{ type: string; text: string }>;
    expect(messages.some((message) => /https:\/\/worker\.example\.test\/ife\/[A-Za-z0-9._-]+/.test(message.text)))
      .toBe(true);
    expect(messages.every((message) => message.text.length <= 5_000)).toBe(true);
  });

  test('preserves an edit URL that would otherwise fall inside the omitted middle', async () => {
    mockLineSubmission();
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      messageTemplate: '{{回答:お名前}}{{編集リンク}}{{回答:別の連絡先}}',
    });
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
      answers_json: JSON.stringify({
        name: 'a'.repeat(22_000),
        email: 'hanako@example.test',
        other_email: 'b'.repeat(8_000),
      }),
    });

    await notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' });

    const messages = lineMocks.pushMessage.mock.calls[0]?.[1] as Array<{ type: string; text: string }>;
    expect(messages).toHaveLength(5);
    expect(messages.some((message) => /https:\/\/worker\.example\.test\/ife\/[A-Za-z0-9._-]+/.test(message.text)))
      .toBe(true);
  });

  test('caps a very long default answer at five messages while preserving the edit link', async () => {
    mockLineSubmission();
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({ ...settings, messageTemplate: '' });
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
      answers_json: JSON.stringify({
        name: 'あ'.repeat(30_000),
        email: 'hanako@example.test',
        other_email: 'third-party@example.test',
      }),
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toMatchObject({ line: { status: 'sent' } });

    const messages = lineMocks.pushMessage.mock.calls[0]?.[1] as Array<{ type: string; text: string }>;
    expect(messages).toHaveLength(5);
    expect(messages.every((message) => message.text.length <= 5_000)).toBe(true);
    expect(messages[4]?.text).toContain('中間部分を省略しました');
    expect(messages[4]?.text).toMatch(/https:\/\/worker\.example\.test\/ife\//);
  });

  test('embedded submission emails only the explicitly configured answer field', async () => {
    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'missing_friend' },
        email: { status: 'sent' },
      });

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

  test('invalid signed LINE origin skips LINE but still emails the configured answer field', async () => {
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'invalid',
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'invalid_origin' },
        email: { status: 'sent' },
      });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'hanako@example.test' }),
    );
  });

  test('LINE account mismatch fails the LINE channel closed without blocking email', async () => {
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
    });
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1', line_user_id: 'U_OTHER', display_name: '別人', line_account_id: 'account-2', is_following: 1,
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'account_mismatch' },
        email: { status: 'sent' },
      });
    expect(LineClient).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'hanako@example.test' }),
    );
  });

  test('a scoped friend never matches a form with a different account scope', async () => {
    mockLineSubmission();
    dbMocks.getFormalooForm.mockResolvedValue({ ...form, line_account_id: null });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'account_mismatch' },
        email: { status: 'sent' },
      });
    expect(LineClient).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).toHaveBeenCalled();
  });

  test('a friend who is no longer following skips LINE without blocking email', async () => {
    mockLineSubmission();
    dbMocks.getFriendById.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U_RESPONDENT',
      display_name: '山田花子',
      line_account_id: 'account-1',
      is_following: 0,
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'missing_friend' },
        email: { status: 'sent' },
      });
    expect(LineClient).not.toHaveBeenCalled();
    expect(mailMocks.sendEditMail).toHaveBeenCalled();
  });

  test('a LINE push failure is reported per channel while email still delivers', async () => {
    mockLineSubmission();
    lineMocks.pushMessage.mockRejectedValue(new Error('line down'));

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'failed', reason: 'line_push_failed' },
        email: { status: 'sent' },
      });
  });

  test('recipient setting must still point at an email field in the current definition', async () => {
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      recipientEmailFieldId: 'name',
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'missing_friend' },
        email: { status: 'skipped', reason: 'invalid_recipient_field' },
      });
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });

  test('stale settings cannot address an email field used only inside repeating rows', async () => {
    dbMocks.getFormalooForm.mockResolvedValue({
      ...form,
      definition_json: JSON.stringify({
        fields: [
          { id: 'row_email', type: 'email', label: '同行者メール', required: false, position: 0, config: {} },
          {
            id: 'participants',
            type: 'repeating_section',
            label: '同行者',
            required: false,
            position: 1,
            config: { repeatingColumns: [{ columnField: 'row_email', title: 'メール' }] },
          },
        ],
        logic: [],
      }),
    });
    dbMocks.getInternalFormNotificationSettings.mockResolvedValue({
      ...settings,
      recipientEmailFieldId: 'row_email',
      messageTemplate: null,
    });
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      answers_json: JSON.stringify({
        row_email: 'third-party@example.test',
        participants: [{ row_email: 'third-party@example.test' }],
      }),
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'skipped', reason: 'missing_friend' },
        email: { status: 'skipped', reason: 'invalid_recipient_field' },
      });
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('an empty email answer skips only the email channel', async () => {
    mockLineSubmission();
    dbMocks.getInternalFormSubmission.mockResolvedValue({
      ...baseSubmission,
      origin_channel: 'line',
      friend_id: 'friend-1',
      answers_json: JSON.stringify({ name: '山田花子', email: '' }),
    });

    await expect(notifyInternalFormSubmission(env(), { formId: 'form-1', submissionId: 'ifs-1' }))
      .resolves.toEqual({
        line: { status: 'sent' },
        email: { status: 'skipped', reason: 'invalid_recipient' },
      });
    expect(mailMocks.sendEditMail).not.toHaveBeenCalled();
  });
});
