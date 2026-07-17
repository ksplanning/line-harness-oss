// @vitest-environment jsdom
/**
 * form-post-edit (弾M / T-D2) — 回答詳細の編集モード (①管理者編集)。
 *   - allow_post_edit=1 → 「編集」ボタン表示 → 入力欄で直し保存すると editRow が呼ばれる。
 *   - allow_post_edit=0 → 編集ボタンが出ない。
 *   - 必須項目を空にすると保存が止まる (editRow を呼ばない)。
 *   - ④最終編集者・日時が表示される。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: null }
const getMock = vi.fn()
const rowsMock = vi.fn()
const rowMock = vi.fn()
const editRowMock = vi.fn()
const statsMock = vi.fn()
const listFiltersMock = vi.fn()
const fetchApiMock = vi.fn()

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
// DataCockpit をモックし、onOpenRow を発火する行ボタンを露出 (detail modal を開く経路)。
vi.mock('@/components/forms-advanced/data-cockpit', () => ({
  default: ({ onOpenRow }: { onOpenRow: (id: string) => void }) => (
    <button data-testid="open-row" onClick={() => onOpenRow('row1')}>open</button>
  ),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/download', () => ({ csvDateStamp: () => 'd', safeFilenamePart: (s: string) => s }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: { get: (...a: unknown[]) => getMock(...a) },
  formalooDataApi: {
    rows: (...a: unknown[]) => rowsMock(...a),
    row: (...a: unknown[]) => rowMock(...a),
    editRow: (...a: unknown[]) => editRowMock(...a),
    stats: (...a: unknown[]) => statsMock(...a),
    listFilters: (...a: unknown[]) => listFiltersMock(...a),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import DataCockpitClient from './data-cockpit-client'

const FIELDS = [
  { slug: 'nameSlug', label: '名前', type: 'text', required: true, editable: true },
  { slug: 'noteSlug', label: 'メモ', type: 'textarea', required: false, editable: true },
  { slug: 'pickSlug', label: '選択', type: 'choice', required: false, editable: false },
]
function detailFor(allowPostEdit: number, lastEdit: { editorStaffId: string | null; editorName: string | null; editedAt: string } | null = null) {
  return {
    id: 'row1', source: 'mirror', submittedAt: '2026-07-17T00:00:00+09:00',
    answers: { nameSlug: '田中', noteSlug: '旧メモ', pickSlug: 'A' },
    allowPostEdit, fields: FIELDS, lastEdit,
  }
}

beforeEach(() => {
  getMock.mockReset(); rowsMock.mockReset(); rowMock.mockReset(); editRowMock.mockReset()
  statsMock.mockReset(); listFiltersMock.mockReset(); fetchApiMock.mockReset()
  mockAccount.selectedAccountId = null
  getMock.mockResolvedValue({ id: 'fa1', title: 'F', lineAccountId: null })
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 0, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
})
afterEach(() => cleanup())

async function openDetail() {
  render(<DataCockpitClient id="fa1" />)
  await waitFor(() => expect(screen.getByTestId('open-row')).toBeTruthy())
  fireEvent.click(screen.getByTestId('open-row'))
  await waitFor(() => expect(screen.getByText('回答の詳細')).toBeTruthy())
}

describe('T-D2 回答詳細 編集モード', () => {
  it('allow_post_edit=1 → 編集ボタン表示 → 直して保存すると editRow が呼ばれる', async () => {
    rowMock.mockResolvedValue(detailFor(1))
    editRowMock.mockResolvedValue({ id: 'row1', source: 'formaloo', submittedAt: '2026-07-17T00:00:00+09:00', answers: { nameSlug: '山田', noteSlug: '旧メモ', pickSlug: 'A' }, lastEdit: { editorStaffId: 'env-owner', editorName: 'Owner', editedAt: '2026-07-17T03:00:00+09:00' } })
    await openDetail()

    fireEvent.click(screen.getByTestId('edit-answer'))
    const input = screen.getByTestId('edit-input-nameSlug') as HTMLInputElement
    expect(input.value).toBe('田中') // 現在値が載る
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.click(screen.getByTestId('edit-save'))

    await waitFor(() => expect(editRowMock).toHaveBeenCalledWith('fa1', 'row1', expect.objectContaining({ nameSlug: '山田' })))
    // 選択式 (pickSlug) は編集入力欄が出ない (free-value でない)
    expect(screen.queryByTestId('edit-input-pickSlug')).toBeNull()
  })

  it('F-I4: textarea 型は <textarea> 要素で描画し改行を保つ (input flatten を避ける)', async () => {
    rowMock.mockResolvedValue(detailFor(1))
    editRowMock.mockResolvedValue({ id: 'row1', source: 'formaloo', submittedAt: '2026-07-17T00:00:00+09:00', answers: { nameSlug: '田中', noteSlug: '行1\n行2', pickSlug: 'A' }, lastEdit: null })
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))
    const note = screen.getByTestId('edit-input-noteSlug')
    expect(note.tagName).toBe('TEXTAREA') // input でなく textarea
    // 改行を含む値を編集して保存 → 改行が保たれて editRow に渡る (flatten されない)
    fireEvent.change(note, { target: { value: '行1\n行2' } })
    fireEvent.click(screen.getByTestId('edit-save'))
    await waitFor(() => expect(editRowMock).toHaveBeenCalledWith('fa1', 'row1', expect.objectContaining({ noteSlug: '行1\n行2' })))
  })

  it('allow_post_edit=0 → 編集ボタンが出ない', async () => {
    rowMock.mockResolvedValue(detailFor(0))
    await openDetail()
    expect(screen.queryByTestId('edit-answer')).toBeNull()
  })

  it('必須項目を空にすると保存が止まる (editRow を呼ばない + エラー表示)', async () => {
    rowMock.mockResolvedValue(detailFor(1))
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))
    fireEvent.change(screen.getByTestId('edit-input-nameSlug'), { target: { value: '   ' } }) // 必須を空白に
    fireEvent.click(screen.getByTestId('edit-save'))
    await waitFor(() => expect(screen.getByTestId('edit-error')).toBeTruthy())
    expect(editRowMock).not.toHaveBeenCalled()
  })

  it('④最終編集者・日時が表示される', async () => {
    rowMock.mockResolvedValue(detailFor(1, { editorStaffId: 'env-owner', editorName: 'Owner', editedAt: '2026-07-17T02:30:00+09:00' }))
    await openDetail()
    const le = screen.getByTestId('last-edit')
    expect(le.textContent).toContain('Owner')
    expect(le.textContent).toContain('2026-07-17 02:30')
  })
})
