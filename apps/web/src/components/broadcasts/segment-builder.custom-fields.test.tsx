// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const {
  countMock,
  fieldDefinitionsMock,
  linksMock,
  menusMock,
  formsMock,
} = vi.hoisted(() => ({
  countMock: vi.fn(),
  fieldDefinitionsMock: vi.fn(),
  linksMock: vi.fn(),
  menusMock: vi.fn(),
  formsMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    segments: { count: (...args: unknown[]) => countMock(...args) },
    friendFieldDefinitions: { list: (...args: unknown[]) => fieldDefinitionsMock(...args) },
    trackedLinks: { list: (...args: unknown[]) => linksMock(...args) },
    richMenuGroups: { list: (...args: unknown[]) => menusMock(...args) },
    forms: { list: (...args: unknown[]) => formsMock(...args) },
  },
}))

import SegmentBuilder from './segment-builder'

const activeDefinition = {
  id: 'field-rank',
  name: '会員ランク',
  defaultValue: '',
  displayOrder: 2,
  isActive: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

beforeEach(() => {
  countMock.mockResolvedValue({ success: true, count: 2 })
  fieldDefinitionsMock.mockResolvedValue({
    success: true,
    data: [
      { ...activeDefinition, id: 'field-inactive', name: '無効な項目', isActive: false, displayOrder: 1 },
      activeDefinition,
    ],
  })
  linksMock.mockResolvedValue({ success: true, data: [] })
  menusMock.mockResolvedValue({ success: true, data: [] })
  formsMock.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBuilder(onApply = vi.fn(), followingOnly = false) {
  render(
    <SegmentBuilder
      tags={[{ id: 'tag-vip', name: 'VIP' } as never]}
      accountId="acc-1"
      onApply={onApply}
      onCancel={vi.fn()}
      followingOnly={followingOnly}
    />,
  )
  return onApply
}

function ruleTypeSelect(index = 0): HTMLSelectElement {
  return screen.getAllByRole('combobox', { name: '条件の種類' })[index] as HTMLSelectElement
}

describe('SegmentBuilder custom-field conditions', () => {
  it('does not apply an incomplete rule', () => {
    const onApply = renderBuilder()
    const apply = screen.getByRole('button', { name: '適用' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('requests the broadcast following-only count when used by the composer', async () => {
    renderBuilder(vi.fn(), true)
    fireEvent.change(screen.getByRole('combobox', { name: 'タグ' }), {
      target: { value: 'tag-vip' },
    })
    await waitFor(() => expect(countMock).toHaveBeenCalledWith(
      {
        operator: 'AND',
        rules: [{ type: 'tag_exists', value: 'tag-vip' }],
      },
      'acc-1',
      { followingOnly: true },
    ))
  })

  it('uses active friend-field definitions as choices instead of accepting a free key', async () => {
    renderBuilder()
    fireEvent.change(ruleTypeSelect(), { target: { value: 'metadata_equals' } })

    const fieldSelect = await screen.findByRole('combobox', { name: 'カスタムフィールド' })
    expect(within(fieldSelect).getByRole('option', { name: '会員ランク' })).toBeTruthy()
    expect(within(fieldSelect).queryByRole('option', { name: '無効な項目' })).toBeNull()
    expect(screen.queryByPlaceholderText('key')).toBeNull()
    expect(fieldDefinitionsMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['metadata_equals', true, { key: '会員ランク', value: 'gold' }],
    ['metadata_not_equals', true, { key: '会員ランク', value: 'gold' }],
    ['metadata_empty', false, { key: '会員ランク' }],
    ['metadata_not_empty', false, { key: '会員ランク' }],
  ] as const)('applies %s with the canonical value shape', async (type, needsValue, expectedValue) => {
    const onApply = renderBuilder()
    fireEvent.change(ruleTypeSelect(), { target: { value: type } })

    const fieldSelect = await screen.findByRole('combobox', { name: 'カスタムフィールド' })
    fireEvent.change(fieldSelect, { target: { value: '会員ランク' } })

    const valueInput = screen.queryByRole('textbox', { name: '値' })
    if (needsValue) {
      expect(valueInput).toBeTruthy()
      fireEvent.change(valueInput!, { target: { value: 'gold' } })
    } else {
      expect(valueInput).toBeNull()
    }

    fireEvent.click(screen.getByRole('button', { name: '適用' }))
    expect(onApply).toHaveBeenCalledWith({
      operator: 'AND',
      rules: [{ type, value: expectedValue }],
    })
  })

  it('keeps tag-not-exists and custom-field-not-empty as an AND composite', async () => {
    const onApply = renderBuilder()
    fireEvent.change(ruleTypeSelect(), { target: { value: 'tag_not_exists' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'タグ' }), { target: { value: 'tag-vip' } })

    fireEvent.click(screen.getByRole('button', { name: 'ルール追加' }))
    await waitFor(() => expect(screen.getAllByRole('combobox', { name: '条件の種類' })).toHaveLength(2))
    fireEvent.change(ruleTypeSelect(1), { target: { value: 'metadata_not_empty' } })
    const fieldSelects = await screen.findAllByRole('combobox', { name: 'カスタムフィールド' })
    fireEvent.change(fieldSelects[0], { target: { value: '会員ランク' } })

    fireEvent.click(screen.getByRole('button', { name: '適用' }))
    expect(onApply).toHaveBeenCalledWith({
      operator: 'AND',
      rules: [
        { type: 'tag_not_exists', value: 'tag-vip' },
        { type: 'metadata_not_empty', value: { key: '会員ランク' } },
      ],
    })
  })
})
