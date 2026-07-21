// @vitest-environment jsdom
/**
 * T-C8 (component-level) — broadcast-form の種別切替 UI・種別別入力・送信者 dropdown・client 検証・
 * 保存 payload を実レンダリングで assert する (純関数テストだけでは表示層バグを検知できない教訓)。
 *
 *  - 全 8 種別ラベルが選択肢として出る (動画/音声/スタンプ/リッチメッセージ/リッチビデオ含む)
 *  - 種別を切替えると種別別の入力欄が表示切替する (text textarea → video URL 入力)
 *  - 送信者は account プリセットからの dropdown のみ (任意の名前/URL 自由入力欄が無い)・既定は「既定の送信者」
 *  - client 検証 (非 https URL) で保存がブロックされ create が呼ばれない
 *  - 正常入力で api.broadcasts.create が messageType=video + senderPresetId 付きで呼ばれ、send は呼ばない
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { createMock, listPresetsMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  listPresetsMock: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: { create: (...a: unknown[]) => createMock(...a) },
    senderPresets: { list: (...a: unknown[]) => listPresetsMock(...a) },
    abTests: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
  eventsApi: { listEvents: vi.fn(async () => ({ items: [] })) },
}))
// 重い子コンポーネントは stub 化 (broadcast-form 本体のロジックに集中)。
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/multi-account-dedup-section', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/pack-insert-selector', () => ({ default: () => null }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))

import BroadcastForm from './broadcast-form'

beforeEach(() => {
  createMock.mockReset()
  listPresetsMock.mockReset()
  listPresetsMock.mockResolvedValue({ success: true, data: [{ id: 'sp-1', accountId: 'acc-1', name: '担当A', iconUrl: null, createdAt: '2026-07-04T00:00:00.000' }] })
  createMock.mockResolvedValue({ success: true, data: { id: 'b1' } })
})
afterEach(() => cleanup())

function renderForm() {
  return render(<BroadcastForm tags={[]} onSuccess={vi.fn()} onCancel={vi.fn()} />)
}

describe('T-C8 broadcast-form: 種別選択 + 送信者 dropdown', () => {
  it('全 8 種別ラベルが選べる (新 type 含む)', () => {
    renderForm()
    for (const label of ['テキスト', '画像', 'Flexメッセージ', '動画', '音声', 'スタンプ', 'リッチメッセージ (画像分割)', 'リッチビデオ']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('送信者は dropdown のみ (既定=「既定の送信者」・任意入力欄が無い)', () => {
    renderForm()
    // dropdown の既定オプション。
    expect(screen.getByText('既定の送信者')).toBeTruthy()
    // 送信者名/URL を自由入力する text 欄が存在しない (なりすまし防止の UI 核)。
    expect(screen.queryByPlaceholderText(/送信者.*名前|送信者名|sender/i)).toBeNull()
  })

  it('種別を「動画」に切替えると text 入力が消え動画 URL 入力が出る', () => {
    renderForm()
    // 既定 text: 動画 URL 入力はまだ無い。
    expect(screen.queryByPlaceholderText('https://example.com/video.mp4')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '動画' }))
    // 動画の入力欄が表示切替で出る。
    expect(screen.getByPlaceholderText('https://example.com/video.mp4')).toBeTruthy()
  })
})

describe('T-C8 broadcast-form: client 検証 + 保存 payload', () => {
  it('非 https の動画 URL は client 検証でブロックされ create が呼ばれない', async () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), { target: { value: 'テスト配信' } })
    fireEvent.click(screen.getByRole('button', { name: '動画' }))
    fireEvent.change(screen.getByPlaceholderText('https://example.com/video.mp4'), { target: { value: 'http://x/v.mp4' } })
    fireEvent.change(screen.getByPlaceholderText('または画像URLを直接入力 (https://...)'), { target: { value: 'https://x/p.png' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(screen.getByText(/https で入力/)).toBeTruthy())
    expect(createMock).not.toHaveBeenCalled()
  })

  it('正常入力で create が messageType=video + senderPresetId 付きで呼ばれる (send は呼ばない)', async () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), { target: { value: '動画配信' } })
    fireEvent.click(screen.getByRole('button', { name: '動画' }))
    fireEvent.change(screen.getByPlaceholderText('https://example.com/video.mp4'), { target: { value: 'https://x/v.mp4' } })
    fireEvent.change(screen.getByPlaceholderText('または画像URLを直接入力 (https://...)'), { target: { value: 'https://x/p.png' } })
    // 送信者プリセットが読み込まれるのを待って選択する。
    await waitFor(() => expect(screen.getByRole('option', { name: '担当A' })).toBeTruthy())
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sp-1' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.messageType).toBe('video')
    expect(payload.senderPresetId).toBe('sp-1')
    expect(String(payload.messageContent)).toContain('https://x/v.mp4')
    // broadcast-form は api.broadcasts.create のみ呼ぶ (send は構造的に呼ばない = 保存で送信しない)。
    expect(payload.status).toBe('draft')
  })
})
