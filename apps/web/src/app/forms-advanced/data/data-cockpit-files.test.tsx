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
const fetchAttachmentBlobMock = vi.fn()
const editRowMock = vi.fn()
const createObjectURLMock = vi.fn((value: Blob) => (
  value instanceof File ? `blob:${value.name}` : 'blob:saved-image'
))
const revokeObjectURLMock = vi.fn()

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

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
    fetchAttachmentBlob: (...args: unknown[]) => fetchAttachmentBlobMock(...args),
    editRow: (...args: unknown[]) => editRowMock(...args),
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

const ANSWER_REVISION = 'a'.repeat(64)
const MANAGEABLE_FILE_DETAIL = {
  ...FILE_DETAIL,
  allowPostEdit: 1,
  editVersion: 7,
  answerRevision: ANSWER_REVISION,
  fields: [{
    slug: 'docs',
    label: '添付資料',
    type: 'file',
    required: false,
    editable: false,
    editableWhenVisible: false,
    visible: true,
    attachmentManageable: true,
    attachmentConfig: {
      allowMultipleFiles: true,
      allowedExtensions: ['pdf', 'png'],
      maxSizeKb: 2048,
    },
  }],
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
  fetchAttachmentBlobMock.mockReset()
  editRowMock.mockReset()
  createObjectURLMock.mockClear()
  revokeObjectURLMock.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
  mockAccount.selectedAccountId = null
  getMock.mockResolvedValue({ id: 'fa1', title: 'F', lineAccountId: null, renderBackend: 'internal' })
  getRenderBackendMock.mockResolvedValue('internal')
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 0, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
  rowMock.mockResolvedValue(FILE_DETAIL)
  downloadAttachmentMock.mockResolvedValue(undefined)
  fetchAttachmentBlobMock.mockResolvedValue(new Blob(['saved-image'], { type: 'image/png' }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
})

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
    const fileName = screen.getByText('見積書.pdf')
    expect(fileName.className).not.toContain('truncate')
    expect(fileName.className).toContain('[overflow-wrap:anywhere]')
    expect(fileName.parentElement?.className).toContain('flex-col')
    expect(screen.getByText('(1.0 KB)')).toBeTruthy()
    expect(screen.getByText('写真.png')).toBeTruthy()
    expect(screen.getByText('(2.0 MB)')).toBeTruthy()
    expect(screen.getByTestId('download-file-docs-0').className).toContain('min-h-[40px]')
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

  it('管理可能な添付も旧UIを開かず admin-origin の /ife/ へ移動する', async () => {
    rowMock.mockResolvedValue(MANAGEABLE_FILE_DETAIL)
    const editUrl = 'https://api.example.test/ife/admin-origin-file-token'
    fetchApiMock.mockImplementation(async (path: string) => (
      path === '/api/staff/me'
        ? { data: { role: 'owner' } }
        : { data: { editUrl } }
    ))
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    await openDetail()

    fireEvent.click(screen.getByTestId('edit-answer'))

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/forms-advanced/fa1/rows/row1/admin-edit-url',
      { method: 'POST' },
    ))
    expect(assign).toHaveBeenCalledWith(editUrl)
    expect(screen.queryByLabelText('添付資料：ファイルを追加')).toBeNull()
    expect(editRowMock).not.toHaveBeenCalled()
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
