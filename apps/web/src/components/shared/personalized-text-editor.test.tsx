// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from '@/lib/api';
import PersonalizedTextEditor from './personalized-text-editor';

vi.mock('@/lib/api', () => ({
  api: {
    friendFieldDefinitions: {
      list: vi.fn(),
    },
  },
}));

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <PersonalizedTextEditor
      value={value}
      onChange={setValue}
      ariaLabel="ステップのメッセージ内容"
      placeholder="メッセージ内容を入力..."
    />
  );
}

const activeDefinition = {
  id: 'field-active',
  name: '会員ランク',
  defaultValue: '未登録',
  displayOrder: 1,
  isActive: true,
  createdAt: '2026-07-20T00:00:00+09:00',
  updatedAt: '2026-07-20T00:00:00+09:00',
};

beforeEach(() => {
  vi.mocked(api.friendFieldDefinitions.list).mockResolvedValue({
    success: true,
    data: [
      activeDefinition,
      { ...activeDefinition, id: 'field-inactive', name: '廃止項目', isActive: false },
    ],
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('PersonalizedTextEditor', () => {
  test('友だちの名前を現在のカーソル位置へ挿入し、挿入後へカーソルを戻す', async () => {
    render(<Harness initial="こんにちはさん" />);
    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(5, 5);

    fireEvent.click(screen.getByRole('button', { name: '変数を挿入' }));
    fireEvent.click(screen.getByRole('button', { name: '友だちの名前' }));

    const token = '{{display_name|お客様}}';
    await waitFor(() => expect(textarea.value).toBe(`こんにちは${token}さん`));
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(5 + token.length);
      expect(textarea.selectionEnd).toBe(5 + token.length);
    });
  });

  test('有効なカスタム項目だけを表示し、選択範囲を field token で置き換える', async () => {
    render(<Harness initial="AここB" />);
    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole('button', { name: '変数を挿入' }));
    expect(await screen.findByRole('button', { name: '会員ランク' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '廃止項目' })).toBeNull();

    textarea.focus();
    textarea.setSelectionRange(1, 3);
    fireEvent.click(screen.getByRole('button', { name: '会員ランク' }));

    await waitFor(() => expect(textarea.value).toBe('A{{field:会員ランク}}B'));
  });

  test('UTF-16 の絵文字を壊さず、絵文字の直後のカーソル位置へ追加する', async () => {
    render(<Harness initial="A😀B" />);
    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(3, 3);

    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));
    fireEvent.click(screen.getByRole('button', { name: '絵文字 😊 を挿入' }));

    await waitFor(() => expect(textarea.value).toBe('A😀😊B'));
    await waitFor(() => expect(textarea.selectionStart).toBe(5));
  });

  test('カスタム項目 API が失敗しても、名前変数と絵文字と通常入力は使える', async () => {
    vi.mocked(api.friendFieldDefinitions.list).mockRejectedValueOnce(new Error('unavailable'));
    render(<Harness />);

    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '通常入力' } });
    expect(textarea.value).toBe('通常入力');

    fireEvent.click(screen.getByRole('button', { name: '変数を挿入' }));
    expect(screen.getByRole('button', { name: '友だちの名前' })).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '会員ランク' })).toBeNull();
    expect(screen.getByRole('button', { name: '絵文字' })).toBeTruthy();
  });
});
