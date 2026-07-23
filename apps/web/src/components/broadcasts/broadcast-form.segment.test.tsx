// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}))
const account = vi.hoisted(() => ({
  selectedAccountId: 'acc-1',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: account.selectedAccountId,
    selectedAccount: {
      id: account.selectedAccountId,
      stats: { friendCount: 10 },
    },
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: { create: (...args: unknown[]) => createMock(...args) },
    abTests: { list: vi.fn(async () => ({ success: true, data: [] })) },
    segments: { count: vi.fn(async () => ({ success: true, count: 3 })) },
  },
  eventsApi: { listEvents: vi.fn(async () => ({ items: [] })) },
}))

vi.mock('./message-block-editor', () => ({
  default: ({
    block,
    onChange,
  }: {
    block: { type: string; content: string }
    onChange: (block: { type: 'text'; content: string }) => void
  }) => (
    <textarea
      aria-label="本文"
      value={block.content}
      onChange={(event) => onChange({ type: 'text', content: event.target.value })}
    />
  ),
}))

vi.mock('./segment-builder', () => ({
  default: ({
    onApply,
    onDirty,
  }: {
    onApply: (conditions: unknown) => void
    onDirty?: () => void
  }) => (
    <>
      <button
        type="button"
        onClick={() => onApply({
          operator: 'AND',
          rules: [
            { type: 'tag_not_exists', value: 'tag-vip' },
            { type: 'metadata_empty', value: { key: '会員ランク' } },
          ],
        })}
      >
        __apply_detail_conditions__
      </button>
      <button type="button" onClick={onDirty}>
        __edit_without_apply__
      </button>
    </>
  ),
}))

vi.mock('./sender-select', () => ({ default: () => null }))
vi.mock('./pack-insert-selector', () => ({ default: () => null }))
vi.mock('@/components/shared/test-send-dialog', () => ({ default: () => null }))
vi.mock('@/components/shared/line-quota-display', () => ({ LineQuotaAudienceStatus: () => null }))

import BroadcastForm from './broadcast-form'

const tags = [{ id: 'tag-vip', name: 'VIP' } as never]

beforeEach(() => {
  account.selectedAccountId = 'acc-1'
  createMock.mockReset()
  createMock.mockResolvedValue({ success: true, data: { id: 'broadcast-1' } })
})

afterEach(() => cleanup())

function renderForm() {
  const view = render(<BroadcastForm tags={tags} onSuccess={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByPlaceholderText('例: 3月のキャンペーン告知'), {
    target: { value: '条件つき配信' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: '本文' }), {
    target: { value: 'お知らせです' },
  })
  return view
}

async function saveAndGetPayload(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: '作成' }))
  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
  return createMock.mock.calls[0][0] as Record<string, unknown>
}

describe('BroadcastForm segment target', () => {
  it('embeds SegmentBuilder and saves its canonical object as targetType=segment', async () => {
    renderForm()
    fireEvent.click(screen.getByRole('button', { name: '詳細条件' }))
    fireEvent.click(screen.getByRole('button', { name: '__apply_detail_conditions__' }))

    const payload = await saveAndGetPayload()
    expect(payload.targetType).toBe('segment')
    expect(payload.targetTagId).toBeNull()
    expect(payload.segmentConditions).toEqual({
      operator: 'AND',
      rules: [
        { type: 'tag_not_exists', value: 'tag-vip' },
        { type: 'metadata_empty', value: { key: '会員ランク' } },
      ],
    })
  })

  it('requires re-applying conditions after an edit so the shown count cannot diverge from the saved audience', async () => {
    renderForm()
    fireEvent.click(screen.getByRole('button', { name: '詳細条件' }))
    fireEvent.click(screen.getByRole('button', { name: '__apply_detail_conditions__' }))
    fireEvent.click(screen.getByRole('button', { name: '__edit_without_apply__' }))
    fireEvent.click(screen.getByRole('button', { name: '作成' }))

    expect(await screen.findByText('詳細条件を設定して「適用」を押してください')).toBeTruthy()
    expect(createMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '__apply_detail_conditions__' }))
    await saveAndGetPayload()
  })

  it('独自の配信先アカウント選択を出さず、all/tag を選択中アカウントへ固定する', async () => {
    renderForm()
    expect(screen.queryByRole('button', { name: '複数アカ重複除外' })).toBeNull()
    expect(screen.queryByText('配信先アカウント')).toBeNull()

    let payload = await saveAndGetPayload()
    expect(payload.targetType).toBe('all')
    expect(payload.lineAccountId).toBe('acc-1')
    expect(payload).not.toHaveProperty('accountIds')
    expect(payload).not.toHaveProperty('dedupPriority')
    expect(payload).not.toHaveProperty('segmentConditions')

    cleanup()
    createMock.mockClear()
    renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tag-vip' } })
    payload = await saveAndGetPayload()
    expect(payload.targetType).toBe('tag')
    expect(payload.targetTagId).toBe('tag-vip')
    expect(payload.lineAccountId).toBe('acc-1')
    expect(payload).not.toHaveProperty('accountIds')
    expect(payload).not.toHaveProperty('dedupPriority')
    expect(payload).not.toHaveProperty('segmentConditions')

    cleanup()
    createMock.mockClear()
    const view = renderForm()
    account.selectedAccountId = 'acc-2'
    view.rerender(<BroadcastForm tags={tags} onSuccess={vi.fn()} onCancel={vi.fn()} />)
    payload = await saveAndGetPayload()
    expect(payload.lineAccountId).toBe('acc-2')
    expect(payload).not.toHaveProperty('accountIds')
    expect(payload).not.toHaveProperty('dedupPriority')
  })
})
