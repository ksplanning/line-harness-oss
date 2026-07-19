// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FormBuilder from './builder';
import type { FriendFieldDefinition, HarnessField } from '@line-crm/shared';

afterEach(() => cleanup());

function base(overrides = {}) {
  return {
    formTitle: '入金フォーム',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  };
}

const definitions: FriendFieldDefinition[] = [
  {
    id: 'def-1', name: '入金確認', defaultValue: '未', displayOrder: 0, isActive: true,
    createdAt: '2026-07-19', updatedAt: '2026-07-19',
  },
  {
    id: 'def-2', name: '非表示項目', defaultValue: '', displayOrder: 1, isActive: false,
    createdAt: '2026-07-19', updatedAt: '2026-07-19',
  },
];

describe('FormBuilder — 友だち個人情報への反映 mapping', () => {
  it('未設定は no-op と表示し、未編集 save には mapping key を載せない', () => {
    const onSave = vi.fn();
    render(<FormBuilder {...base({ onSave })} />);
    expect(screen.getByText(/未設定のため自動反映しません/)).toBeTruthy();
    fireEvent.click(screen.getByText('保存'));
    expect('friendMetadataMappings' in onSave.mock.calls[0][0]).toBe(false);
  });

  it('slug/alias と個人情報キーを設定して save payload に載せる', () => {
    const onSave = vi.fn();
    render(<FormBuilder {...base({ onSave })} />);
    fireEvent.click(screen.getByText('＋反映ルールを追加'));
    fireEvent.change(screen.getByLabelText('Formaloo field slug / alias'), { target: { value: 'BjEp0J2J' } });
    fireEvent.change(screen.getByLabelText('個人情報の項目名'), { target: { value: '入金確認' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onSave.mock.calls[0][0].friendMetadataMappings).toEqual([
      { formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' },
    ]);
  });

  it('保存済み mapping を初期表示し、削除は空配列として送る', () => {
    const onSave = vi.fn();
    render(<FormBuilder {...base({
      onSave,
      initialFriendMetadataMappings: [
        { formalooFieldKey: 'payment_alias', friendMetadataKey: '入金確認' },
      ],
    })} />);
    expect((screen.getByLabelText('Formaloo field slug / alias') as HTMLInputElement).value).toBe('payment_alias');
    expect((screen.getByLabelText('個人情報の項目名') as HTMLInputElement).value).toBe('入金確認');
    fireEvent.click(screen.getByLabelText('反映ルールを削除'));
    fireEvent.click(screen.getByText('保存'));
    expect(onSave.mock.calls[0][0].friendMetadataMappings).toEqual([]);
  });

  it('有効な定義項目を候補表示し、無効な定義は候補に出さない', () => {
    render(<FormBuilder {...base({ fieldDefinitions: definitions })} />);
    fireEvent.click(screen.getByText('＋反映ルールを追加'));
    const input = screen.getByLabelText('個人情報の項目名') as HTMLInputElement;
    expect(input.getAttribute('list')).toBe('friend-field-definition-options');
    const optionValues = Array.from(
      document.querySelectorAll<HTMLOptionElement>('#friend-field-definition-options option'),
      (option) => option.value,
    );
    expect(optionValues).toEqual(['入金確認']);
  });

  it('候補にない自由文字列も従来どおり入力して保存できる', () => {
    const onSave = vi.fn();
    render(<FormBuilder {...base({ onSave, fieldDefinitions: definitions })} />);
    fireEvent.click(screen.getByText('＋反映ルールを追加'));
    fireEvent.change(screen.getByLabelText('Formaloo field slug / alias'), { target: { value: 'memo_alias' } });
    fireEvent.change(screen.getByLabelText('個人情報の項目名'), { target: { value: '定義外の自由項目' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onSave.mock.calls[0][0].friendMetadataMappings).toEqual([
      { formalooFieldKey: 'memo_alias', friendMetadataKey: '定義外の自由項目' },
    ]);
  });
});
