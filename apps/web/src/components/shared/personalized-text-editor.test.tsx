// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
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

function Harness({
  initial = '',
  mode,
}: {
  initial?: string;
  mode?: 'variables-and-emoji' | 'emoji-only';
}) {
  const [value, setValue] = useState(initial);
  return (
    <PersonalizedTextEditor
      value={value}
      onChange={setValue}
      mode={mode}
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
  window.localStorage.clear();
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

  test('RTL 本文でも論理的な選択位置へ変数を挿入し、カーソル位置を復帰する', async () => {
    const rtlText = 'שלום بالعالم';
    const logicalInsertionPoint = 'שלום'.length;
    const token = '{{display_name|お客様}}';
    render(
      <div dir="rtl">
        <Harness initial={rtlText} />
      </div>,
    );
    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;
    expect(textarea.closest('[dir="rtl"]')).toBeTruthy();
    textarea.focus();
    textarea.setSelectionRange(logicalInsertionPoint, logicalInsertionPoint);

    fireEvent.click(screen.getByRole('button', { name: '変数を挿入' }));
    fireEvent.click(screen.getByRole('button', { name: '友だちの名前' }));

    const expectedCaret = logicalInsertionPoint + token.length;
    await waitFor(() => expect(textarea.value).toBe(`שלום${token} بالعالم`));
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(expectedCaret);
      expect(textarea.selectionEnd).toBe(expectedCaret);
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

  test('絵文字のみモードは変数を表示・取得せず、RTL 本文のタップ位置へ絵文字を挿入する', async () => {
    const rtlText = 'שלום بالعالم';
    const insertionPoint = 'שלום'.length;
    render(
      <div dir="rtl">
        <Harness initial={rtlText} mode="emoji-only" />
      </div>,
    );

    const textarea = screen.getByRole('textbox', { name: 'ステップのメッセージ内容' }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(insertionPoint, insertionPoint);

    expect(screen.queryByRole('button', { name: '変数を挿入' })).toBeNull();
    expect(api.friendFieldDefinitions.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));
    fireEvent.click(screen.getByRole('button', { name: '絵文字 🎉 を挿入' }));

    await waitFor(() => expect(textarea.value).toBe('שלום🎉 بالعالم'));
    await waitFor(() => expect(textarea.selectionStart).toBe(insertionPoint + '🎉'.length));
  });

  test('ピッカー内に OS ショートカット tip を表示する', () => {
    render(<Harness mode="emoji-only" />);

    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));

    expect(screen.getByText('PC は Win+. / Mac は Ctrl+Cmd+Space でも入力できます')).toBeTruthy();
  });

  test('端末内の最近使った絵文字を先頭行へ出し、選択順・重複排除・最大8件を保存する', async () => {
    window.localStorage.setItem(
      'line-crm:recent-emojis',
      JSON.stringify(['🎉', '😊', '😂', '🥰', '😍', '😄', '😉', '😢']),
    );
    render(<Harness mode="emoji-only" />);

    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));
    const dialog = screen.getByRole('dialog', { name: '絵文字を選ぶ' });
    const recentLabel = screen.getByText('最近使った');
    const categoryTabs = screen.getByRole('tablist', { name: '絵文字カテゴリ' });
    expect(dialog.contains(recentLabel)).toBe(true);
    expect(recentLabel.compareDocumentPosition(categoryTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '絵文字 😭 を挿入' }));

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem('line-crm:recent-emojis') ?? '[]')).toEqual([
        '😭', '🎉', '😊', '😂', '🥰', '😍', '😄', '😉',
      ]);
    });
    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));
    expect(screen.getByRole('button', { name: '最近使った絵文字 😭 を挿入' })).toBeTruthy();
  });

  test('別の入力欄で更新された最近使った絵文字を、ピッカーを開く時に読み直す', () => {
    render(<Harness mode="emoji-only" />);
    window.localStorage.setItem('line-crm:recent-emojis', JSON.stringify(['🌸']));

    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));

    expect(screen.getByRole('button', { name: '最近使った絵文字 🌸 を挿入' })).toBeTruthy();
  });

  test('単一行入力でもカーソル挿入し、既存の keydown と外部 ref を保つ', async () => {
    const onKeyDown = vi.fn();

    function SingleLineHarness() {
      const [value, setValue] = useState('返信です');
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <PersonalizedTextEditor
          value={value}
          onChange={setValue}
          mode="emoji-only"
          multiline={false}
          ariaLabel="単一行メッセージ"
          inputRef={inputRef}
          inputProps={{ onKeyDown }}
        />
      );
    }

    render(<SingleLineHarness />);
    const input = screen.getByRole('textbox', { name: '単一行メッセージ' }) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    input.focus();
    input.setSelectionRange(2, 2);

    fireEvent.click(screen.getByRole('button', { name: '絵文字' }));
    fireEvent.click(screen.getByRole('button', { name: '絵文字 😊 を挿入' }));
    await waitFor(() => expect(input.value).toBe('返信😊です'));

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
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
