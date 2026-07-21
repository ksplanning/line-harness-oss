// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AutoReplyDraft } from './edit-dialog'

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  packList: vi.fn(),
  packGet: vi.fn(),
  flexToModel: vi.fn(),
  builderProps: null as null | { initialModel?: unknown; onSave: (json: string) => void; onClose: () => void },
}))

vi.mock('@/lib/api', () => ({ api: {
  autoReplies: {
    create: (...args: unknown[]) => m.create(...args),
    update: (...args: unknown[]) => m.update(...args),
  },
  templatePacks: {
    list: (...args: unknown[]) => m.packList(...args),
    get: (...args: unknown[]) => m.packGet(...args),
  },
} }))
vi.mock('@/lib/flex-builder/from-flex', () => ({ flexToModel: (...args: unknown[]) => m.flexToModel(...args) }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({
  default: (props: { initialModel?: unknown; onSave: (json: string) => void; onClose: () => void }) => {
    m.builderProps = props
    return <div data-testid="flex-builder"><button onClick={() => props.onSave('{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}')}>Flexを保存</button></div>
  },
}))
vi.mock('@/components/shared/personalized-text-editor', () => ({
  default: ({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
vi.mock('@/components/shared/image-uploader', () => ({
  default: () => <div data-testid="image-uploader" />,
}))

import EditDialog from './edit-dialog'

type ResponseMessage = { messageType: 'text' | 'flex' | 'image'; messageContent: string }

function draft(overrides: Record<string, unknown> = {}): AutoReplyDraft {
  return {
    id: 'rule-1',
    keyword: '資料',
    matchType: 'exact',
    responseType: 'text',
    responseContent: '旧本文',
    templateId: null,
    lineAccountId: 'acc-1',
    isActive: true,
    ...overrides,
  } as unknown as AutoReplyDraft
}

const templates = [
  { id: 'tpl-1', name: '営業時間', messageType: 'text', messageContent: '10時からです' },
]

beforeEach(() => {
  vi.clearAllMocks()
  m.builderProps = null
  m.create.mockResolvedValue({ success: true, data: { id: 'rule-new' } })
  m.update.mockResolvedValue({ success: true, data: { id: 'rule-1' } })
  m.packList.mockResolvedValue({ success: true, data: [] })
  m.packGet.mockResolvedValue({ success: true, data: { items: [] } })
  m.flexToModel.mockReturnValue({ cards: [{ id: 'card-1' }] })
})

afterEach(() => cleanup())

describe('自動返信ルール編集 — 最大5吹き出し', () => {
  it('保存済み複数吹き出しを同じ順序で読み込み、APIへround-tripする', async () => {
    const responseMessages: ResponseMessage[] = [
      { messageType: 'text', messageContent: 'A' },
      { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      { messageType: 'text', messageContent: 'B' },
    ]
    render(<EditDialog draft={draft({ responseMessages })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.getByText('吹き出し 1')).toBeTruthy()
    expect(screen.getByText('吹き出し 2')).toBeTruthy()
    expect(screen.getByText('吹き出し 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages,
      responseType: 'text',
      responseContent: 'A',
    })))
  })

  it('5件では追加を無効化し、上限を画面で明示する', () => {
    const responseMessages: ResponseMessage[] = Array.from({ length: 5 }, (_, index) => ({
      messageType: 'text',
      messageContent: `${index + 1}`,
    }))
    render(<EditDialog draft={draft({ responseMessages })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.getByText('5 / 5 吹き出し')).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ 吹き出しを追加' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('自動返信ルール編集 — テンプレートパック展開', () => {
  it('パック全件を切り詰めず順序どおり吹き出し列へ展開して保存する', async () => {
    m.packList.mockResolvedValue({ success: true, data: [
      { id: 'pack-3', name: '3連案内', itemCount: 3 },
    ] })
    m.packGet.mockResolvedValue({ success: true, data: { items: [
      { message_type: 'text', message_content: 'A' },
      { message_type: 'flex', message_content: '{"type":"bubble"}' },
      { message_type: 'text', message_content: 'B' },
    ] } })
    render(<EditDialog draft={draft({ responseContent: '' })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    const packSelect = await screen.findByRole('combobox', { name: 'テンプレートパック' })
    fireEvent.change(packSelect, { target: { value: 'pack-3' } })
    fireEvent.click(screen.getByRole('button', { name: 'パックを展開' }))
    await waitFor(() => expect(screen.getByText('3 / 5 吹き出し')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages: [
        { messageType: 'text', messageContent: 'A' },
        { messageType: 'flex', messageContent: '{"type":"bubble"}' },
        { messageType: 'text', messageContent: 'B' },
      ],
    })))
  })

  it('6件パックは黙って切り詰めず最大5件エラーを表示する', async () => {
    m.packList.mockResolvedValue({ success: true, data: [
      { id: 'pack-6', name: '6連案内', itemCount: 6 },
    ] })
    m.packGet.mockResolvedValue({ success: true, data: { items: Array.from({ length: 6 }, (_, index) => ({
      message_type: 'text', message_content: `${index + 1}`,
    })) } })
    render(<EditDialog draft={draft({ responseContent: '' })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'テンプレートパック' }), { target: { value: 'pack-6' } })
    fireEvent.click(screen.getByRole('button', { name: 'パックを展開' }))

    expect((await screen.findByRole('alert')).textContent).toContain('最大5')
    expect(screen.getByText('1 / 5 吹き出し')).toBeTruthy()
  })

  it('パック読込中の手入力を古い状態で上書きしない', async () => {
    let resolvePack!: (value: { success: true; data: { items: Array<{ message_type: 'text'; message_content: string }> } }) => void
    m.packList.mockResolvedValue({ success: true, data: [
      { id: 'pack-1', name: '追加案内', itemCount: 1 },
    ] })
    m.packGet.mockReturnValue(new Promise((resolve) => { resolvePack = resolve }))
    render(<EditDialog draft={draft({ responseContent: '変更前' })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'テンプレートパック' }), { target: { value: 'pack-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'パックを展開' }))
    fireEvent.change(screen.getByRole('textbox', { name: '吹き出し 1 テキスト' }), { target: { value: '読込中に変更' } })
    resolvePack({ success: true, data: { items: [{ message_type: 'text', message_content: 'パック本文' }] } })

    await waitFor(() => expect(screen.getByText('2 / 5 吹き出し')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages: [
        { messageType: 'text', messageContent: '読込中に変更' },
        { messageType: 'text', messageContent: 'パック本文' },
      ],
    })))
  })

  it('全アカウント共通ルールでも画面で選択中のアカウントからパックを読める', async () => {
    m.packList.mockResolvedValue({ success: true, data: [
      { id: 'pack-global', name: '共通案内', itemCount: 1 },
    ] })
    m.packGet.mockResolvedValue({ success: true, data: { items: [
      { message_type: 'text', message_content: '共通パック本文' },
    ] } })
    render(<EditDialog draft={draft({ lineAccountId: null, responseContent: '' })} packAccountId="acc-selected" templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    await waitFor(() => expect(m.packList).toHaveBeenCalledWith('acc-selected'))
    fireEvent.change(screen.getByRole('combobox', { name: 'テンプレートパック' }), { target: { value: 'pack-global' } })
    fireEvent.click(screen.getByRole('button', { name: 'パックを展開' }))
    await waitFor(() => expect(m.packGet).toHaveBeenCalledWith('pack-global', 'acc-selected'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      lineAccountId: null,
      responseMessages: [{ messageType: 'text', messageContent: '共通パック本文' }],
    })))
  })
})

describe('自動返信ルール編集 — Flexビルダーと既存テンプレート', () => {
  it('生JSONを既定表示せず、既存Flexをビルダーで編集して保存値へ反映する', async () => {
    const current = '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}'
    render(<EditDialog draft={draft({
      responseType: 'flex',
      responseContent: current,
      responseMessages: [{ messageType: 'flex', messageContent: current }],
    })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.queryByRole('textbox', { name: 'Flex JSON' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'ビジュアルで編集' }))
    expect(m.flexToModel).toHaveBeenCalledWith(current)
    expect(m.builderProps?.initialModel).toEqual({ cards: [{ id: 'card-1' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Flexを保存' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages: [{
        messageType: 'flex',
        messageContent: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}',
      }],
    })))
  })

  it('上級者向けJSONは明示操作でだけ開く', () => {
    render(<EditDialog draft={draft({ responseType: 'flex', responseMessages: [{ messageType: 'flex', messageContent: '{}' }] })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    const toggle = screen.getByRole('button', { name: '上級者向け JSON' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Flex JSON' })).toBeTruthy()
  })

  it('既存の単一テンプレート参照は応答方法を戻してもresponseMessagesへ変換せず保持する', async () => {
    render(<EditDialog draft={draft({
      responseType: 'text', responseContent: '10時からです', templateId: 'tpl-1',
    })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '返信なし (silent)' }))
    fireEvent.click(screen.getByRole('button', { name: '吹き出しを送る' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      templateId: 'tpl-1',
      responseMessages: null,
      responseContent: '10時からです',
    })))
  })
})
