// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
const NEXT_ANSWER_REVISION = 'b'.repeat(64)
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

  it('編集モードでも編集不可の file 回答をファイル名で表示する', async () => {
    rowMock.mockResolvedValue({ ...FILE_DETAIL, allowPostEdit: 1 })
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))

    expect(document.body.textContent).not.toContain('[object Object]')
    expect(screen.getByText('見積書.pdf, 写真.png')).toBeTruthy()
  })

  it('管理可能な file 項目は保存済みサムネイル・非画像アイコン・削除・追加入力を表示する', async () => {
    rowMock.mockResolvedValue(MANAGEABLE_FILE_DETAIL)
    await openDetail()

    fireEvent.click(screen.getByTestId('edit-answer'))

    const savedFiles = await screen.findByRole('list', { name: '保存済みファイル' })
    expect(within(savedFiles).getByText('見積書.pdf')).toBeTruthy()
    expect(within(savedFiles).getByText('PDF')).toBeTruthy()
    expect(within(savedFiles).getByText('写真.png')).toBeTruthy()
    const savedImage = await within(savedFiles).findByRole('img', { name: '写真.png のプレビュー' })
    expect(savedImage.getAttribute('src')).toBe('blob:saved-image')
    expect(fetchAttachmentBlobMock).toHaveBeenCalledWith('fa1', 'row1', 'docs', 1)
    expect(within(savedFiles).getAllByText('削除する')).toHaveLength(2)

    const input = screen.getByLabelText('添付資料：ファイルを追加') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
    expect(input.accept).toBe('.pdf,.png')
    expect(input.dataset.maxSizeKb).toBe('2048')
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:saved-image')
  })

  it('追加画像をプレビューし、保存前に追加対象から削除できる', async () => {
    rowMock.mockResolvedValue(MANAGEABLE_FILE_DETAIL)
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))
    const input = screen.getByLabelText('添付資料：ファイルを追加') as HTMLInputElement
    const added = new File(['new-image'], '追加写真.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [added] } })

    const preview = await screen.findByRole('img', { name: '追加写真.png のプレビュー' })
    expect(preview.getAttribute('src')).toBe('blob:追加写真.png')
    expect(screen.getByText('追加写真.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '追加写真.png を削除' }))
    expect(screen.queryByText('追加写真.png')).toBeNull()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:追加写真.png')
  })

  it('既存 index 0 の削除と追加を CAS 付きで保存し、返却された最終一覧を再表示する', async () => {
    const added = new File(['new-image'], '追加写真.png', { type: 'image/png' })
    const finalAnswers = {
      docs: [
        FILE_DETAIL.answers.docs[1],
        {
          key: 'internal-form-submissions/fa1/docs/u3.png',
          name: added.name,
          size: added.size,
          type: added.type,
        },
      ],
    }
    rowMock.mockResolvedValue(MANAGEABLE_FILE_DETAIL)
    editRowMock.mockResolvedValue({
      ...MANAGEABLE_FILE_DETAIL,
      answers: finalAnswers,
      editVersion: 8,
      answerRevision: NEXT_ANSWER_REVISION,
    })
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))

    fireEvent.click(await screen.findByRole('checkbox', { name: '見積書.pdf を削除する' }))
    fireEvent.change(screen.getByLabelText('添付資料：ファイルを追加'), { target: { files: [added] } })
    fireEvent.click(screen.getByTestId('edit-save'))

    await waitFor(() => expect(editRowMock).toHaveBeenCalledWith(
      'fa1',
      'row1',
      {},
      7,
      ANSWER_REVISION,
      {
        attachments: [{
          fieldIndex: 0,
          fieldId: 'docs',
          removedIndexes: [0],
          files: [added],
        }],
      },
    ))
    await waitFor(() => expect(screen.queryByText('見積書.pdf')).toBeNull())
    expect(screen.getByText('写真.png')).toBeTruthy()
    expect(screen.getByText('追加写真.png')).toBeTruthy()
    expect(rowsMock).toHaveBeenCalledTimes(2)
  })

  it('単一ファイル項目で選び直したら保存前の追加対象を置き換える', async () => {
    rowMock.mockResolvedValue({
      ...MANAGEABLE_FILE_DETAIL,
      answers: { docs: [] },
      fields: [{
        ...MANAGEABLE_FILE_DETAIL.fields[0],
        attachmentConfig: {
          ...MANAGEABLE_FILE_DETAIL.fields[0].attachmentConfig,
          allowMultipleFiles: false,
        },
      }],
    })
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))
    const input = screen.getByLabelText('添付資料：ファイルを追加')
    const first = new File(['first'], '最初.pdf', { type: 'application/pdf' })
    const second = new File(['second'], '選び直し.pdf', { type: 'application/pdf' })

    fireEvent.change(input, { target: { files: [first] } })
    fireEvent.change(input, { target: { files: [second] } })

    expect(screen.queryByText('最初.pdf')).toBeNull()
    expect(screen.getByText('選び直し.pdf')).toBeTruthy()
  })

  it('添付変更時に CAS 情報が無ければ保存せず再読み込みを案内する', async () => {
    rowMock.mockResolvedValue({
      ...MANAGEABLE_FILE_DETAIL,
      answers: { docs: [] },
      editVersion: undefined,
      answerRevision: undefined,
    })
    await openDetail()
    fireEvent.click(screen.getByTestId('edit-answer'))
    fireEvent.change(screen.getByLabelText('添付資料：ファイルを追加'), {
      target: { files: [new File(['new'], '追加.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByTestId('edit-save'))

    expect((await screen.findByRole('alert')).textContent).toContain('再読み込み')
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
