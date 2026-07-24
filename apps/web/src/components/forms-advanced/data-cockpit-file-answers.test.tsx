// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import DataCockpit, { type DataCockpitProps } from './data-cockpit'
import type { SubmissionRow } from '@/lib/formaloo-advanced-api'

vi.mock('@/lib/api', () => ({ fetchApi: vi.fn() }))

afterEach(() => cleanup())

const ROWS: SubmissionRow[] = [{
  id: 's1',
  friendId: null,
  answers: {
    docs: [
      { key: 'internal-form-submissions/f1/docs/u1.pdf', name: '見積書.pdf', size: 1024, type: 'application/pdf' },
      { key: 'internal-form-submissions/f1/docs/u2.png', name: '写真.png', size: 2048, type: 'image/png' },
    ],
    pick: ['A', 'B'],
  },
  submittedAt: '2026-07-22T10:00:00+09:00',
  verified: false,
}]

function props(): DataCockpitProps {
  return {
    formId: 'file-answer-form',
    formTitle: '添付テスト',
    rows: ROWS,
    total: 1,
    page: 1,
    pageSize: 25,
    stats: null,
    savedFilters: [],
    isOwner: false,
    onQuery: vi.fn(),
    onSaveFilter: vi.fn(),
    onDeleteFilter: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onBulkDelete: vi.fn(),
    onOpenRow: vi.fn(),
    onOpenFriend: vi.fn(),
    onConfirmDuplicate: vi.fn().mockResolvedValue(undefined),
  }
}

describe('DataCockpit file 回答セル', () => {
  it('ファイル名を列挙し [object Object] を出さない', () => {
    const { container } = render(<DataCockpit {...props()} />)
    expect(container.textContent).not.toContain('[object Object]')
    expect(screen.getByText('見積書.pdf, 写真.png')).toBeTruthy()
  })

  it('scalar 配列は従来どおり「、」join する', () => {
    render(<DataCockpit {...props()} />)
    expect(screen.getByText('A、B')).toBeTruthy()
  })
})
