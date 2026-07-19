// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FriendFieldDefinition } from '@line-crm/shared';

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

const paymentDefinition: FriendFieldDefinition = {
  id: 'def-payment',
  name: '入金確認',
  defaultValue: '未',
  displayOrder: 0,
  isActive: true,
  createdAt: '2026-07-19',
  updatedAt: '2026-07-19',
};

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

  it('metadata に値がない定義項目は既定値を表示する', async () => {
    getFriend.mockResolvedValue({ success: true, data: { metadata: { 独自メモ: '残す' } } });
    render(<CustomMetadataEditor friendId="fr_1" fieldDefinitions={[paymentDefinition]} />);
    expect(await screen.findByText('入金確認')).toBeTruthy();
    expect(screen.getByText('未')).toBeTruthy();
    expect(screen.getByText('独自メモ')).toBeTruthy();
    expect(screen.getByText('残す')).toBeTruthy();
  });

  it('reconcile の実値は既定値より優先し、同名行を二重表示しない', async () => {
    render(<CustomMetadataEditor friendId="fr_1" fieldDefinitions={[paymentDefinition]} />);
    expect(await screen.findByText('済')).toBeTruthy();
    expect(screen.getAllByText('入金確認')).toHaveLength(1);
    expect(screen.queryByText('未')).toBeNull();
  });

  it('明示された空文字は値として優先し、既定値へ戻さない', async () => {
    getFriend.mockResolvedValue({ success: true, data: { metadata: { 入金確認: '' } } });
    render(<CustomMetadataEditor friendId="fr_1" fieldDefinitions={[paymentDefinition]} />);
    expect(await screen.findByText('（未入力）')).toBeTruthy();
    expect(screen.queryByText('未')).toBeNull();
  });

  it('既定値だけの行もその場で編集し、対象1キーだけ PUT する', async () => {
    getFriend.mockResolvedValue({ success: true, data: { metadata: {} } });
    render(<CustomMetadataEditor friendId="fr_1" fieldDefinitions={[paymentDefinition]} />);
    await screen.findByText('未');
    fireEvent.click(screen.getByText('編集'));
    fireEvent.change(screen.getByDisplayValue('未'), { target: { value: '済' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(updateMetadata).toHaveBeenCalledWith('fr_1', { 入金確認: '済' }));
  });

  it('定義ゼロかつ metadata ゼロなら従来の空状態を保つ', async () => {
    getFriend.mockResolvedValue({ success: true, data: { metadata: {} } });
    render(<CustomMetadataEditor friendId="fr_1" />);
    expect(await screen.findByText(/まだカスタム項目はありません/)).toBeTruthy();
  });

  it('定義ゼロは変更前 DOM snapshot と byte 同等', async () => {
    getFriend.mockResolvedValue({ success: true, data: { metadata: { 独自メモ: '残す' } } });
    const omitted = render(<CustomMetadataEditor friendId="fr_1" />);
    await screen.findByText('残す');
    // Base 6669974 の変更前 renderer から固定した byte 契約。
    expect(omitted.container.innerHTML).toMatchInlineSnapshot(`"<div><p class="text-[11px] font-medium text-gray-500 mb-2">カスタム項目</p><div class="space-y-1.5"><div class="flex items-center gap-2 flex-wrap"><span class="text-xs font-medium text-gray-600 min-w-[6rem] break-all">独自メモ</span><span class="flex-1 text-xs text-gray-800 break-all">残す</span><button class="text-xs font-medium text-green-600 hover:text-green-700 px-2 py-1 rounded-md hover:bg-green-50 transition-colors">編集</button></div></div><button class="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 mt-3 transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>項目を追加</button></div>"`);
    omitted.unmount();

    const explicitZero = render(<CustomMetadataEditor friendId="fr_1" fieldDefinitions={[]} />);
    await screen.findByText('残す');
    expect(explicitZero.container.innerHTML).toMatchInlineSnapshot(`"<div><p class="text-[11px] font-medium text-gray-500 mb-2">カスタム項目</p><div class="space-y-1.5"><div class="flex items-center gap-2 flex-wrap"><span class="text-xs font-medium text-gray-600 min-w-[6rem] break-all">独自メモ</span><span class="flex-1 text-xs text-gray-800 break-all">残す</span><button class="text-xs font-medium text-green-600 hover:text-green-700 px-2 py-1 rounded-md hover:bg-green-50 transition-colors">編集</button></div></div><button class="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 mt-3 transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>項目を追加</button></div>"`);
  });
});
