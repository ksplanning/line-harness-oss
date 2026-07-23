// @vitest-environment jsdom
/**
 * DataCockpit (F-4 / T-D1・T-D2) の component test。
 *   - 統計カード (総回答数/LINE連携) 表示
 *   - 回答テーブル (answer 列 union) 表示 + 詳細ボタン → onOpenRow
 *   - フリーワード検索 → onQuery(q) / 並び順 → onQuery(sort) / ページング → onQuery(page)
 *   - owner のみ CSV エクスポート/インポート/選択削除。非 owner は非表示 (N-9)
 *   - 選択削除は行内確認 (window.confirm 不使用 / M-16) → onBulkDelete(ids)
 *   - 保存フィルタ適用 → onQuery
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import DataCockpit, { type DataCockpitProps } from './data-cockpit'
import type { SubmissionRow } from '@/lib/formaloo-advanced-api'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
  it('統計カードに総回答数とLINE連携数を出す', () => {
    render(<DataCockpit {...base()} />)
    expect(screen.getByTestId('stats-total').textContent).toBe('40')
    expect(screen.getByTestId('stats-verified').textContent).toBe('12')
    expect(screen.getAllByText('LINE連携').length).toBeGreaterThan(0)
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

  it('31項目でも一覧は先頭3項目に絞り、残りは詳細で確認できると案内する', () => {
    const fieldLabels = Array.from({ length: 31 }, (_, index) => ({
      slug: `field-${index + 1}`,
      label: `質問 ${index + 1}`,
    }))
    const answers = Object.fromEntries(fieldLabels.map((field, index) => [field.slug, `回答 ${index + 1}`]))
    const rows: SubmissionRow[] = [{
      id: 'many-fields',
      friendId: 'friend-many',
      answers,
      submittedAt: '2026-07-23T10:00:00+09:00',
      verified: false,
    }]

    render(<DataCockpit {...base({ rows, total: 1, isOwner: false, fieldLabels })} />)

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toContain('質問 1')
    expect(headers).toContain('質問 2')
    expect(headers).toContain('質問 3')
    expect(headers).not.toContain('質問 4')
    expect(headers).not.toContain('質問 31')
    expect(headers).toContain('LINE連携')
    expect(screen.getByText(/残り28項目は.*詳細.*で確認/)).toBeTruthy()
  })

  it('未回答キーが一覧APIで省略されても、フォーム定義31項目を基準に残数を案内する', () => {
    const fieldLabels = Array.from({ length: 31 }, (_, index) => ({
      slug: `sparse-${index + 1}`,
      label: `疎な質問 ${index + 1}`,
    }))
    const rows: SubmissionRow[] = [{
      id: 'sparse-fields',
      friendId: null,
      answers: { 'sparse-1': '回答あり' },
      submittedAt: '2026-07-23T10:00:00+09:00',
      verified: false,
    }]

    render(<DataCockpit {...base({ rows, total: 1, isOwner: false, fieldLabels })} />)

    expect(screen.getByText(/残り30項目は.*詳細.*で確認/)).toBeTruthy()
  })

  it('詳細ボタンを表の左端に置き、44px以上のタップ領域にする', () => {
    const p = base()
    render(<DataCockpit {...p} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers[0]?.textContent).toBe('詳細')

    const row = screen.getByLabelText('s1 の詳細').closest('tr')
    expect(row).toBeTruthy()
    const cells = within(row as HTMLTableRowElement).getAllByRole('cell')
    const detailButton = screen.getByLabelText('s1 の詳細')
    expect(cells[0]?.contains(detailButton)).toBe(true)
    expect(detailButton.className).toContain('min-h-[44px]')
    expect(detailButton.className).toContain('min-w-[72px]')

    fireEvent.click(detailButton)
    expect(p.onOpenRow).toHaveBeenCalledWith('s1')
  })
})

describe('DataCockpit — 外部編集レビュー (D-3)', () => {
  const externalRows: SubmissionRow[] = [
    {
      ...ROWS[0],
      formId: 'form-1',
      externalEditSource: 'edit_link',
      externalEditedAt: '2026-07-23T10:00:00+09:00',
      externalEditApprovedAt: null,
      externalEditChanges: [
        { fieldId: 'name', before: '変更前', after: '田中' },
      ],
    },
    {
      ...ROWS[1],
      formId: 'form-1',
      externalEditSource: 'sheet',
      externalEditedAt: '2026-07-23T10:01:00+09:00',
      externalEditApprovedAt: null,
    },
  ]

  it('LINE連携の状態名をデスクトップとスマホ表示へ反映する', () => {
    render(<DataCockpit {...base({ rows: externalRows, total: 2 })} />)

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toContain('LINE連携')
    expect(screen.getAllByText('LINE連携:').length).toBeGreaterThan(0)
    expect(screen.getByText('連携済み')).toBeTruthy()
    expect(screen.getByText('未連携')).toBeTruthy()
  })

  it('変更フィールドだけを項目名付きの変更前→変更後で表示する', () => {
    const changedRow: SubmissionRow = {
      ...externalRows[0],
      externalEditChanges: [
        { fieldId: 'name', before: '変更前', after: '変更後' },
        { fieldId: 'removed', before: '削除前', after: null },
      ],
    }
    render(<DataCockpit {...base({
      rows: [changedRow],
      total: 1,
      fieldLabels: [{ slug: 'name', label: 'お名前' }],
    })} />)

    expect(screen.getByText('お名前: 変更前 → 変更後')).toBeTruthy()
    expect(screen.getByText('removed: 削除前 → —')).toBeTruthy()
  })

  it('件数付きボタンで未承認だけを絞り込み、検索・ページングにも条件を引き継ぐ', () => {
    const p = base({
      rows: externalRows,
      total: 2,
      stats: {
        total: 2,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 2,
      } as DataCockpitProps['stats'],
    })
    render(<DataCockpit {...p} />)

    expect(screen.getByText('編集URL')).toBeTruthy()
    expect(screen.getByText('シート')).toBeTruthy()
    const filter = screen.getByRole('button', { name: '外部編集（未承認） 2件' })
    fireEvent.click(filter)
    expect(p.onQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      externalEdit: 'pending',
      page: 1,
    }))

    fireEvent.change(screen.getByLabelText('フリーワード検索'), { target: { value: '田中' } })
    fireEvent.click(screen.getByRole('button', { name: '検索' }))
    expect(p.onQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      externalEdit: 'pending',
      q: '田中',
      page: 1,
    }))
  })

  it('絞り込み切替直後も通常回答を一覧へ残さない', () => {
    const normalRow = {
      ...ROWS[1],
      id: 'normal-row',
      formId: 'form-1',
      externalEditSource: null,
      externalEditedAt: null,
      externalEditApprovedAt: null,
    } as SubmissionRow
    const p = base({
      rows: [externalRows[0], normalRow],
      total: 2,
      stats: {
        total: 2,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })
    render(<DataCockpit {...p} />)

    fireEvent.click(screen.getByRole('button', { name: '外部編集（未承認） 1件' }))

    expect(screen.getByLabelText('s1 の詳細')).toBeTruthy()
    expect(screen.queryByLabelText('normal-row の詳細')).toBeNull()
  })

  it('承認ボタンの初回クリックでは API を呼ばず、経路・日時・全差分の確認ポップアップを開く', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const changedRow: SubmissionRow = {
      ...externalRows[0],
      externalEditChanges: [
        { fieldId: 'name', before: '旧氏名', after: '新氏名' },
        { fieldId: 'removed', before: '削除前', after: null },
      ],
    }
    render(<DataCockpit {...base({
      rows: [changedRow],
      total: 1,
      fieldLabels: [{ slug: 'name', label: 'お名前' }],
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))

    expect(fetchMock).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    expect(dialog.getAttribute('data-testid')).toBe('external-edit-approval-dialog')
    expect(within(dialog).getByText('編集URL')).toBeTruthy()
    expect(within(dialog).getByText('2026-07-23 10:00')).toBeTruthy()
    expect(within(dialog).getByText('お名前')).toBeTruthy()
    expect(within(dialog).getByText('旧氏名')).toBeTruthy()
    expect(within(dialog).getByText('新氏名')).toBeTruthy()
    expect(within(dialog).getByText('removed')).toBeTruthy()
    expect(within(dialog).getByText('削除前')).toBeTruthy()
    expect(within(dialog).getByText('—')).toBeTruthy()
  })

  it('確認ポップアップを閉じるだけでは API を呼ばず、未承認の行と件数を保つ', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<DataCockpit {...base({
      rows: [externalRows[0]],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    const dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '外部編集の差分を確認' })).toBeNull()
    expect(screen.getByLabelText('s1 の詳細')).toBeTruthy()
    expect(screen.getByRole('button', { name: '外部編集（未承認） 1件' })).toBeTruthy()
  })

  it('差分0件の未承認回答も、0件と明示したポップアップから承認できる', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 's1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DataCockpit {...base({
      rows: [{ ...externalRows[0], externalEditChanges: [] } as SubmissionRow],
      total: 1,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    const dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    expect(within(dialog).getByText('変更された項目はありません')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '確認して承認' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('添付差分はファイル名だけを表示し、内部保存キーを表示しない', () => {
    const privateKey = 'forms/form-1/row-1/private-document.pdf'
    render(<DataCockpit {...base({
      rows: [{
        ...externalRows[0],
        externalEditChanges: [{
          fieldId: 'attachment',
          before: [{ key: privateKey, name: '変更前.pdf', size: 1024, type: 'application/pdf' }],
          after: [{ key: 'forms/form-1/row-1/new-private.pdf', name: '変更後.pdf', size: 2048, type: 'application/pdf' }],
        }],
      } as SubmissionRow],
      total: 1,
      fieldLabels: [{ slug: 'attachment', label: '添付資料' }],
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    const dialog = screen.getByRole('dialog', { name: '外部編集の差分を確認' })
    expect(within(dialog).getByText('変更前.pdf')).toBeTruthy()
    expect(within(dialog).getByText('変更後.pdf')).toBeTruthy()
    expect(dialog.textContent).not.toContain(privateKey)
    expect(dialog.textContent).not.toContain('new-private.pdf')
  })

  it('ポップアップ表示中は背景スクロールを止め、Escapeで閉じた後に入口へフォーカスを戻す', async () => {
    render(<DataCockpit {...base({ rows: [externalRows[0]], total: 1 })} />)
    const trigger = screen.getByRole('button', { name: 's1 の外部編集を承認' })
    const previousOverflow = document.body.style.overflow
    trigger.focus()

    fireEvent.click(trigger)

    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '確認して承認' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '外部編集の差分を確認' })).toBeNull())
    expect(document.body.style.overflow).toBe(previousOverflow)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('承認 API 成功後、未承認一覧から行と件数を即時に消す', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 's1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const p = base({
      rows: [externalRows[0]],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })
    render(<DataCockpit {...p} />)

    fireEvent.click(screen.getByRole('button', { name: '外部編集（未承認） 1件' }))
    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '確認して承認' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/forms-advanced/form-1/rows/s1/approve-external-edit',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedExternalEditSource: 'edit_link',
          expectedExternalEditedAt: '2026-07-23T10:00:00+09:00',
        }),
      }),
    ))
    await waitFor(() => expect(screen.queryByLabelText('s1 の詳細')).toBeNull())
    expect(screen.getByText('回答がありません')).toBeTruthy()
    expect(screen.getByRole('button', { name: '外部編集（未承認） 0件' })).toBeTruthy()
  })

  it('409 では競合文言をポップアップ内に表示し、未承認の行を残す', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: '回答が更新されたため、内容を確認し直してください',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DataCockpit {...base({
      rows: [externalRows[0]],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    fireEvent.click(screen.getByRole('button', { name: '確認して承認' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('回答が更新されたため、内容を確認し直してください')
    expect(screen.getByRole('dialog', { name: '外部編集の差分を確認' })).toBeTruthy()
    expect(screen.getByLabelText('s1 の詳細')).toBeTruthy()
    expect(screen.getByRole('button', { name: '外部編集（未承認） 1件' })).toBeTruthy()
  })

  it('選択済み回答を承認したら、非表示行を一括削除の選択にも残さない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 's1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const p = base({
      rows: [externalRows[0]],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })
    render(<DataCockpit {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '外部編集（未承認） 1件' }))
    fireEvent.click(screen.getByLabelText('s1 を選択'))
    expect(screen.getByText('選択削除（1）')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    fireEvent.click(screen.getByRole('button', { name: '確認して承認' }))

    await waitFor(() => expect(screen.queryByLabelText('s1 の詳細')).toBeNull())
    expect(screen.queryByText('選択削除（1）')).toBeNull()
  })

  it('再取得後に件数を二重減算せず、同じ回答の新しい外部編集を再表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: 's1', externalEditApprovedAt: '2026-07-23T10:02:00+09:00' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const initial = base({
      rows: [externalRows[0]],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })
    const view = render(<DataCockpit {...initial} />)
    fireEvent.click(screen.getByRole('button', { name: '外部編集（未承認） 1件' }))
    fireEvent.click(screen.getByRole('button', { name: 's1 の外部編集を承認' }))
    fireEvent.click(screen.getByRole('button', { name: '確認して承認' }))
    await waitFor(() => expect(screen.queryByLabelText('s1 の詳細')).toBeNull())

    const otherPending = {
      ...externalRows[1],
      id: 's3',
      externalEditedAt: '2026-07-23T10:03:00+09:00',
    } as SubmissionRow
    view.rerender(<DataCockpit {...base({
      rows: [otherPending],
      total: 1,
      stats: {
        total: 1,
        verified: 0,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })} />)
    expect(screen.getByRole('button', { name: '外部編集（未承認） 1件' })).toBeTruthy()
    expect(screen.getByLabelText('s3 の詳細')).toBeTruthy()

    const reEdited = {
      ...externalRows[0],
      externalEditSource: 'sheet',
      externalEditedAt: '2026-07-23T10:04:00+09:00',
      externalEditApprovedAt: null,
    } as SubmissionRow
    view.rerender(<DataCockpit {...base({
      rows: [reEdited],
      total: 1,
      stats: {
        total: 1,
        verified: 1,
        daily: [],
        formaloo: null,
        externalEditPending: 1,
      } as DataCockpitProps['stats'],
    })} />)
    expect(screen.getByRole('button', { name: '外部編集（未承認） 1件' })).toBeTruthy()
    expect(screen.getByLabelText('s1 の詳細')).toBeTruthy()
    expect(screen.getByText('シート')).toBeTruthy()
  })
})

describe('DataCockpit — 列ヘッダー label 化 (T-A2 / form-response-display-fix)', () => {
  // 実 slug キー (owner 実機報告の 9x3BCNZW/N31hP5KP/iAGKWaBX) を answers に持つ行。
  // 既存 fixture は label 風キー (名前/電話) で bug を捕捉できていなかった穴を塞ぐ。
  const SLUG_ROWS: SubmissionRow[] = [
    { id: 's1', friendId: null, answers: { '9x3BCNZW': 'てすと', N31hP5KP: 'a@b.example.com', unknownSlug: '?' }, submittedAt: '2026-07-18T08:18:33Z', verified: false },
  ]
  const FIELD_LABELS = [
    { slug: '9x3BCNZW', label: 'お名前' },
    { slug: 'N31hP5KP', label: 'メールアドレス' },
    { slug: 'iAGKWaBX', label: 'ご要望' }, // 定義にあるが今ページの answers には無い
  ]

  it('fieldLabels が与えられると列ヘッダーを slug でなく質問 label で表示する', () => {
    render(<DataCockpit {...base({ rows: SLUG_ROWS, total: 1, fieldLabels: FIELD_LABELS })} />)
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toContain('お名前')
    expect(headers).toContain('メールアドレス')
    // 生 slug がヘッダーに残っていない (bug 再発検知)
    expect(headers).not.toContain('9x3BCNZW')
    expect(headers).not.toContain('N31hP5KP')
  })

  it('fieldLabels に無い answer-slug は slug のまま fallback 表示する', () => {
    render(<DataCockpit {...base({ rows: SLUG_ROWS, total: 1, fieldLabels: FIELD_LABELS })} />)
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toContain('unknownSlug') // 未知 slug は slug fallback
  })

  it('列順は定義 (fieldLabels) 順優先 + 定義外 answer-slug を末尾に', () => {
    render(<DataCockpit {...base({ rows: SLUG_ROWS, total: 1, fieldLabels: FIELD_LABELS })} />)
    // 回答項目ヘッダーのみ (先頭の選択チェック列・末尾の送信日時/操作列を除く)
    const labels = screen.getAllByRole('columnheader').map((th) => th.textContent).filter((t) => t && !['詳細', '外部編集', 'LINE連携', '送信日時', ''].includes(t))
    // 定義順 (お名前 → メールアドレス) が先、定義外 (unknownSlug) が末尾。iAGKWaBX は answers 不在で列化しない
    expect(labels).toEqual(['お名前', 'メールアドレス', 'unknownSlug'])
  })

  it('fieldLabels 未指定なら従来どおり answer キー union をヘッダーに出す (後方互換)', () => {
    render(<DataCockpit {...base()} />) // 既定 ROWS = 名前/電話 キー
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers).toContain('名前')
    expect(headers).toContain('電話')
  })
})

describe('DataCockpit — 送信日時 JST 表示 (T-C2 / form-response-display-fix)', () => {
  it('UTC(Z) 保存の submittedAt を JST 壁時計で表示する (08:18Z → 17:18・UTC 素通しでない)', () => {
    const rows: SubmissionRow[] = [
      { id: 'z1', friendId: null, answers: { 名前: 'てすと' }, submittedAt: '2026-07-18T08:18:33Z', verified: false },
    ]
    render(<DataCockpit {...base({ rows, total: 1 })} />)
    expect(screen.getByText('2026-07-18 17:18')).toBeTruthy()
    // UTC 素通し (08:18) が残っていないこと = bug 再発検知
    expect(screen.queryByText('2026-07-18 08:18')).toBeNull()
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
