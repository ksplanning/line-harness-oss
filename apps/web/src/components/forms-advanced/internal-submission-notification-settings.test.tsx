// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InternalSubmissionNotificationField } from '@line-crm/shared';

const notificationApi = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  revokeLinks: vi.fn(),
}));

vi.mock('@/lib/internal-form-notification-api', () => ({
  internalFormNotificationApi: notificationApi,
}));

import InternalSubmissionNotificationSettings from './internal-submission-notification-settings';

function field(
  id: string,
  label: string,
  type: InternalSubmissionNotificationField['type'] = 'text',
): InternalSubmissionNotificationField {
  return { id, label, type, config: {} };
}

const fields = [
  field('name', 'お名前'),
  field('email', 'メールアドレス', 'email'),
  field('duplicate-1', '重複項目'),
  field('duplicate-2', '重複項目'),
  field('heading', '案内', 'section'),
];

const initialSettings = {
  formId: 'form-1',
  enabled: false,
  recipientEmailFieldId: null,
  messageTemplate: null,
  editLinkEpoch: 2,
};

function renderEditor() {
  return render(
    <InternalSubmissionNotificationSettings
      formId="form-1"
      formTitle="参加申込"
      fields={fields}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  notificationApi.get.mockResolvedValue(initialSettings);
  notificationApi.save.mockImplementation(async (_formId, input) => ({
    ...initialSettings,
    ...input,
  }));
  notificationApi.revokeLinks.mockResolvedValue(3);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InternalSubmissionNotificationSettings', () => {
  test('loads the per-form switch, explicit email destination, variables and dynamic default preview', async () => {
    renderEditor();

    expect(await screen.findByRole('heading', { name: '回答後の自動通知' })).toBeTruthy();
    expect(notificationApi.get).toHaveBeenCalledWith('form-1');
    expect((screen.getByRole('checkbox', { name: '回答後の自動通知' }) as HTMLInputElement).checked).toBe(false);

    const emailSelect = screen.getByRole('combobox', { name: '回答者本人のメール項目' });
    expect((emailSelect as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('option', { name: 'メールアドレス' }) as HTMLOptionElement).value).toBe('email');

    expect(screen.getByRole('button', { name: '{{display_name}} を差し込む' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '{{回答:お名前}} を差し込む' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '{{回答:メールアドレス}} を差し込む' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '{{回答:重複項目}} を差し込む' })).toBeNull();
    expect(screen.getByRole('button', { name: '{{編集リンク}} を差し込む' })).toBeTruthy();

    expect(screen.getByRole('textbox', { name: '通知文面' }).getAttribute('dir')).toBe('auto');
    const preview = screen.getByTestId('notification-preview');
    expect(preview.getAttribute('dir')).toBe('auto');
    expect(preview.getAttribute('aria-live')).toBe('polite');
    expect(preview.textContent).toContain('「参加申込」へのご回答ありがとうございます。');
    expect(preview.textContent).toContain('お名前: サンプル回答');
    expect(preview.textContent).toContain('メールアドレス: sample@example.com');
    expect(preview.textContent).toContain('https://example.test/edit/sample');
  });

  test('inserts an answer token at the caret without reordering RTL text', async () => {
    notificationApi.get.mockResolvedValue({
      ...initialSettings,
      messageTemplate: 'שלום\nסוף',
    });
    renderEditor();
    const textarea = await screen.findByRole('textbox', { name: '通知文面' });

    textarea.focus();
    textarea.setSelectionRange(4, 4);
    fireEvent.click(screen.getByRole('button', { name: '{{回答:お名前}} を差し込む' }));

    expect((textarea as HTMLTextAreaElement).value).toBe('שלום{{回答:お名前}}\nסוף');
    expect(screen.getByTestId('notification-preview').textContent).toContain('שלוםサンプル回答\nסוף');
  });

  test('keeps an unsaved notification draft when the parent edits form fields', async () => {
    const rendered = renderEditor();
    const textarea = await screen.findByRole('textbox', { name: '通知文面' });
    fireEvent.change(textarea, { target: { value: '編集中の通知文' } });

    rendered.rerender(
      <InternalSubmissionNotificationSettings
        formId="form-1"
        formTitle="参加申込"
        fields={[...fields, field('company', '会社名')]}
      />,
    );

    expect(notificationApi.get).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: '通知文面' }) as HTMLTextAreaElement).value).toBe('編集中の通知文');
    expect(screen.getByRole('button', { name: '{{回答:会社名}} を差し込む' })).toBeTruthy();
  });

  test('shows template validation honestly and does not send an invalid save', async () => {
    renderEditor();
    const textarea = await screen.findByRole('textbox', { name: '通知文面' });
    fireEvent.change(textarea, { target: { value: '{{回答:存在しない項目}}' } });

    expect(screen.getByRole('alert').textContent).toContain('回答項目「存在しない項目」が見つかりません');
    fireEvent.click(screen.getByRole('button', { name: '通知設定を保存' }));
    expect(notificationApi.save).not.toHaveBeenCalled();
  });

  test('requires an explicit respondent email field before enabling and saves the complete draft', async () => {
    renderEditor();
    const enabled = await screen.findByRole('checkbox', { name: '回答後の自動通知' });
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole('button', { name: '通知設定を保存' }));

    expect(screen.getByRole('alert').textContent).toContain('回答者本人のメール項目を選んでください');
    expect(notificationApi.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox', { name: '回答者本人のメール項目' }), {
      target: { value: 'email' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '通知文面' }), {
      target: { value: '{{display_name}}さん\n{{編集リンク}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '通知設定を保存' }));

    await waitFor(() => expect(notificationApi.save).toHaveBeenCalledWith('form-1', {
      enabled: true,
      recipientEmailFieldId: 'email',
      messageTemplate: '{{display_name}}さん\n{{編集リンク}}',
    }));
    expect(await screen.findByText('通知設定を保存しました')).toBeTruthy();
    expect(screen.getByTestId('notification-enabled-status').textContent).toContain('ON');
  });

  test('keeps the draft and surfaces the server error when saving fails', async () => {
    notificationApi.save.mockRejectedValue({ body: { error: '保存先で競合しました' } });
    renderEditor();
    const textarea = await screen.findByRole('textbox', { name: '通知文面' });
    fireEvent.change(textarea, { target: { value: 'あとで確認してください' } });
    fireEvent.click(screen.getByRole('button', { name: '通知設定を保存' }));

    expect((await screen.findByRole('alert')).textContent).toContain('保存先で競合しました');
    expect((textarea as HTMLTextAreaElement).value).toBe('あとで確認してください');
    expect(screen.queryByText('通知設定を保存しました')).toBeNull();
  });

  test('asks before revoking edit links, then reports the updated epoch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderEditor();
    await screen.findByRole('heading', { name: '回答後の自動通知' });

    const revoke = screen.getByRole('button', { name: '発行済みの編集リンクを失効' });
    fireEvent.click(revoke);
    expect(notificationApi.revokeLinks).not.toHaveBeenCalled();

    fireEvent.click(revoke);
    expect(confirm).toHaveBeenCalledWith('これまでに発行した編集リンクをすべて使えなくします。よろしいですか？');
    await waitFor(() => expect(notificationApi.revokeLinks).toHaveBeenCalledWith('form-1'));
    expect(await screen.findByText('以前の編集リンクを失効しました')).toBeTruthy();
    expect(screen.getByTestId('edit-link-epoch').textContent).toContain('現在の世代: 3');
  });
});
