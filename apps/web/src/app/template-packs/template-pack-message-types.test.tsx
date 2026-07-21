// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ success: true, data: {} })),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-pack' }) }))
vi.mock('@/components/layout/header', () => ({
  default: ({ title, action }: { title: string; action?: React.ReactNode }) => <header><h1>{title}</h1>{action}</header>,
}))
vi.mock('@/components/shared/personalized-text-editor', () => ({
  default: ({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({
  default: ({ onSave }: { onSave: (json: string) => void }) => (
    <button
      type="button"
      aria-label="Flex fixtureを保存"
      onClick={() => onSave('{\n  "type": "bubble",\n  "body": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "fixture" }] }\n}')}
    >
      Flex fixtureを保存
    </button>
  ),
}))
vi.mock('@/components/shared/image-uploader', () => ({
  default: ({ onChange }: { onChange: (value: { mode: 'line-image'; originalContentUrl: string; previewImageUrl: string }) => void }) => (
    <button
      type="button"
      aria-label="画像fixtureを設定"
      onClick={() => onChange({
        mode: 'line-image',
        originalContentUrl: 'https://example.com/original.png',
        previewImageUrl: 'https://example.com/preview.png',
      })}
    >
      画像fixtureを設定
    </button>
  ),
}))

const mediaFixtures = {
  video: '{"originalContentUrl":"https://example.com/video.mp4","previewImageUrl":"https://example.com/preview.png"}',
  audio: '{"originalContentUrl":"https://example.com/audio.m4a","duration":60000}',
  imagemap: '{"baseUrl":"https://example.com/imagemap","altText":"map","baseSize":{"width":1040,"height":1040},"actions":[{"type":"uri","linkUri":"https://example.com/","area":{"x":0,"y":0,"width":1040,"height":1040}}]}',
  richvideo: '{"baseUrl":"https://example.com/preview.png","altText":"video","baseSize":{"width":1040,"height":1040},"actions":[],"video":{"originalContentUrl":"https://example.com/video.mp4","previewImageUrl":"https://example.com/preview.png","area":{"x":0,"y":0,"width":1040,"height":1040}}}',
} as const

vi.mock('@/components/broadcasts/broadcast-media-inputs', () => ({
  default: ({ messageType, onChange }: { messageType: keyof typeof mediaFixtures; onChange: (json: string) => void }) => (
    <button type="button" aria-label={`${messageType} fixtureを設定`} onClick={() => onChange(mediaFixtures[messageType])}>
      {messageType} fixtureを設定
    </button>
  ),
}))
vi.mock('@/components/shared/test-send-dialog', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    templatePacks: {
      list: vi.fn(async () => ({ success: true, data: [] })),
      get: vi.fn(),
      create: mocks.create,
      update: vi.fn(async () => ({ success: true, data: {} })),
      remove: vi.fn(),
    },
    friendFieldDefinitions: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
}))

import TemplatePacksPage from './page'

afterEach(() => {
  cleanup()
  mocks.create.mockClear()
})

describe('テンプレパックのメッセージ種別', () => {
  it('共通送信レンダラの8種を選択・編集し、順序と本文をそのまま保存する', async () => {
    render(<TemplatePacksPage />)
    fireEvent.click(await screen.findByRole('button', { name: /最初のパックを作る/ }))

    fireEvent.change(screen.getByPlaceholderText('例: 初回あいさつセット'), { target: { value: '8種セット' } })

    fireEvent.click(screen.getByRole('button', { name: /テキスト吹き出しを追加/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'テンプレパックのテキスト内容' }), {
      target: { value: 'legacy text\ntrailing spaces  ' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Flex吹き出しを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Flex fixtureを保存' }))

    fireEvent.click(screen.getByRole('button', { name: /画像吹き出しを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: '画像fixtureを設定' }))

    for (const type of ['video', 'audio'] as const) {
      const label = type === 'video' ? '動画' : '音声'
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${label}吹き出しを追加`) }))
      fireEvent.click(screen.getByRole('button', { name: `${type} fixtureを設定` }))
    }

    fireEvent.click(screen.getByRole('button', { name: /スタンプ吹き出しを追加/ }))
    fireEvent.change(screen.getByPlaceholderText('例: 446'), { target: { value: '11537' } })
    fireEvent.change(screen.getByPlaceholderText('例: 1988'), { target: { value: '52002734' } })

    fireEvent.click(screen.getByRole('button', { name: /リッチメッセージ \(画像分割\)吹き出しを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: 'imagemap fixtureを設定' }))

    fireEvent.click(screen.getByRole('button', { name: /リッチビデオ吹き出しを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: 'richvideo fixtureを設定' }))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create).toHaveBeenCalledWith('acc-pack', {
      name: '8種セット',
      items: [
        { messageType: 'text', messageContent: 'legacy text\ntrailing spaces  ' },
        { messageType: 'flex', messageContent: '{\n  "type": "bubble",\n  "body": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "fixture" }] }\n}' },
        { messageType: 'image', messageContent: '{"originalContentUrl":"https://example.com/original.png","previewImageUrl":"https://example.com/preview.png"}' },
        { messageType: 'video', messageContent: mediaFixtures.video },
        { messageType: 'audio', messageContent: mediaFixtures.audio },
        { messageType: 'sticker', messageContent: '{"packageId":"11537","stickerId":"52002734"}' },
        { messageType: 'imagemap', messageContent: mediaFixtures.imagemap },
        { messageType: 'richvideo', messageContent: mediaFixtures.richvideo },
      ],
    })
  })
})
