// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { FriendFieldDefinition, Tag } from '@line-crm/shared'
import type { FormSubmitAction } from '@/lib/formaloo-advanced-api'
import FormBuilder from './builder'

afterEach(cleanup)

const tags: Tag[] = [
  { id: 'tag-vip', name: 'VIP', color: '#06C755', createdAt: '2026-07-23' },
  { id: 'tag-old', name: '旧会員', color: '#999999', createdAt: '2026-07-23' },
]

const fieldDefinitions: FriendFieldDefinition[] = [
  {
    id: 'field-status',
    name: '入金確認',
    defaultValue: '未',
    displayOrder: 0,
    isActive: true,
    createdAt: '2026-07-23',
    updatedAt: '2026-07-23',
  },
  {
    id: 'field-note',
    name: 'メモ',
    defaultValue: '',
    displayOrder: 1,
    isActive: true,
    createdAt: '2026-07-23',
    updatedAt: '2026-07-23',
  },
]

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: '申込フォーム',
    status: 'draft' as const,
    initialFields: [],
    initialLogic: [],
    initialSubmitActions: [] as FormSubmitAction[],
    tags,
    fieldDefinitions,
    workspaceTab: 'after-submit' as const,
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('FormBuilder — 送信後にやること', () => {
  it('旧 onSubmitTagId 由来の synthetic action を表示し、未編集保存では submitActions を送らない', () => {
    const onSave = vi.fn()
    render(
      <FormBuilder
        {...base({
          onSave,
          initialSubmitActions: [{ type: 'add_tag', tagId: 'tag-old' }],
        })}
      />,
    )

    expect((screen.getByLabelText('アクション 1の種類') as HTMLSelectElement).value).toBe('add_tag')
    expect((screen.getByLabelText('アクション 1のタグ') as HTMLSelectElement).value).toBe('tag-old')

    fireEvent.click(screen.getByText('保存'))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect('submitActions' in onSave.mock.calls[0][0]).toBe(false)
  })

  it('4種類を追加し、作成済みタグ・カスタム項目と設定値を ordered payload にする', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByRole('button', { name: 'やることを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 1のタグ'), { target: { value: 'tag-vip' } })

    fireEvent.click(screen.getByRole('button', { name: 'やることを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 2の種類'), { target: { value: 'remove_tag' } })
    fireEvent.change(screen.getByLabelText('アクション 2のタグ'), { target: { value: 'tag-old' } })

    fireEvent.click(screen.getByRole('button', { name: 'やることを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 3の種類'), { target: { value: 'set_field' } })
    fireEvent.change(screen.getByLabelText('アクション 3のカスタム項目'), { target: { value: 'field-status' } })
    fireEvent.change(screen.getByLabelText('アクション 3の値'), { target: { value: '済' } })

    fireEvent.click(screen.getByRole('button', { name: 'やることを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 4の種類'), { target: { value: 'clear_field' } })
    fireEvent.change(screen.getByLabelText('アクション 4のカスタム項目'), { target: { value: 'field-note' } })

    expect(
      within(screen.getByLabelText('アクション 1のタグ')).getByRole('option', { name: 'VIP' }),
    ).toBeTruthy()
    expect(
      within(screen.getByLabelText('アクション 3のカスタム項目')).getByRole('option', { name: '入金確認' }),
    ).toBeTruthy()

    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].submitActions).toEqual([
      { type: 'add_tag', tagId: 'tag-vip' },
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
      { type: 'clear_field', fieldId: 'field-note' },
    ])
  })

  it('上下ボタンで順番を変え、削除した結果を保存する', () => {
    const onSave = vi.fn()
    const initialSubmitActions: FormSubmitAction[] = [
      { type: 'add_tag', tagId: 'tag-vip' },
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'clear_field', fieldId: 'field-note' },
    ]
    render(<FormBuilder {...base({ onSave, initialSubmitActions })} />)

    expect((screen.getByRole('button', { name: 'アクション 1を上へ移動' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'アクション 3を下へ移動' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'アクション 3を上へ移動' }))
    fireEvent.click(screen.getByRole('button', { name: 'アクション 1を削除' }))
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].submitActions).toEqual([
      { type: 'clear_field', fieldId: 'field-note' },
      { type: 'remove_tag', tagId: 'tag-old' },
    ])
  })

  it('すべて削除したときは空配列を明示送信して旧タグ fallback の復活を防ぐ', () => {
    const onSave = vi.fn()
    render(
      <FormBuilder
        {...base({
          onSave,
          initialSubmitActions: [{ type: 'add_tag', tagId: 'tag-old' }],
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'アクション 1を削除' }))
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].submitActions).toEqual([])
  })
})
