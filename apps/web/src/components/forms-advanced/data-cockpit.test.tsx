// @vitest-environment jsdom
/**
 * DataCockpit (F-4 / T-D1・T-D2) の component test。
 *   - 統計カード (総回答数/確認済み) 表示
 *   - 回答テーブル (answer 列 union) 表示 + 詳細ボタン → onOpenRow
 *   - フリーワード検索 → onQuery(q) / 並び順 → onQuery(sort) / ページング → onQuery(page)
 *   - owner のみ CSV エクスポート/インポート/選択削除。非 owner は非表示 (N-9)
 *   - 選択削除は行内確認 (window.confirm 不使用 / M-16) → onBulkDelete(ids)
 *   - 保存フィルタ適用 → onQuery
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import DataCockpit, { type DataCockpitProps } from './data-cockpit'
import type { SubmissionRow } from '@/lib/formaloo-advanced-api'

afterEach(() => cleanup())

const ROWS: SubmissionRow[] = [
  { id: 's1', friendId: 'fr_1', answers: { 名前: '田中', 電話: '090' }, submittedAt: '2026-07-09T10:00:00+09:00', verified: true },
  { id: 's2', friendId: 'fr_2', answers: { 名前: '鈴木' }, submittedAt: '2026-07-05T10:00:00+09:00', verified: false },
]

function base(overrides: Partial<DataCockpitProps> = {}): DataCockpitProps {
  return {
    formTitle: 'お問い合わせ',
    rows: ROWS,
    total: 40,
    page: 1,
    pageSize: 25,
    stats: { total: 40, verified: 12, daily: [{ day: '2026-07-09', count: 3 }], formaloo: null },
    savedFilters: [],
    isOwner: true,
    onQuery: vi.fn(),
    onSaveFilter: vi.fn(),
    onDeleteFilter: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onBulkDelete: vi.fn(),
    onOpenRow: vi.fn(),
    ...overrides,
  }
}

describe('DataCockpit — 表示 (T-D1)', () => {
  it('統計カードに総回答数と確認済みを出す', () => {
    render(<DataCockpit {...base()} />)
    expect(screen.getByTestId('stats-total').textContent).toBe('40')
    expect(screen.getByTestId('stats-verified').textContent).toBe('12')
  })

  it('回答テーブルに answer 列 (union) と値を出す', () => {
    render(<DataCockpit {...base()} />)
    expect(screen.getByText('名前')).toBeTruthy()
    expect(screen.getByText('電話')).toBeTruthy() // union: s1 のみ持つ列も出る
    expect(screen.getByText('田中')).toBeTruthy()
    expect(screen.getByText('鈴木')).toBeTruthy()
  })

  it('詳細ボタンで onOpenRow(rowId)', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByLabelText('s1 の詳細'))
    expect(p.onOpenRow).toHaveBeenCalledWith('s1')
  })
})

describe('DataCockpit — 検索/ソート/ページング (T-D1)', () => {
  it('フリーワード + 検索 → onQuery(q)', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.change(screen.getByLabelText('フリーワード検索'), { target: { value: '田中' } })
    fireEvent.click(screen.getByText('検索'))
    expect(p.onQuery).toHaveBeenCalledWith(expect.objectContaining({ q: '田中', page: 1 }))
  })

  it('並び順を古い順にして検索 → onQuery(sort=asc)', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.change(screen.getByLabelText('並び順'), { target: { value: 'asc' } })
    fireEvent.click(screen.getByText('検索'))
    expect(p.onQuery).toHaveBeenCalledWith(expect.objectContaining({ sort: 'asc' }))
  })

  it('次へで onQuery(page=2) / 40件・25件ページで 2 ページ', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    expect(screen.getByTestId('page-label').textContent).toBe('1 / 2')
    expect(screen.getByTestId('range-label').textContent).toContain('40件中 1–25')
    fireEvent.click(screen.getByText('次へ'))
    expect(p.onQuery).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }))
  })
})

describe('DataCockpit — owner gated 操作 (T-D2 / N-9)', () => {
  it('owner には CSV エクスポート/インポートが出る', () => {
    render(<DataCockpit {...base({ isOwner: true })} />)
    expect(screen.getByText('CSVエクスポート')).toBeTruthy()
    expect(screen.getByText('CSVインポート')).toBeTruthy()
  })

  it('非 owner には CSV エクスポート/インポート/選択欄が出ない', () => {
    render(<DataCockpit {...base({ isOwner: false })} />)
    expect(screen.queryByText('CSVエクスポート')).toBeNull()
    expect(screen.queryByLabelText('s1 を選択')).toBeNull()
  })

  it('エクスポートで onExport', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByText('CSVエクスポート'))
    expect(p.onExport).toHaveBeenCalled()
  })

  it('行選択 → 選択削除 → 行内確認 → onBulkDelete(ids) (window.confirm 不使用)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByLabelText('s1 を選択'))
    fireEvent.click(screen.getByText(/選択削除/))
    // 行内確認カードが出る (native confirm は呼ばれない)
    const confirm = screen.getByTestId('delete-confirm')
    expect(within(confirm).getByText('はい')).toBeTruthy()
    fireEvent.click(within(confirm).getByText('はい'))
    expect(p.onBulkDelete).toHaveBeenCalledWith(['s1'])
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('CSVインポートパネルで貼り付け → onImport(csv)', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByText('CSVインポート'))
    // textarea の value はブラウザ/jsdom が改行を LF 正規化する (parseCsv は CRLF/LF 両対応)。
    fireEvent.change(screen.getByLabelText('CSV貼り付け'), { target: { value: '回答ID\ns1\n' } })
    fireEvent.click(screen.getByText('取り込む'))
    const csvArg = (p.onImport as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(csvArg).toContain('回答ID')
    expect(csvArg).toContain('s1')
  })
})

describe('DataCockpit — 保存フィルタ (T-D1)', () => {
  it('保存フィルタ適用で onQuery / 削除で onDeleteFilter', () => {
    const p = base({ savedFilters: [{ id: 'ff1', name: '田中のみ', filter: { q: '田中', sort: 'asc' } }] })
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByText('田中のみ'))
    expect(p.onQuery).toHaveBeenCalledWith(expect.objectContaining({ q: '田中', sort: 'asc' }))
    fireEvent.click(screen.getByLabelText('田中のみ を削除'))
    expect(p.onDeleteFilter).toHaveBeenCalledWith('ff1')
  })

  it('この条件を保存 → 名前入力 → onSaveFilter', () => {
    const p = base()
    render(<DataCockpit {...p} />)
    fireEvent.change(screen.getByLabelText('フリーワード検索'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByText('この条件を保存'))
    fireEvent.change(screen.getByLabelText('保存名'), { target: { value: '重要' } })
    fireEvent.click(screen.getByText('保存'))
    expect(p.onSaveFilter).toHaveBeenCalledWith('重要', expect.objectContaining({ q: 'abc' }))
  })
})
