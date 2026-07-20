// @vitest-environment jsdom
/** flex-builder-silent-fail-fix — broadcast 側の作り直し導線と正常経路。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { buildModelToFlex } from '@/lib/flex-builder/to-flex'
import type { MessageBlock } from '@/lib/api'

vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => <div data-testid="flex-preview" /> }))
vi.mock('./broadcast-media-inputs', () => ({ default: () => null }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({
  default: ({ initialModel }: { initialModel?: unknown }) => (
    <div
      role="dialog"
      aria-label="Flexビジュアルビルダー"
      data-initial-model={initialModel ? 'existing' : 'empty'}
    />
  ),
}))

import MessageBlockEditor from './message-block-editor'

const oldText = '切替前のテキスト本文'
const rebuildPrompt = '今の本文はそのままではビジュアル編集できません。新しくビジュアルで作り直しますか？（今のテキストは破棄されます）'
const rebuildGuidance = '今の本文はそのままではビジュアル編集できません。本文を残す場合は、下の「上級者向け」で編集してください。'

afterEach(() => cleanup())

function renderEditor(content: string) {
  const onChange = vi.fn()
  const block: MessageBlock = { type: 'flex', content }
  render(<MessageBlockEditor block={block} onChange={onChange} linkableEvents={[]} />)
  return onChange
}

function renderTextThenSwitchToFlex(content: string) {
  const onChange = vi.fn()

  function Harness() {
    const [block, setBlock] = useState<MessageBlock>({ type: 'text', content })
    return (
      <MessageBlockEditor
        block={block}
        onChange={(next) => {
          onChange(next)
          setBlock(next)
        }}
        linkableEvents={[]}
      />
    )
  }

  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Flexメッセージ' }))
  expect(onChange).toHaveBeenLastCalledWith({ type: 'flex', content })
  return onChange
}

describe('broadcast Flex ビルダーの作り直し導線', () => {
  it('旧テキストでは確認を表示し、キャンセル後も本文を保持して既存の赤字案内を残す', async () => {
    const onChange = renderTextThenSwitchToFlex(oldText)

    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    expect(confirmation.textContent).toContain(rebuildPrompt)
    expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: '新しく作り直す' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Flexビジュアルビルダー' })).toBeNull()

    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))

    expect((await screen.findByRole('alert')).textContent).toBe(rebuildGuidance)
    const advanced = screen.getByPlaceholderText('{"type":"bubble","body":{...}}') as HTMLTextAreaElement
    expect(advanced.value).toBe(oldText)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Flexビジュアルビルダー' })).toBeNull()
  })

  it('明示的に作り直す時は本文を先に変更せず空のビルダーを開く', async () => {
    const onChange = renderTextThenSwitchToFlex(oldText)
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '新しく作り直す' }))

    expect((await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })).getAttribute('data-initial-model')).toBe('empty')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('Esc で確認をキャンセルし、起動ボタンへフォーカスを戻す', async () => {
    renderTextThenSwitchToFlex(oldText)
    const trigger = screen.getByRole('button', { name: /ビジュアルでカードを作る/ })
    fireEvent.click(trigger)
    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })

    fireEvent.keyDown(confirmation, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toBe(rebuildGuidance)
    expect(document.activeElement).toBe(trigger)
  })

  it('未処理の確認を種別切替後に持ち越さない', async () => {
    renderTextThenSwitchToFlex(oldText)
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))
    await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })

    fireEvent.click(screen.getByRole('button', { name: 'テキスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'Flexメッセージ' }))

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
  })

  it('キャンセル後の赤字案内と上級者欄を種別切替後に持ち越さない', async () => {
    renderTextThenSwitchToFlex(oldText)
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'テキスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'Flexメッセージ' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByPlaceholderText('{"type":"bubble","body":{...}}')).toBeNull()
  })
})

describe('broadcast Flex ビルダーの正常経路', () => {
  it('空本文は確認なしで空のビルダーを開く', async () => {
    const onChange = renderEditor('')
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
    expect((await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })).getAttribute('data-initial-model')).toBe('empty')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('有効な Flex JSON は確認なしで復元モデルを渡して開く', async () => {
    const validFlex = JSON.stringify(buildModelToFlex({
      cards: [{ id: 'card-1', parts: [{ kind: 'body', id: 'body-1', text: '有効なカード' }] }],
    }))
    const onChange = renderEditor(validFlex)

    fireEvent.click(screen.getByRole('button', { name: /カードを編集/ }))

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
    expect((await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })).getAttribute('data-initial-model')).toBe('existing')
    expect(onChange).not.toHaveBeenCalled()
  })
})
