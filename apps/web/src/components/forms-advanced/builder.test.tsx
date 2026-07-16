// @vitest-environment jsdom
/**
 * FormBuilder (F-2 / T-B1) — D&D フォームビルダーの component test。
 *   - パレット → キャンバス追加 (click-to-add = 素人/375px 経路)
 *   - field 選択 → 設定 (ラベル/必須/文字数/選択肢/ファイル拡張子)
 *   - 削除は行内確認 (window.confirm 不使用 / M-16)
 *   - 保存が onSave に定義を渡す (position 再採番)
 *   - publish gate UI (in_review → 公開確認カード / draft → レビュー依頼)
 * (実 D&D drag は jsdom 非対応 → click-to-add で機能を担保。drag は browser-evaluator が実機確認。)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import FormBuilder, {
  CanvasDropLayout,
  DragGhost,
  DropFeedback,
  MOUSE_ACTIVATION,
  TOUCH_ACTIVATION,
  resolveDragEnd,
} from './builder'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'
import { hasChoices, hasLength } from './field-types'

afterEach(() => cleanup())

function base(overrides = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('FormBuilder — パレット & 追加 (T-B1)', () => {
  it('パレットに日本語 field 種別を出す (英語 type 名を見せない)', () => {
    render(<FormBuilder {...base()} />)
    const palette = screen.getByTestId('palette')
    expect(within(palette).getByText('1行テキスト')).toBeTruthy()
    expect(within(palette).getByText('単一選択')).toBeTruthy()
    expect(within(palette).getByText('ファイル添付')).toBeTruthy()
    expect(within(palette).getByText('見出し＋説明')).toBeTruthy()
    expect(within(palette).getByText('改ページ')).toBeTruthy()
    // MVP subset 外は無い
    expect(within(palette).queryByText('マトリクス')).toBeNull()
  })

  it('パレット項目をタップするとキャンバスに追加される', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).getByText('1行テキスト')).toBeTruthy()
  })

  it('空状態のガイドが出る', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByText(/パレットから項目を/)).toBeTruthy()
  })

  it('タップ追加は末尾へ追加し、position を 0 から再採番する (T-A5)', () => {
    const onSave = vi.fn()
    const first: HarnessField = { id: 'a', type: 'email', label: '先頭', required: false, position: 9, config: {} }
    render(<FormBuilder {...base({ initialFields: [first], onSave })} />)
    fireEvent.click(screen.getByLabelText('数値を追加'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields.map((field) => field.type)).toEqual(['email', 'number'])
    expect(saved.fields.map((field) => field.position)).toEqual([0, 1])
  })
})

describe('FormBuilder — DnD activation と resolver (T-A1/T-A2)', () => {
  it('マウスは 8px、タッチは delay+tolerance で起動する', () => {
    expect(MOUSE_ACTIVATION.distance).toBe(8)
    expect(TOUCH_ACTIVATION.delay).toBeGreaterThan(0)
    expect(TOUCH_ACTIVATION.tolerance).toBeGreaterThan(0)
    expect('distance' in TOUCH_ACTIVATION).toBe(false)
  })

  it('drag end の全分岐を決定的に解決する', () => {
    expect(resolveDragEnd('palette:text', 'canvas', ['a', 'b'])).toEqual({ kind: 'add', type: 'text', index: null })
    expect(resolveDragEnd('palette:text', 'a', ['a', 'b'])).toEqual({ kind: 'add', type: 'text', index: 0 })
    expect(resolveDragEnd('palette:text', 'b', ['a', 'b'])).toEqual({ kind: 'add', type: 'text', index: 1 })
    expect(resolveDragEnd('palette:text', null, ['a', 'b'])).toEqual({ kind: 'outside' })
    expect(resolveDragEnd('a', 'b', ['a', 'b'])).toEqual({ kind: 'sort', from: 'a', to: 'b' })
    expect(resolveDragEnd('a', 'a', ['a', 'b'])).toEqual({ kind: 'noop' })
    expect(resolveDragEnd('a', null, ['a', 'b'])).toEqual({ kind: 'noop' })
  })
})

describe('FormBuilder — drag visual feedback (T-A3/T-A4)', () => {
  const fields: HarnessField[] = [
    { id: 'a', type: 'text', label: 'お名前', required: false, position: 0, config: {} },
    { id: 'b', type: 'email', label: 'メール欄', required: false, position: 1, config: {} },
  ]

  it('パレット drag ghost は日本語ラベルを表示する', () => {
    render(<DragGhost activeDragId="palette:text" fields={[]} />)
    expect(screen.getByTestId('drag-ghost').textContent).toContain('1行テキスト')
  })

  it('既存 field の drag ghost は field ラベルを表示する', () => {
    render(<DragGhost activeDragId="b" fields={fields} />)
    expect(screen.getByTestId('drag-ghost').textContent).toContain('メール欄')
  })

  it('palette-over-field は対象 field の直前に placeholder を置き、canvas を active にする', () => {
    render(
      <CanvasDropLayout activeDragId="palette:text" overId="b" fieldIds={['a', 'b']}>
        <div data-testid="field-a">A</div>
        <div data-testid="field-b">B</div>
      </CanvasDropLayout>,
    )
    const layout = screen.getByTestId('canvas-drop-layout')
    expect(layout.getAttribute('data-canvas-active')).toBe('true')
    expect(Array.from(layout.children).map((node) => node.getAttribute('data-testid'))).toEqual([
      'field-a',
      'drop-placeholder',
      'field-b',
    ])
  })

  it('canvas 上では placeholder を field 一覧の末尾に置く', () => {
    render(
      <CanvasDropLayout activeDragId="palette:text" overId="canvas" fieldIds={['a', 'b']}>
        <div data-testid="field-a">A</div>
        <div data-testid="field-b">B</div>
      </CanvasDropLayout>,
    )
    const layout = screen.getByTestId('canvas-drop-layout')
    expect(Array.from(layout.children).map((node) => node.getAttribute('data-testid'))).toEqual([
      'field-a',
      'field-b',
      'drop-placeholder',
    ])
  })

  it('outside feedback は初期状態ではなく、message がある時だけ表示する', () => {
    const { rerender } = render(<DropFeedback message={null} />)
    expect(screen.queryByTestId('drop-feedback')).toBeNull()
    rerender(<DropFeedback message="ここには置けません。キャンバスの上でカードを離してください" />)
    expect(screen.getByTestId('drop-feedback').textContent).toContain('ここには置けません')
  })

  it('builder の DragOverlay は drag 前には空である', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByTestId('drag-overlay').childElementCount).toBe(0)
    expect(screen.queryByTestId('drag-ghost')).toBeNull()
    expect(screen.queryByTestId('drop-feedback')).toBeNull()
  })

  it('KeyboardSensor で palette drag を開始し、Escape で ghost と highlight を消す', async () => {
    render(<FormBuilder {...base()} />)
    const paletteItem = screen.getByLabelText('1行テキストを追加')
    fireEvent.keyDown(paletteItem, { key: ' ', code: 'Space' })

    expect(await screen.findByTestId('drag-ghost')).toBeTruthy()
    expect(screen.getByTestId('canvas').getAttribute('data-canvas-active')).toBe('true')

    await waitFor(() => expect(screen.getByTestId('drag-overlay').childElementCount).toBeGreaterThan(0))
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('drag-ghost')).toBeNull())
    expect(screen.getByTestId('drag-overlay').childElementCount).toBe(0)
    expect(screen.getByTestId('canvas').getAttribute('data-canvas-active')).toBe('false')
  })

  it('KeyboardSensor で空 canvas へ drop すると field を追加する', async () => {
    render(<FormBuilder {...base()} />)
    fireEvent.keyDown(screen.getByLabelText('1行テキストを追加'), { key: ' ', code: 'Space' })
    await screen.findByTestId('drag-ghost')

    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    expect(await within(screen.getByTestId('canvas')).findByText('1行テキスト')).toBeTruthy()
    expect(screen.queryByTestId('drop-feedback')).toBeNull()
  })

  it('field card の drag handle はキーボード操作できる', () => {
    render(<FormBuilder {...base({ initialFields: [fields[0]] })} />)
    const handle = screen.getByLabelText('ドラッグして並べ替え')
    expect(handle.getAttribute('role')).toBe('button')
    expect(handle.getAttribute('tabindex')).toBe('0')
  })
})

describe('FormBuilder — 設定パネル', () => {
  it('field 選択でラベルを編集するとカードに反映', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    // 追加時に自動選択 → 設定パネルのラベル入力を編集
    const labelInput = screen.getByLabelText('ラベル') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'お名前' } })
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).getByText('お名前')).toBeTruthy()
  })

  it('必須チェックで必須バッジが出る', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('必須'))
    expect(screen.getByText('必須')).toBeTruthy()
  })

  it('テキストは最大文字数、選択は選択肢、ファイルは拡張子の設定が出る', () => {
    render(<FormBuilder {...base()} />)
    // text → maxLength
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    expect(screen.getByLabelText('最大文字数')).toBeTruthy()
    // choice → 選択肢
    fireEvent.click(screen.getByLabelText('単一選択を追加'))
    expect(screen.getByLabelText('選択肢1')).toBeTruthy()
    // file → 拡張子
    fireEvent.click(screen.getByLabelText('ファイル添付を追加'))
    expect(screen.getByLabelText('許可拡張子')).toBeTruthy()
    expect(screen.getByLabelText('複数ファイル許可')).toBeTruthy()
  })
})

describe('FormBuilder — 装飾ブロック (T-B5/T-B10)', () => {
  it('見出し＋説明を追加し、見出しと説明だけを編集してカードへ反映できる', () => {
    render(<FormBuilder {...base()} />)

    fireEvent.click(screen.getByLabelText('見出し＋説明を追加'))

    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).getByText('見出し＋説明')).toBeTruthy()
    expect(screen.getByLabelText('見出し')).toBeTruthy()
    expect(screen.getByLabelText('説明文')).toBeTruthy()
    expect(screen.queryByLabelText('必須')).toBeNull()
    expect(screen.queryByLabelText('最大文字数')).toBeNull()
    expect(screen.queryByLabelText('選択肢1')).toBeNull()
    expect(screen.queryByLabelText('許可拡張子')).toBeNull()
    expect(screen.queryByText(/条件分岐（この項目/)).toBeNull()

    fireEvent.change(screen.getByLabelText('見出し'), { target: { value: 'ご利用前の案内' } })
    fireEvent.change(screen.getByLabelText('説明文'), { target: { value: '注意事項をお読みください' } })
    expect(within(canvas).getByText('ご利用前の案内')).toBeTruthy()
    expect(within(canvas).getByText('注意事項をお読みください')).toBeTruthy()
    expect(within(canvas).queryByText('必須')).toBeNull()
  })

  it('改ページを追加すると divider 表示になり、任意ラベル以外の入力設定を出さない', () => {
    render(<FormBuilder {...base()} />)

    fireEvent.click(screen.getByLabelText('改ページを追加'))

    expect(within(screen.getByTestId('canvas')).getByText('改ページ')).toBeTruthy()
    expect(screen.getByLabelText('ラベル(任意)')).toBeTruthy()
    expect(screen.queryByLabelText('説明文')).toBeNull()
    expect(screen.queryByLabelText('必須')).toBeNull()
    expect(screen.queryByLabelText('複数ファイル許可')).toBeNull()
    expect(screen.queryByText(/条件分岐（この項目/)).toBeNull()
  })

  it('新規 section は config.text=""、装飾は choices/length を持たない', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('見出し＋説明を追加'))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0]).toMatchObject({ type: 'section', required: false, position: 0, config: { text: '' } })
    expect(hasChoices('section')).toBe(false)
    expect(hasLength('section')).toBe(false)
    expect(hasChoices('page_break')).toBe(false)
    expect(hasLength('page_break')).toBe(false)
  })
})

describe('FormBuilder — 装飾を条件分岐から除外 (T-B9)', () => {
  const source: HarnessField = { id: 'source', type: 'text', label: '回答元', required: false, position: 0, config: {} }
  const target: HarnessField = { id: 'target', type: 'email', label: '通常の分岐先', required: false, position: 1, config: {} }
  const section: HarnessField = { id: 'section', type: 'section', label: '案内見出し', required: false, position: 2, config: { text: '案内本文' } }
  const validRule: HarnessLogicRule = {
    id: 'valid', sourceFieldId: source.id, operator: 'equals', value: 'はい', action: 'show', targetFieldId: target.id,
  }

  it('装飾は既存 rule の target options に出ず、装飾自身には条件分岐 UI がない', () => {
    const staleRule: HarnessLogicRule = {
      id: 'stale', sourceFieldId: source.id, operator: 'equals', value: '旧値', action: 'hide', targetFieldId: section.id,
    }
    render(<FormBuilder {...base({ initialFields: [source, target, section], initialLogic: [validRule, staleRule] })} />)

    for (const select of screen.getAllByLabelText('分岐対象') as HTMLSelectElement[]) {
      expect(Array.from(select.options).map((option) => option.value)).not.toContain(section.id)
    }

    fireEvent.click(within(screen.getByTestId('canvas')).getByText('案内見出し'))
    expect(screen.queryByText(/条件分岐（この項目/)).toBeNull()
    expect(screen.queryByText('＋ 分岐を追加')).toBeNull()
  })

  it('装飾追加では既存 rule を変えず、分岐先候補が装飾だけなら追加できない', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [source, target], initialLogic: [validRule], onSave })} />)

    fireEvent.click(screen.getByLabelText('見出し＋説明を追加'))
    fireEvent.click(within(screen.getByTestId('canvas')).getByText('回答元'))
    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic).toEqual([validRule])

    cleanup()
    render(<FormBuilder {...base({ initialFields: [source, section] })} />)
    expect((screen.getByText('＋ 分岐を追加') as HTMLButtonElement).disabled).toBe(true)
  })

  it('装飾削除は flat/conditions[]/actions[] の参照 rule を除き、無関係な rule を保持する', () => {
    const onSave = vi.fn()
    const conditionRef: HarnessLogicRule = {
      id: 'condition-ref', sourceFieldId: source.id, operator: 'equals', value: 'x', action: 'show', targetFieldId: target.id,
      conditions: [{ sourceFieldId: section.id, operator: 'is', value: 'x' }],
    }
    const actionRef: HarnessLogicRule = {
      id: 'action-ref', sourceFieldId: source.id, operator: 'equals', value: 'x', action: 'show', targetFieldId: target.id,
      actions: [{ action: 'show', targetFieldId: section.id }],
    }
    const flatRef: HarnessLogicRule = {
      id: 'flat-ref', sourceFieldId: section.id, operator: 'equals', value: 'x', action: 'show', targetFieldId: target.id,
    }
    render(<FormBuilder {...base({ initialFields: [source, target, section], initialLogic: [validRule, conditionRef, actionRef, flatRef], onSave })} />)

    const canvas = screen.getByTestId('canvas')
    fireEvent.click(within(canvas).getAllByLabelText('削除')[2])
    fireEvent.click(within(canvas).getByText('はい'))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[]; logic: HarnessLogicRule[] }
    expect(saved.fields.map((field) => field.id)).toEqual([source.id, target.id])
    expect(saved.fields.map((field) => field.position)).toEqual([0, 1])
    expect(saved.logic).toEqual([validRule])
  })
})

describe('FormBuilder — 削除 (M-16 行内確認)', () => {
  it('削除は window.confirm でなく行内で はい/いいえ', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('削除'))
    // 行内確認が出る (native confirm でない)
    expect(screen.getByText('削除しますか？')).toBeTruthy()
    fireEvent.click(screen.getByText('はい'))
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).queryByText('1行テキスト')).toBeNull()
  })
})

describe('FormBuilder — 保存', () => {
  it('保存で onSave に fields を渡す (position 採番)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('数値を追加'))
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledTimes(1)
    const def = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(def.fields.map((f) => f.type)).toEqual(['text', 'number'])
    expect(def.fields.map((f) => f.position)).toEqual([0, 1])
  })

  it('タイトルと説明を編集して保存 payload に含め、説明の空文字も明示送信する (T-B6)', async () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ formTitle: '旧タイトル', formDescription: '旧説明', onSave })} />)

    fireEvent.change(screen.getByLabelText('フォームタイトル'), { target: { value: '新タイトル' } })
    fireEvent.change(screen.getByLabelText('フォーム説明'), { target: { value: '新説明' } })
    fireEvent.click(screen.getByText('保存'))
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: '新タイトル', description: '新説明' })

    await waitFor(() => expect(screen.getByText('保存')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('フォーム説明'), { target: { value: '' } })
    fireEvent.click(screen.getByText('保存'))
    expect(onSave.mock.calls[1][0]).toMatchObject({ title: '新タイトル', description: '' })
  })

  it('空白だけのタイトルでは保存できない (T-B6)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.change(screen.getByLabelText('フォームタイトル'), { target: { value: '   ' } })
    const save = screen.getByText('保存') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('装飾 drag を sort として解決し、並べ替え後の再採番・保存→再読込でも config.text を保持する (T-B10)', () => {
    const onSave = vi.fn()
    const section: HarnessField = { id: 'section', type: 'section', label: '先頭の案内', required: false, position: 8, config: { text: '保持する本文' } }
    const input: HarnessField = { id: 'input', type: 'text', label: '入力欄', required: false, position: 9, config: {} }
    expect(resolveDragEnd(section.id, input.id, [section.id, input.id])).toEqual({ kind: 'sort', from: section.id, to: input.id })
    const view = render(<FormBuilder {...base({ initialFields: [input, section], onSave })} />)

    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields.map((field) => field.id)).toEqual(['input', 'section'])
    expect(saved.fields.map((field) => field.position)).toEqual([0, 1])
    expect(saved.fields[1].config.text).toBe('保持する本文')

    view.unmount()
    render(<FormBuilder {...base({ initialFields: saved.fields })} />)
    expect(within(screen.getByTestId('canvas')).getByText('保持する本文')).toBeTruthy()
  })
})

describe('FormBuilder — publish gate UI (T-B3 / N-7)', () => {
  it('draft はレビュー依頼ボタン', () => {
    const onSubmitForReview = vi.fn()
    render(<FormBuilder {...base({ status: 'draft', onSubmitForReview })} />)
    fireEvent.click(screen.getByText('レビュー依頼'))
    expect(onSubmitForReview).toHaveBeenCalled()
  })

  it('in_review は公開ボタン → 確認カード → 公開する で onPublish', () => {
    const onPublish = vi.fn()
    render(<FormBuilder {...base({ status: 'in_review', onPublish })} />)
    fireEvent.click(screen.getByText('公開'))
    expect(screen.getByTestId('publish-confirm')).toBeTruthy()
    fireEvent.click(screen.getByText('公開する'))
    expect(onPublish).toHaveBeenCalled()
  })

  it('out_of_sync は未同期バッジ', () => {
    render(<FormBuilder {...base({ syncStatus: 'out_of_sync' })} />)
    expect(screen.getByTestId('sync-badge')).toBeTruthy()
  })
})

describe('FormBuilder — drift badge (T-D2 / formaloo-auto-pull)', () => {
  it("driftStatus='detected' → 「更新あり (要確認)」+ 再取り込み誘導", () => {
    render(<FormBuilder {...base({ driftStatus: 'detected', syncStatus: 'idle' })} />)
    const badge = screen.getByTestId('sync-badge')
    expect(badge.textContent).toContain('更新あり (要確認)')
    expect(badge.textContent).toContain('Formaloo から再取り込み') // 誘導文言
  })

  it("driftStatus='conflict' → 「競合 (要確認)」(sync out_of_sync より優先)", () => {
    render(<FormBuilder {...base({ driftStatus: 'conflict', syncStatus: 'out_of_sync' })} />)
    expect(screen.getByTestId('sync-badge').textContent).toContain('競合 (要確認)')
  })

  it("driftStatus='applied' → 「自動反映しました」(誘導なし)", () => {
    render(<FormBuilder {...base({ driftStatus: 'applied', syncStatus: 'idle' })} />)
    const badge = screen.getByTestId('sync-badge')
    expect(badge.textContent).toContain('自動反映しました')
    expect(badge.textContent).not.toContain('再取り込み')
  })

  it("drift なし + idle → badge なし", () => {
    render(<FormBuilder {...base({ driftStatus: 'none', syncStatus: 'idle' })} />)
    expect(screen.queryByTestId('sync-badge')).toBeNull()
  })
})

describe('FormBuilder — Formaloo 再取り込み (pull / N-8 / B2/B3)', () => {
  const existing: HarnessField = { id: 'ex1', type: 'text', label: '既存項目', required: false, position: 0, config: {} }

  it('再取り込み → 行内確認(M-16) → はい で ok:true 時 editor を置換', async () => {
    const onReimport = vi.fn(async () => ({
      ok: true,
      fields: [{ id: 'new1', type: 'text' as const, label: '新項目', required: false, position: 0, config: {} }],
      logic: [],
    }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    // 行内確認 (window.confirm 不使用 / M-16)
    const confirm = screen.getByTestId('reimport-confirm')
    fireEvent.click(within(confirm).getByText('はい'))
    const canvas = screen.getByTestId('canvas')
    expect(await within(canvas).findByText('新項目')).toBeTruthy()
    expect(within(canvas).queryByText('既存項目')).toBeNull()
    expect(onReimport).toHaveBeenCalledTimes(1)
  })

  it('ok:false は editor を保持 (B2 = 失敗時に空へ潰さない)', async () => {
    const onReimport = vi.fn(async () => ({ ok: false, fields: [], logic: [], note: 'x' }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    await screen.findByText('Formaloo から再取り込み') // reimporting 解除まで待つ
    expect(within(screen.getByTestId('canvas')).getByText('既存項目')).toBeTruthy()
  })

  it('null 返却でも editor を保持', async () => {
    const onReimport = vi.fn(async () => null)
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    await screen.findByText('Formaloo から再取り込み')
    expect(within(screen.getByTestId('canvas')).getByText('既存項目')).toBeTruthy()
  })

  it('いいえ で no-op (onReimport 未呼び出し)', () => {
    const onReimport = vi.fn()
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('いいえ'))
    expect(onReimport).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reimport-confirm')).toBeNull()
  })

  it('実行中はボタン disabled (二重実行防止)', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    const onReimport = vi.fn(() => new Promise((r) => { resolveFn = r }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    const btn = screen.getByText('取り込み中...') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
    resolveFn({ ok: true, fields: [], logic: [] })
    await screen.findByText('Formaloo から再取り込み')
  })

  it('onReimport 未指定なら再取り込みボタンは出ない', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.queryByText('Formaloo から再取り込み')).toBeNull()
  })
})
