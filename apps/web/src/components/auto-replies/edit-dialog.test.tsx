// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AutoReplyDraft } from './edit-dialog'

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  packList: vi.fn(),
  packGet: vi.fn(),
  tagsList: vi.fn(),
  fieldDefinitionsList: vi.fn(),
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
  tags: {
    list: (...args: unknown[]) => m.tagsList(...args),
  },
  friendFieldDefinitions: {
    list: (...args: unknown[]) => m.fieldDefinitionsList(...args),
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

type ResponseMessage = { messageType: 'text' | 'flex' | 'image' | 'video'; messageContent: string }

function draft(overrides: Record<string, unknown> = {}): AutoReplyDraft {
  return {
    id: 'rule-1',
    keyword: '資料',
    matchType: 'exact',
    responseType: 'text',
    responseContent: '旧本文',
    templateId: null,
    lineAccountId: 'acc-1',
    keepInUnresponded: false,
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
  m.tagsList.mockResolvedValue({ success: true, data: [
    { id: 'tag-vip', name: 'VIP', color: '#06C755', createdAt: '2026-07-24' },
    { id: 'tag-old', name: '旧会員', color: '#999999', createdAt: '2026-07-24' },
  ] })
  m.fieldDefinitionsList.mockResolvedValue({ success: true, data: [
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
  ] })
  m.flexToModel.mockReturnValue({ cards: [{ id: 'card-1' }] })
})

afterEach(() => cleanup())

describe('自動返信ルール編集 — 日本語ラベル', () => {
  it('キーワード入力を日本語ラベルで示す', () => {
    render(<EditDialog draft={draft()} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.getByRole('textbox', { name: 'キーワード' })).toBeTruthy()
  })

  it('Flex の技術名を日常語と括弧補足で示す', () => {
    render(<EditDialog draft={draft()} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'カード（Flex）' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Flexメッセージ' })).toBeNull()
  })

  it('キーワード未入力を日本語で案内する', async () => {
    render(<EditDialog draft={draft()} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'キーワード' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect((await screen.findByRole('alert')).textContent).toContain('キーワードを入力してください')
  })

  it('新規は未対応リストへ残さず、編集時のopt-inを説明つきチェックで保存する', async () => {
    const first = render(<EditDialog draft={draft({ id: undefined })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)
    const defaultCheckbox = screen.getByRole('checkbox', {
      name: '未対応リストに残す（スタッフの対応が必要な用件向け）',
    }) as HTMLInputElement
    expect(defaultCheckbox.checked).toBe(false)
    expect(screen.getByText('オンにすると、自動返信後もスタッフが確認できるよう未対応リストに残します。')).toBeTruthy()
    first.unmount()

    render(<EditDialog draft={draft({ keepInUnresponded: true })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)
    const optedInCheckbox = screen.getByRole('checkbox', {
      name: '未対応リストに残す（スタッフの対応が必要な用件向け）',
    }) as HTMLInputElement
    expect(optedInCheckbox.checked).toBe(true)
    fireEvent.click(optedInCheckbox)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      keepInUnresponded: false,
    })))
  })
})

describe('自動返信ルール編集 — 応答後アクション', () => {
  it('保存済みの複数アクションを同じ順序で表示し、APIへround-tripする', async () => {
    const replyActions = [
      { type: 'add_tag', tagId: 'tag-vip' },
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
      { type: 'clear_field', fieldId: 'field-note' },
    ] as const
    render(<EditDialog
      draft={draft({ replyActions })}
      templates={templates}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />)

    expect(await screen.findByText('応答後にやること')).toBeTruthy()
    expect(screen.getByLabelText('アクション 1の種類')).toHaveProperty('value', 'add_tag')
    expect(screen.getByLabelText('アクション 2の種類')).toHaveProperty('value', 'remove_tag')
    expect(screen.getByLabelText('アクション 3の値')).toHaveProperty('value', '済')
    expect(screen.getByLabelText('アクション 4の種類')).toHaveProperty('value', 'clear_field')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      replyActions,
    })))
  })
})

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

  it('メディア吹き出しを並べ替えても内部stateが元の吹き出しに追従し、UI専用keyは保存しない', async () => {
    const videoA = JSON.stringify({ originalContentUrl: 'https://example.com/a.mp4', previewImageUrl: 'https://example.com/a.jpg' })
    const videoB = JSON.stringify({ originalContentUrl: 'https://example.com/b.mp4', previewImageUrl: 'https://example.com/b.jpg' })
    render(<EditDialog draft={draft({ responseMessages: [
      { messageType: 'video', messageContent: videoA },
      { messageType: 'video', messageContent: videoB },
    ] })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect((screen.getAllByPlaceholderText('https://example.com/video.mp4') as HTMLInputElement[]).map((input) => input.value)).toEqual([
      'https://example.com/a.mp4',
      'https://example.com/b.mp4',
    ])
    fireEvent.click(screen.getByRole('button', { name: '吹き出し 1 を下へ' }))
    expect((screen.getAllByPlaceholderText('https://example.com/video.mp4') as HTMLInputElement[]).map((input) => input.value)).toEqual([
      'https://example.com/b.mp4',
      'https://example.com/a.mp4',
    ])

    fireEvent.change(screen.getAllByPlaceholderText('https://example.com/video.mp4')[0], { target: { value: 'https://example.com/b-edited.mp4' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages: [
        { messageType: 'video', messageContent: JSON.stringify({ originalContentUrl: 'https://example.com/b-edited.mp4', previewImageUrl: 'https://example.com/b.jpg' }) },
        { messageType: 'video', messageContent: videoA },
      ],
    })))
    const savedBody = m.update.mock.calls.at(-1)?.[1] as { responseMessages: Array<Record<string, unknown>> }
    expect(savedBody.responseMessages.every((message) => !('uiKey' in message))).toBe(true)
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

  it('動画・音声・スタンプ・画像分割・リッチビデオを型落ちさせず展開して保存する', async () => {
    const expanded = [
      { messageType: 'video', messageContent: '{"originalContentUrl":"https://example.com/video.mp4","previewImageUrl":"https://example.com/preview.png"}' },
      { messageType: 'audio', messageContent: '{"originalContentUrl":"https://example.com/audio.m4a","duration":60000}' },
      { messageType: 'sticker', messageContent: '{"packageId":"11537","stickerId":"52002734"}' },
      { messageType: 'imagemap', messageContent: '{"baseUrl":"https://example.com/imagemap","altText":"リッチメッセージ","baseSize":{"width":1040,"height":1040},"actions":[{"type":"uri","linkUri":"https://example.com/","area":{"x":0,"y":0,"width":1040,"height":1040}}]}' },
      { messageType: 'richvideo', messageContent: '{"baseUrl":"https://example.com/preview.png","altText":"動画メッセージ","baseSize":{"width":1040,"height":1040},"actions":[],"video":{"originalContentUrl":"https://example.com/video.mp4","previewImageUrl":"https://example.com/preview.png","area":{"x":0,"y":0,"width":1040,"height":1040}}}' },
    ] as const
    m.packList.mockResolvedValue({ success: true, data: [
      { id: 'pack-media', name: 'メディア5種', itemCount: expanded.length },
    ] })
    m.packGet.mockResolvedValue({ success: true, data: { items: expanded.map((message) => ({
      message_type: message.messageType,
      message_content: message.messageContent,
    })) } })
    render(<EditDialog draft={draft({ responseContent: '' })} templates={templates} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(await screen.findByRole('combobox', { name: 'テンプレートパック' }), { target: { value: 'pack-media' } })
    fireEvent.click(screen.getByRole('button', { name: 'パックを展開' }))
    await waitFor(() => expect(screen.getByText('5 / 5 吹き出し')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      responseMessages: expanded,
      responseType: 'video',
      responseContent: expanded[0].messageContent,
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

    fireEvent.click(screen.getByRole('button', { name: '返信なし（silent）' }))
    fireEvent.click(screen.getByRole('button', { name: '吹き出しを送る' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({
      templateId: 'tpl-1',
      responseMessages: null,
      responseContent: '10時からです',
    })))
  })
})
