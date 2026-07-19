// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getFriend = vi.fn();
const updateMetadata = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    friends: {
      get: (...args: unknown[]) => getFriend(...args),
      updateMetadata: (...args: unknown[]) => updateMetadata(...args),
    },
  },
}));

import CustomMetadataEditor from './custom-metadata-editor';

beforeEach(() => {
  getFriend.mockReset();
  updateMetadata.mockReset();
  getFriend.mockResolvedValue({
    success: true,
    data: {
      metadata: {
        入金確認: '済',
        __formaloo_friend_metadata_sync: {
          入金確認: { formId: 'form_pay', rowId: 'ROW_PAY', value: '済' },
        },
      },
    },
  });
  updateMetadata.mockResolvedValue({ success: true, data: {} });
});

afterEach(() => cleanup());

describe('CustomMetadataEditor — 自動反映値と手動編集の共存', () => {
  it('入金確認=済を個人情報欄に表示し、内部由来 marker は表示しない', async () => {
    render(<CustomMetadataEditor friendId="fr_1" />);
    expect(await screen.findByText('入金確認')).toBeTruthy();
    expect(screen.getByText('済')).toBeTruthy();
    expect(screen.queryByText('__formaloo_friend_metadata_sync')).toBeNull();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });

  it('手動編集は対象1キーだけ PUT し、他 metadata を巻き込まない', async () => {
    render(<CustomMetadataEditor friendId="fr_1" />);
    await screen.findByText('入金確認');
    fireEvent.click(screen.getByText('編集'));
    fireEvent.change(screen.getByDisplayValue('済'), { target: { value: '手動で保留' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(updateMetadata).toHaveBeenCalledWith('fr_1', { 入金確認: '手動で保留' }));
  });

  it('内部由来キーを手動追加できない', async () => {
    render(<CustomMetadataEditor friendId="fr_1" />);
    await screen.findByText('入金確認');
    fireEvent.click(screen.getByText('項目を追加'));
    fireEvent.change(screen.getByPlaceholderText('例: 会社名'), {
      target: { value: '__formaloo_friend_metadata_sync' },
    });
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText('この項目名は予約されているため使えません')).toBeTruthy();
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
