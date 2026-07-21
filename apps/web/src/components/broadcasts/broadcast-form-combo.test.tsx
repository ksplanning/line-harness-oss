// @vitest-environment jsdom
/**
 * U4 (broadcast-combo-messages Batch 2) — broadcast-form の複数メッセージ・ブロック。
 *  - 画像ブロック + テキストブロックの2連 → create が messages(len2) + 先頭ミラーで呼ばれる
 *  - 上下ボタンで並べ替えると messages の順序が変わる
 *  - 6ブロック目は追加できない (最大5)
 *  - 単一ブロックは従来 single と等価な payload (messages len1 + 先頭ミラー)
 *  - create は呼ぶが send は呼ばない
 *  - PackInsertSelector の onAppend でパックのブロックがまとめて追加される
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { FormBubblePatch } from '@/lib/template-packs/pack-insert'

const { createMock, sendMock } = vi.hoisted(() => ({ createMock: vi.fn(), sendMock: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: { create: (...a: unknown[]) => createMock(...a), send: (...a: unknown[]) => sendMock(...a) },
    senderPresets: { list: vi.fn(async () => ({ success: true, data: [] })) },
    abTests: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
  eventsApi: { listEvents: vi.fn(async () => ({ items: [] })) },
}))
// 画像アップローダは onChange を叩けるスタブに (jsdom で画像 content を設定できるように)。
vi.mock('@/components/shared/image-uploader', () => ({
  default: ({ onChange }: { onChange: (v: { mode: 'line-image'; originalContentUrl: string; previewImageUrl: string }) => void }) => (
    <button type="button" onClick={() => onChange({ mode: 'line-image', originalContentUrl: 'https://img/original.png', previewImageUrl: 'https://img/preview.png' })}>
      __set_image__
    </button>
  ),
}))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
// This focused form contract does not need the built @line-crm/shared package;
// keep the isolated RED about image URLs instead of failing module resolution.
vi.mock('@/lib/flex-builder/validate', () => ({ validateFlex: () => ({ ok: true, errors: [] }) }))
vi.mock('@/lib/flex-builder/from-flex', () => ({ flexToModel: () => null }))
vi.mock('@/lib/flex-builder/image-link', () => ({ imageLinkToFlexJson: () => '' }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/multi-account-dedup-section', () => ({ default: () => null }))
// PackInsertSelector は onAppend を叩けるスタブに (append 配線 + remainingSlots を検証)。
vi.mock('@/components/broadcasts/pack-insert-selector', () => ({
  default: ({ onAppend, remainingSlots }: { onAppend: (p: FormBubblePatch[]) => void; remainingSlots: number }) => (
    <button
      type="button"
      data-remaining={remainingSlots}
      onClick={() => onAppend([
        { messageType: 'text', messageContent: 'パック1' },
        { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      ])}
    >
      __append_pack__
    </button>
  ),
}))
vi.mock('@/components/shared/test-send-dialog', () => ({
  default: ({ accountIds, source, messages, disabled }: {
    accountIds: string[]
    source: string
    messages: Array<{ type: string; content: string }>
    disabled?: boolean
  }) => (
    <button
      type="button"
      disabled={disabled}
      data-testid="draft-test-send"
      data-account-ids={accountIds.join(',')}
      data-source={source}
      data-messages={JSON.stringify(messages)}
    >
      下書きをテスト送信
    </button>
  ),
}))

import BroadcastForm from './broadcast-form'

beforeEach(() => {
  createMock.mockReset(); sendMock.mockReset()
  createMock.mockResolvedValue({ success: true, data: { id: 'b1' } })
})
afterEach(() => cleanup())

function renderForm() { return render(<BroadcastForm tags={[]} onSuccess={vi.fn()} onCancel={vi.fn()} />) }
const title = () => screen.getByPlaceholderText('例: 3月のキャンペーン告知')

describe('U4 broadcast-form: 複数メッセージ・ブロック', () => {
  it('画像ブロック + テキストブロックの2連 → create が messages(len2) + 先頭ミラーで呼ばれ、send は呼ばない', async () => {
    renderForm()
    fireEvent.change(title(), { target: { value: '組み合わせ配信' } })
    // block0 を画像に切替 → アップローダ stub で content 設定
    fireEvent.click(screen.getByRole('button', { name: '画像' }))
    fireEvent.click(screen.getByRole('button', { name: '__set_image__' }))
    // block1 (text) を追加して本文入力
    fireEvent.click(screen.getByRole('button', { name: /メッセージを追加/ }))
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: 'テキスト2' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    const messages = payload.messages as Array<{ type: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('image')
    expect(JSON.parse(messages[0].content)).toEqual({
      originalContentUrl: 'https://img/original.png',
      previewImageUrl: 'https://img/preview.png',
    })
    expect(messages[1]).toEqual({ type: 'text', content: 'テキスト2' })
    // 先頭ミラー: messageType/messageContent は messages[0] と一致
    expect(payload.messageType).toBe('image')
    expect(payload.messageContent).toBe(messages[0].content)
    // send は構造的に呼ばない (保存で送信しない)
    expect(sendMock).not.toHaveBeenCalled()
    expect(payload.status).toBe('draft')
  })

  it('上下ボタンで並べ替えると messages の順序が変わる', async () => {
    renderForm()
    fireEvent.change(title(), { target: { value: '並べ替え' } })
    fireEvent.click(screen.getByRole('button', { name: /メッセージを追加/ }))
    const areas = screen.getAllByPlaceholderText('配信するメッセージを入力...')
    fireEvent.change(areas[0], { target: { value: 'A' } })
    fireEvent.change(areas[1], { target: { value: 'B' } })
    // 1通目を下へ → 順序が B, A に
    fireEvent.click(screen.getByRole('button', { name: '1通目を下へ' }))
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const messages = (createMock.mock.calls[0][0] as Record<string, unknown>).messages as Array<{ content: string }>
    expect(messages.map((m) => m.content)).toEqual(['B', 'A'])
  })

  it('6ブロック目は追加できない (最大5)', () => {
    renderForm()
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: /メッセージを追加/ }))
    const addBtn = screen.getByRole('button', { name: /メッセージを追加/ }) as HTMLButtonElement
    expect(screen.getByText(/メッセージ（5 \/ 5 通）/)).toBeTruthy()
    expect(addBtn.disabled).toBe(true)
    fireEvent.click(addBtn)
    // 依然 5 通 (6通目は入らない)
    expect(screen.getByText(/メッセージ（5 \/ 5 通）/)).toBeTruthy()
  })

  it('単一ブロックは従来 single と等価な payload (messages len1 + 先頭ミラー)', async () => {
    renderForm()
    fireEvent.change(title(), { target: { value: '単発' } })
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: 'こんにちは' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.messages).toEqual([{ type: 'text', content: 'こんにちは' }])
    expect(payload.messageType).toBe('text')
    expect(payload.messageContent).toBe('こんにちは')
  })

  it('PackInsertSelector の onAppend でパックのブロックがまとめて追加される (remainingSlots 連携)', () => {
    renderForm()
    // 既定 1 ブロック → 残枠4
    expect(screen.getByRole('button', { name: '__append_pack__' }).getAttribute('data-remaining')).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: '__append_pack__' }))
    // 1 + 2 = 3 通
    expect(screen.getByText(/メッセージ（3 \/ 5 通）/)).toBeTruthy()
  })

  it('保存前の組み合わせ内容を選択中アカウントのテスト送信へ渡す', () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: '一通目' } })
    fireEvent.click(screen.getByRole('button', { name: /メッセージを追加/ }))
    const areas = screen.getAllByPlaceholderText('配信するメッセージを入力...')
    fireEvent.change(areas[1], { target: { value: '二通目' } })

    const button = screen.getByTestId('draft-test-send')
    expect(button.getAttribute('data-account-ids')).toBe('acc-1')
    expect(button.getAttribute('data-source')).toBe('broadcast')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '一通目' },
      { type: 'text', content: '二通目' },
    ])
  })
})
