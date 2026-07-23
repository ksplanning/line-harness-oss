// @vitest-environment jsdom
/**
 * form-post-edit (弾M / T-D2) — 回答詳細の編集モード (①管理者編集)。
 *   - allow_post_edit=1 → 「編集」ボタン表示 → 入力欄で直し保存すると editRow が呼ばれる。
 *   - allow_post_edit=0 → 編集ボタンが出ない。
 *   - 必須項目を空にすると保存が止まる (editRow を呼ばない)。
 *   - ④最終編集者・日時が表示される。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: null }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
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
  formsAdvancedApi: {
    get: (...a: unknown[]) => getMock(...a),
    getRenderBackend: (...a: unknown[]) => getRenderBackendMock(...a),
  },
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
  getMock.mockReset(); getRenderBackendMock.mockReset(); rowsMock.mockReset(); rowMock.mockReset(); editRowMock.mockReset()
  statsMock.mockReset(); listFiltersMock.mockReset(); fetchApiMock.mockReset()
  mockAccount.selectedAccountId = null
  getMock.mockResolvedValue({ id: 'fa1', title: 'F', lineAccountId: null, renderBackend: 'formaloo' })
  getRenderBackendMock.mockResolvedValue('formaloo')
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 0, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openDetail() {
  render(<DataCockpitClient id="fa1" />)
  await waitFor(() => expect(screen.getByTestId('open-row')).toBeTruthy())
  fireEvent.click(screen.getByTestId('open-row'))
  await waitFor(() => expect(screen.getByText('回答の詳細')).toBeTruthy())
}

describe('T-D2 回答詳細 編集モード', () => {
  it('外部編集の差分を詳細ドロワーに項目名つきで表示する', async () => {
    rowMock.mockResolvedValue({
      ...detailFor(0),
      answers: { nameSlug: '佐藤', noteSlug: '旧メモ', pickSlug: 'A' },
      externalEditChanges: [
        { fieldId: 'nameSlug', before: '田中', after: '佐藤' },
      ],
    })

    await openDetail()

    expect(screen.getByTestId('detail-external-edit-changes').textContent)
      .toContain('名前: 田中 → 佐藤')
  })

  it('詳細の承認導線も同じ確認ポップアップを使い、閉じる時は無変更・確認後だけ承認する', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 'row1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    rowMock.mockResolvedValue({
      ...detailFor(0),
      answers: { nameSlug: '佐藤', noteSlug: null, pickSlug: 'A' },
      externalEditSource: 'sheet',
      externalEditedAt: '2026-07-23T10:01:00+09:00',
      externalEditApprovedAt: null,
      externalEditChanges: [
        { fieldId: 'nameSlug', before: '田中', after: '佐藤' },
        { fieldId: 'noteSlug', before: '旧メモ', after: null },
      ],
    })

    await openDetail()

    const changes = screen.getByTestId('detail-external-edit-changes')
    fireEvent.click(within(changes).getByRole('button', { name: '差分を確認して承認' }))
    expect(fetchMock).not.toHaveBeenCalled()
    let dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    expect(dialog.getAttribute('data-testid')).toBe('external-edit-approval-dialog')
    expect(within(dialog).getByText('シート')).toBeTruthy()
    expect(within(dialog).getByText('2026-07-23 10:01')).toBeTruthy()
    expect(within(dialog).getByText('名前')).toBeTruthy()
    expect(within(dialog).getByText('メモ')).toBeTruthy()
    expect(within(dialog).getByText('旧メモ')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText('回答の詳細')).toBeTruthy()

    fireEvent.click(within(changes).getByRole('button', { name: '差分を確認して承認' }))
    dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    fireEvent.click(within(dialog).getByRole('button', { name: '確認して承認' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/forms-advanced/fa1/rows/row1/approve-external-edit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedExternalEditSource: 'sheet',
          expectedExternalEditedAt: '2026-07-23T10:01:00+09:00',
        }),
      }),
    ))
    await waitFor(() => {
      expect(rowsMock).toHaveBeenCalledTimes(2)
      expect(statsMock).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByText('回答の詳細')).toBeNull()
  })

  it('差分0件の未承認回答も詳細から確認して承認できる', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 'row1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    rowMock.mockResolvedValue({
      ...detailFor(0),
      externalEditSource: 'edit_link',
      externalEditedAt: '2026-07-23T10:01:00+09:00',
      externalEditApprovedAt: null,
      externalEditChanges: [],
    })

    await openDetail()

    const changes = screen.getByTestId('detail-external-edit-changes')
    fireEvent.click(within(changes).getByRole('button', { name: '差分を確認して承認' }))
    const dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    expect(within(dialog).getByText('変更された項目はありません')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '確認して承認' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it.each([
    { verified: true, expected: 'LINE連携: 連携済み' },
    { verified: false, expected: 'LINE連携: 未連携' },
  ])('詳細ドロワーにLINE連携状態を「$expected」と表示する', async ({ verified, expected }) => {
    rowMock.mockResolvedValue({ ...detailFor(0), verified })

    await openDetail()

    expect(screen.getByTestId('detail-line-linkage').textContent).toBe(expected)
  })

  it('回答済みをフォーム順で先に並べ、未回答は件数付きで初期状態を閉じる', async () => {
    rowMock.mockResolvedValue({
      ...detailFor(1),
      fields: [
        { slug: 'nameSlug', label: '名前', type: 'text', required: false, editable: true },
        { slug: 'zeroSlug', label: '参加回数', type: 'number', required: false, editable: true },
        { slug: 'falseSlug', label: '同意', type: 'yes_no', required: false, editable: true },
        { slug: 'blankSlug', label: '備考', type: 'text', required: false, editable: true },
        { slug: 'missingSlug', label: '紹介者', type: 'text', required: false, editable: true },
        { slug: 'emptyArraySlug', label: '希望', type: 'multiple_select', required: false, editable: true },
      ],
      answers: {
        unknownSlug: '定義外の回答',
        falseSlug: false,
        blankSlug: '   ',
        zeroSlug: 0,
        nameSlug: '田中',
        emptyArraySlug: [],
      },
    })
    await openDetail()

    const answered = screen.getByTestId('answered-answers')
    expect(Array.from(answered.querySelectorAll('[data-answer-slug]')).map((node) => node.getAttribute('data-answer-slug')))
      .toEqual(['nameSlug', 'zeroSlug', 'falseSlug', 'unknownSlug'])
    expect(within(answered).getByText('回答済みの項目')).toBeTruthy()
    expect(within(answered).getByText('0')).toBeTruthy()
    expect(within(answered).getByText('いいえ')).toBeTruthy()

    const unanswered = screen.getByTestId('unanswered-answers') as HTMLDetailsElement
    expect(unanswered.open).toBe(false)
    expect(unanswered.querySelector('summary')?.textContent).toContain('未回答の項目（3件）')
    expect(Array.from(unanswered.querySelectorAll('[data-answer-slug]')).map((node) => node.getAttribute('data-answer-slug')))
      .toEqual(['blankSlug', 'missingSlug', 'emptyArraySlug'])
  })

  it('長文は改行を保って強制折返しし、複合値は項目ごとのリストで表示する', async () => {
    const longAnswer = `一行目\n${'very-long-value'.repeat(20)}`
    rowMock.mockResolvedValue({
      ...detailFor(0),
      fields: [
        { slug: 'longSlug', label: '長文', type: 'textarea', required: false, editable: true },
        { slug: 'profileSlug', label: 'プロフィール', type: 'matrix', required: false, editable: false },
      ],
      answers: {
        profileSlug: { 住所: '東京都', 備考: '車いすを利用' },
        longSlug: longAnswer,
      },
    })
    await openDetail()

    const longValue = screen.getByTestId('answer-value-longSlug')
    expect(longValue.textContent).toBe(longAnswer)
    expect(longValue.className).toContain('whitespace-pre-wrap')
    expect(longValue.className).toContain('[overflow-wrap:anywhere]')
    const composite = screen.getByTestId('answer-value-profileSlug')
    expect(within(composite).getAllByRole('listitem')).toHaveLength(2)
    expect(composite.textContent).toContain('住所: 東京都')
    expect(composite.textContent).toContain('備考: 車いすを利用')
  })

  it('回答を編集ボタンを詳細見出しと同じ上部に置き、回答一覧より前に表示する', async () => {
    rowMock.mockResolvedValue(detailFor(1))
    await openDetail()

    const header = screen.getByTestId('detail-header')
    const editButton = within(header).getByTestId('edit-answer')
    const answered = screen.getByTestId('answered-answers')
    expect(header.compareDocumentPosition(answered) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(editButton.textContent).toContain('回答を編集')
    expect(editButton.className).toContain('min-h-[40px]')

    fireEvent.click(editButton)
    expect(screen.getByTestId('edit-input-nameSlug')).toBeTruthy()
  })

  it('internal source は admin-origin URL を発行して同じ /ife/ 編集画面へ遷移する', async () => {
    getMock.mockResolvedValue({ id: 'fa1', title: 'F', lineAccountId: null, renderBackend: 'internal' })
    getRenderBackendMock.mockResolvedValue('internal')
    rowMock.mockResolvedValue({ ...detailFor(1), source: 'internal' })
    const editUrl = 'https://api.example.test/ife/admin-origin-token'
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
    expect(editRowMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('edit-input-nameSlug')).toBeNull()
  })

  it('Formaloo source の旧インライン UI は editVersion CAS 付き編集を保つ', async () => {
    const answerRevision = 'a'.repeat(64)
    const nextRevision = 'b'.repeat(64)
    const finalRevision = 'c'.repeat(64)
    const internalFields = [
      { slug: 'nameSlug', label: '名前', type: 'text', required: true, editable: true, editableWhenVisible: true, visible: true },
      { slug: 'consent', label: '同意', type: 'yes_no', required: true, editable: true, editableWhenVisible: true, visible: true },
      {
        slug: 'tags', label: '希望', type: 'multiple_select', required: false,
        editable: true, editableWhenVisible: true, visible: true,
        choices: ['A, Inc.', '和食、洋食', ' 前後空白 ', '未選択'],
      },
      { slug: 'company', label: '会社名', type: 'text', required: true, editable: false, editableWhenVisible: true, visible: false },
      { slug: 'matrix', label: '評価', type: 'matrix', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'repeat', label: '参加者', type: 'repeating_section', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'docs', label: '添付', type: 'file', required: false, editable: false, editableWhenVisible: false, visible: true },
    ]
    const exactSelections = ['A, Inc.', '和食、洋食', ' 前後空白 ']
    const remainingSelections = ['A, Inc.', ' 前後空白 ']
    const refreshedInternalFields = internalFields.map((field) => field.slug === 'company'
      ? { ...field, editable: true, visible: true }
      : field)
    const internalAnswers = {
      nameSlug: '田中', consent: true, tags: exactSelections, matrix: { 接客: '良い' },
      repeat: [{ 参加者名: '花子', 年齢: 20 }],
      docs: [{ key: 'forms/fa1/row1/docs/file.pdf', name: '申込書.pdf', size: 1234, type: 'application/pdf' }],
    }
    rowMock.mockResolvedValue({
      ...detailFor(1), source: 'formaloo', answers: internalAnswers, fields: internalFields,
      editVersion: 7, answerRevision,
    })
    editRowMock
      .mockResolvedValueOnce({
        id: 'row1', source: 'formaloo', submittedAt: '2026-07-17T00:00:00+09:00',
        answers: {
          ...internalAnswers, nameSlug: '内部更新', tags: remainingSelections, company: '株式会社テスト',
        },
        allowPostEdit: 1, fields: refreshedInternalFields,
        editVersion: 8, answerRevision: nextRevision, lastEdit: null,
      })
      .mockResolvedValueOnce({
        id: 'row1', source: 'formaloo', submittedAt: '2026-07-17T00:00:00+09:00',
        answers: {
          ...internalAnswers, nameSlug: '内部更新', tags: remainingSelections, company: '株式会社テスト',
        },
        allowPostEdit: 1, fields: refreshedInternalFields,
        editVersion: 9, answerRevision: finalRevision, lastEdit: null,
      })
    await openDetail()

    expect(screen.getByTestId('answer-source').textContent).toContain('Formaloo 最新')
    expect(document.body.textContent).toContain('接客: 良い')
    expect(document.body.textContent).toContain('参加者名: 花子')
    expect(document.body.textContent).toContain('申込書.pdf')
    expect(document.body.textContent).not.toContain('[object Object]')
    fireEvent.click(screen.getByTestId('edit-answer'))
    expect((screen.getByTestId('edit-input-consent') as HTMLSelectElement).value).toBe('yes')
    expect(screen.getByTestId('edit-input-tags').textContent).toContain('A, Inc.')
    expect((screen.getByTestId('edit-input-tags-0') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('edit-input-tags-1') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('edit-input-tags-1'))
    expect(screen.getByTestId('edit-input-company')).toBeTruthy()
    fireEvent.change(screen.getByTestId('edit-input-nameSlug'), { target: { value: '内部更新' } })
    fireEvent.change(screen.getByTestId('edit-input-company'), { target: { value: '株式会社テスト' } })
    fireEvent.click(screen.getByTestId('edit-save'))

    await waitFor(() => expect(editRowMock).toHaveBeenCalledWith(
      'fa1',
      'row1',
      expect.objectContaining({
        nameSlug: '内部更新', consent: 'yes',
        tags: remainingSelections, company: '株式会社テスト',
      }),
      7,
      answerRevision,
    ))
    expect(screen.getByTestId('answer-source').textContent).toContain('Formaloo 最新')
    expect(document.body.textContent).toContain('参加者名: 花子')
    expect(document.body.textContent).toContain('申込書.pdf')
    expect(document.body.textContent).not.toContain('[object Object]')

    fireEvent.click(screen.getByTestId('edit-answer'))
    expect(screen.getByTestId('edit-input-company').parentElement?.textContent)
      .not.toContain('条件を変えたときに入力')
    expect((screen.getByTestId('edit-input-tags-0') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('edit-input-tags-1') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('edit-input-tags-2') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('edit-save'))
    await waitFor(() => expect(editRowMock).toHaveBeenCalledTimes(2))
    expect(editRowMock).toHaveBeenLastCalledWith(
      'fa1',
      'row1',
      expect.objectContaining({
        consent: 'yes', tags: remainingSelections, company: '株式会社テスト',
      }),
      8,
      nextRevision,
    )
  })

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
    expect(le.textContent).toContain('2026-07-17 02:30') // +09:00 の editedAt を二重変換しない (T-C3)
  })

  it('T-C3: 詳細ドロワーの送信日時が UTC(Z) を JST 壁時計で表示する (08:18Z → 17:18)', async () => {
    rowMock.mockResolvedValue({ id: 'row1', source: 'mirror', submittedAt: '2026-07-18T08:18:33Z', answers: { nameSlug: '田中' }, allowPostEdit: 0, fields: FIELDS, lastEdit: null })
    await openDetail()
    // ドロワー冒頭の送信日時行 (source ラベル併記) に JST 表示が出る
    expect(screen.getByText(/2026-07-18 17:18/)).toBeTruthy()
  })
})
