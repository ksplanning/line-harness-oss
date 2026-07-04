// @vitest-environment jsdom
/**
 * fold-in fix (F2 batch4 G1 / T-C9 audience+案A/B内容 導線) — broadcast-form の A/B 紐付け selector が
 * 案 A/B を選び、create payload に abTestId + abVariant を載せる (browser-evaluator の secondary_finding_gap 解消)。
 * 純関数 test では表示層バグを検知できない教訓 (batch3 T-C8) ゆえ実レンダリングで assert。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { createMock, listPresetsMock, abListMock } = vi.hoisted(() => ({ createMock: vi.fn(), listPresetsMock: vi.fn(), abListMock: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: { create: (...a: unknown[]) => createMock(...a) },
    senderPresets: { list: (...a: unknown[]) => listPresetsMock(...a) },
    abTests: { list: (...a: unknown[]) => abListMock(...a) },
  },
  eventsApi: { listEvents: vi.fn(async () => ({ items: [] })) },
}))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/multi-account-dedup-section', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/pack-insert-selector', () => ({ default: () => null }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))

import BroadcastForm from './broadcast-form'

beforeEach(() => {
  createMock.mockResolvedValue({ success: true, data: { id: 'b1' } })
  listPresetsMock.mockResolvedValue({ success: true, data: [] })
  abListMock.mockResolvedValue({ success: true, data: [{ id: 'ab-1', name: '春A/B' }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderForm() { return render(<BroadcastForm tags={[]} onSuccess={vi.fn()} onCancel={vi.fn()} />) }

describe('broadcast-form A/B binding (T-C9 案A/B 導線)', () => {
  it('renders the A/B test selector when the account has tests', async () => {
    renderForm()
    await waitFor(() => expect(screen.getByLabelText('A/Bテストを選ぶ')).toBeTruthy())
    expect(screen.getByRole('option', { name: '春A/B' })).toBeTruthy()
  })

  it('creating a broadcast bound to a test sends abTestId + abVariant in the payload', async () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), { target: { value: '案A配信' } })
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: 'こんにちは' } })
    await waitFor(() => expect(screen.getByLabelText('A/Bテストを選ぶ')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('A/Bテストを選ぶ'), { target: { value: 'ab-1' } })
    // 案A radio が現れる → デフォルトで A が選択済。
    await waitFor(() => expect(screen.getByText('案A')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.abTestId).toBe('ab-1')
    expect(payload.abVariant).toBe('A')
  })

  it('choosing 案B sends abVariant=B', async () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), { target: { value: '案B配信' } })
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: 'やあ' } })
    await waitFor(() => expect(screen.getByLabelText('A/Bテストを選ぶ')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('A/Bテストを選ぶ'), { target: { value: 'ab-1' } })
    await waitFor(() => expect(screen.getByText('案B')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('案B'))
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.abVariant).toBe('B')
  })

  it('no A/B selected → payload abTestId/abVariant null (backward compatible)', async () => {
    renderForm()
    fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), { target: { value: '通常配信' } })
    fireEvent.change(screen.getByPlaceholderText('配信するメッセージを入力...'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.abTestId).toBeNull()
    expect(payload.abVariant).toBeNull()
  })
})
