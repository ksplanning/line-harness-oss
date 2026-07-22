// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: null }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
const rowsMock = vi.fn()
const rowMock = vi.fn()
const statsMock = vi.fn()
const listFiltersMock = vi.fn()
const fetchApiMock = vi.fn()
const downloadAttachmentMock = vi.fn()

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/data-cockpit', () => ({
  default: ({ onOpenRow }: { onOpenRow: (id: string) => void }) => (
    <button data-testid="open-row" onClick={() => onOpenRow('row1')}>open</button>
  ),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/download', () => ({ csvDateStamp: () => 'd', safeFilenamePart: (value: string) => value }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...args: unknown[]) => getMock(...args),
    getRenderBackend: (...args: unknown[]) => getRenderBackendMock(...args),
  },
  formalooDataApi: {
    rows: (...args: unknown[]) => rowsMock(...args),
    row: (...args: unknown[]) => rowMock(...args),
    stats: (...args: unknown[]) => statsMock(...args),
    listFilters: (...args: unknown[]) => listFiltersMock(...args),
    downloadAttachment: (...args: unknown[]) => downloadAttachmentMock(...args),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import DataCockpitClient from './data-cockpit-client'

const FILE_DETAIL = {
  id: 'row1',
  source: 'internal',
  submittedAt: '2026-07-22T10:00:00+09:00',
  allowPostEdit: 0,
  fields: [{ slug: 'docs', label: '添付資料', type: 'file', required: false, editable: false }],
  answers: {
    docs: [
      { key: 'internal-form-submissions/fa1/docs/u1.pdf', name: '見積書.pdf', size: 1024, type: 'application/pdf' },
      { key: 'internal-form-submissions/fa1/docs/u2.png', name: '写真.png', size: 2 * 1024 * 1024, type: 'image/png' },
    ],
  },
  lastEdit: null,
}

beforeEach(() => {
  getMock.mockReset()
  getRenderBackendMock.mockReset()
  rowsMock.mockReset()
  rowMock.mockReset()
  statsMock.mockReset()
  listFiltersMock.mockReset()
  fetchApiMock.mockReset()
  downloadAttachmentMock.mockReset()
  mockAccount.selectedAccountId = null
  getMock.mockResolvedValue({ id: 'fa1', title: 'F', lineAccountId: null, renderBackend: 'internal' })
  getRenderBackendMock.mockResolvedValue('internal')
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 0, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
  rowMock.mockResolvedValue(FILE_DETAIL)
  downloadAttachmentMock.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

async function openDetail() {
  render(<DataCockpitClient id="fa1" />)
  await waitFor(() => expect(screen.getByTestId('open-row')).toBeTruthy())
  fireEvent.click(screen.getByTestId('open-row'))
  await waitFor(() => expect(screen.getByText('回答の詳細')).toBeTruthy())
}

describe('回答詳細 drawer の file 回答', () => {
  it('ファイル名とサイズを列挙し [object Object] を出さない', async () => {
    await openDetail()
    expect(document.body.textContent).not.toContain('[object Object]')
    expect(screen.getByText('見積書.pdf')).toBeTruthy()
    expect(screen.getByText('(1.0 KB)')).toBeTruthy()
    expect(screen.getByText('写真.png')).toBeTruthy()
    expect(screen.getByText('(2.0 MB)')).toBeTruthy()
  })

  it('各ボタンから正しい index の download API を呼ぶ', async () => {
    await openDetail()
    fireEvent.click(screen.getByTestId('download-file-docs-1'))
    expect(downloadAttachmentMock).toHaveBeenCalledWith('fa1', 'row1', 'docs', 1, '写真.png')
  })

  it("source が 'internal' 以外なら download ボタンを出さない", async () => {
    rowMock.mockResolvedValue({ ...FILE_DETAIL, source: 'formaloo' })
    await openDetail()
    expect(screen.queryByTestId('download-file-docs-0')).toBeNull()
  })

  it('scalar 配列は従来どおり「、」join する', async () => {
    rowMock.mockResolvedValue({ ...FILE_DETAIL, fields: [], answers: { pick: ['A', 'B'] } })
    await openDetail()
    expect(screen.getByText('A、B')).toBeTruthy()
  })
})

describe('?rowId= deep-link', () => {
  it('initialRowId 指定時は初回ロード後に一度だけ詳細を自動で開く', async () => {
    render(<DataCockpitClient id="fa1" initialRowId="row1" />)
    await waitFor(() => expect(screen.getByText('回答の詳細')).toBeTruthy())
    expect(rowMock).toHaveBeenCalledTimes(1)
    expect(rowMock).toHaveBeenCalledWith('fa1', 'row1')
  })

  it('initialRowId 無しでは自動で開かない', async () => {
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('open-row')).toBeTruthy())
    expect(rowMock).not.toHaveBeenCalled()
  })
})
