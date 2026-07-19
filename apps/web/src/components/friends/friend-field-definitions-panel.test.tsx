// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const createDefinition = vi.fn();
const updateDefinition = vi.fn();
const deleteDefinition = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    friendFieldDefinitions: {
      create: (...args: unknown[]) => createDefinition(...args),
      update: (...args: unknown[]) => updateDefinition(...args),
      delete: (...args: unknown[]) => deleteDefinition(...args),
    },
  },
}));

import FriendFieldDefinitionsPanel from './friend-field-definitions-panel';

beforeEach(() => {
  createDefinition.mockReset().mockResolvedValue({ success: true, data: {} });
  updateDefinition.mockReset().mockResolvedValue({ success: true, data: {} });
  deleteDefinition.mockReset().mockResolvedValue({ success: true, data: null });
});

afterEach(() => cleanup());

describe('FriendFieldDefinitionsPanel', () => {
  test('項目名・既定値・表示順を一度入力して tenant 定義を作成する', async () => {
    const onRefresh = vi.fn();
    render(<FriendFieldDefinitionsPanel definitions={[]} onRefresh={onRefresh} />);

    fireEvent.change(screen.getByLabelText('新しい項目名'), { target: { value: '入金確認' } });
    fireEvent.change(screen.getByLabelText('新しい既定値'), { target: { value: '未' } });
    fireEvent.change(screen.getByLabelText('新しい表示順'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '項目定義を追加' }));

    await waitFor(() => expect(createDefinition).toHaveBeenCalledWith({
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 4,
      isActive: true,
    }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test('既存定義の既定値と有効状態を更新する', async () => {
    const onRefresh = vi.fn();
    render(<FriendFieldDefinitionsPanel definitions={[{
      id: 'def-1',
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 1,
      isActive: true,
      createdAt: '2026-07-19',
      updatedAt: '2026-07-19',
    }]} onRefresh={onRefresh} />);

    fireEvent.change(screen.getByLabelText('入金確認の既定値'), { target: { value: '保留' } });
    fireEvent.click(screen.getByLabelText('入金確認を有効にする'));
    fireEvent.click(screen.getByRole('button', { name: '入金確認を保存' }));

    await waitFor(() => expect(updateDefinition).toHaveBeenCalledWith('def-1', {
      name: '入金確認',
      defaultValue: '保留',
      displayOrder: 1,
      isActive: false,
    }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test('不要な定義を削除できる', async () => {
    const onRefresh = vi.fn();
    render(<FriendFieldDefinitionsPanel definitions={[{
      id: 'def-1', name: '担当者', defaultValue: '未定', displayOrder: 0, isActive: true,
      createdAt: '2026-07-19', updatedAt: '2026-07-19',
    }]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: '担当者を削除' }));
    await waitFor(() => expect(deleteDefinition).toHaveBeenCalledWith('def-1'));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
