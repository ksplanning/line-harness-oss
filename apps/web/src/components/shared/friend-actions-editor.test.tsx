// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FriendFieldDefinition, Tag } from '@line-crm/shared'
import type { FormSubmitAction } from '@/lib/formaloo-advanced-api'
import FriendActionsEditor from './friend-actions-editor'

afterEach(cleanup)

const tags: Tag[] = [
  { id: 'tag-vip', name: 'VIP', color: '#06C755', createdAt: '2026-07-24' },
  { id: 'tag-old', name: '旧会員', color: '#999999', createdAt: '2026-07-24' },
]

const fieldDefinitions: FriendFieldDefinition[] = [
  {
    id: 'field-status',
    name: '入金確認',
    defaultValue: '未',
    displayOrder: 0,
    isActive: true,
    createdAt: '2026-07-24',
    updatedAt: '2026-07-24',
  },
  {
    id: 'field-note',
    name: 'メモ',
    defaultValue: '',
    displayOrder: 1,
    isActive: true,
    createdAt: '2026-07-24',
    updatedAt: '2026-07-24',
  },
]

function Harness({ initial = [] }: { initial?: FormSubmitAction[] }) {
  const [actions, setActions] = useState(initial)
  return (
    <>
      <FriendActionsEditor
        actions={actions}
        onChange={setActions}
        tags={tags}
        fieldDefinitions={fieldDefinitions}
      />
      <output aria-label="現在のアクション">{JSON.stringify(actions)}</output>
    </>
  )
}

describe('FriendActionsEditor — P1共有アクション編集', () => {
  it('4種類を複数追加し、対象と値をordered stateへ反映する', () => {
    render(<Harness />)

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

    expect(screen.getByLabelText('現在のアクション').textContent).toBe(JSON.stringify([
      { type: 'add_tag', tagId: 'tag-vip' },
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
      { type: 'clear_field', fieldId: 'field-note' },
    ]))
  })

  it('保存済み配列を上下移動・削除して同じcontrolled stateを更新する', () => {
    render(<Harness initial={[
      { type: 'add_tag', tagId: 'tag-vip' },
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'clear_field', fieldId: 'field-note' },
    ]} />)

    fireEvent.click(screen.getByRole('button', { name: 'アクション 3を上へ移動' }))
    fireEvent.click(screen.getByRole('button', { name: 'アクション 1を削除' }))

    expect(screen.getByLabelText('現在のアクション').textContent).toBe(JSON.stringify([
      { type: 'clear_field', fieldId: 'field-note' },
      { type: 'remove_tag', tagId: 'tag-old' },
    ]))
  })
})
