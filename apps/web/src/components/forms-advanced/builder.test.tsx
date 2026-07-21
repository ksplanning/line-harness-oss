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
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react'
import FormBuilder, {
  CanvasDropLayout,
  DragGhost,
  DropFeedback,
  MOUSE_ACTIVATION,
  TOUCH_ACTIVATION,
  resolveDragEnd,
} from './builder'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'
import { hasChoices, hasLength, hasMaxLength } from './field-types'

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

  it('canvas 追加と保存が同じ React batch でも最新 field を保存 payload に含める', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    act(() => {
      screen.getByLabelText('数値を追加').click()
      screen.getByText('保存').click()
    })

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields.map((field) => field.type)).toEqual(['number'])
  })

  it('既存フォームでも canvas 追加直後の保存 payload に既存 field と追加 field を含める', () => {
    const onSave = vi.fn()
    const first: HarnessField = { id: 'existing', type: 'email', label: '既存メール', required: false, position: 7, config: {} }
    render(<FormBuilder {...base({ initialFields: [first], onSave })} />)

    act(() => {
      screen.getByLabelText('数値を追加').click()
      screen.getByText('保存').click()
    })

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
    // preview ペインも 必須 バッジを描くため canvas に scope（既存 card バッジの意図を保つ）
    expect(within(screen.getByTestId('canvas')).getByText('必須')).toBeTruthy()
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

describe('FormBuilder — 入力項目の補足説明 (field-help-charlimit T-A3)', () => {
  const addLabels: Array<[string, string]> = [
    ['1行テキストを追加', 'text'],
    ['複数行テキストを追加', 'textarea'],
    ['数値を追加', 'number'],
    ['メールを追加', 'email'],
    ['電話番号を追加', 'phone'],
    ['日付を追加', 'date'],
    ['単一選択を追加', 'choice'],
    ['ドロップダウンを追加', 'dropdown'],
    ['複数選択を追加', 'multiple_select'],
    ['ファイル添付を追加', 'file'],
  ]

  it('全入力型の設定パネルに「補足説明」textarea が描画される', () => {
    render(<FormBuilder {...base()} />)
    for (const [addLabel] of addLabels) {
      fireEvent.click(screen.getByLabelText(addLabel))
      expect(screen.getByLabelText('補足説明')).toBeTruthy()
    }
  })

  it('補足説明を入力すると field.config.description に反映される (保存 payload で確認)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.change(screen.getByLabelText('補足説明'), { target: { value: '例: 日中つながる番号をご記入ください' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.description).toBe('例: 日中つながる番号をご記入ください')
  })

  it('section の設定は従来の「説明文」(config.text) のみで「補足説明」欄は出さない (別物)', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('見出し＋説明を追加'))
    expect(screen.getByLabelText('説明文')).toBeTruthy()
    expect(screen.queryByLabelText('補足説明')).toBeNull()
  })
})

describe('FormBuilder — 文字数制限の正直化 (field-help-charlimit T-A4 / OD-2 OD-3)', () => {
  it('最大文字数欄は一行テキストのみ・複数行テキストでは出さない (OD-2: Formaloo 非対応)', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    expect(screen.getByLabelText('最大文字数')).toBeTruthy()
    cleanup()
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('複数行テキストを追加'))
    expect(screen.queryByLabelText('最大文字数')).toBeNull()
  })

  it('最小文字数欄はどの型でも出さない (OD-3: Formaloo 非対応の no-op を撤去)', () => {
    for (const addLabel of ['1行テキストを追加', '複数行テキストを追加', '数値を追加']) {
      render(<FormBuilder {...base()} />)
      fireEvent.click(screen.getByLabelText(addLabel))
      expect(screen.queryByLabelText('最小文字数')).toBeNull()
      cleanup()
    }
  })

  it('hasMaxLength は一行 text のみ true (textarea/装飾は false)', () => {
    expect(hasMaxLength('text')).toBe(true)
    expect(hasMaxLength('textarea')).toBe(false)
    expect(hasMaxLength('number')).toBe(false)
    expect(hasMaxLength('section')).toBe(false)
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

describe('FormBuilder — 今すぐ同期リカバリ (① out_of_sync)', () => {
  it('out_of_sync のとき「今すぐ同期」ボタン + 原因 + 再送ヘルプを目立つ位置に出す', () => {
    render(<FormBuilder {...base({ syncStatus: 'out_of_sync', syncError: 'Formaloo credentials 未設定' })} />)
    const rec = screen.getByTestId('sync-recovery')
    expect(within(rec).getByTestId('sync-now')).toBeTruthy()
    expect(within(rec).getByTestId('sync-recovery-cause').textContent).toContain('Formaloo credentials 未設定')
    expect(rec.textContent).toContain('保存し直すと再送されます')
  })

  it('「今すぐ同期」は既存の保存/push 経路 (onSave) を再実行する (新経路を作らない)', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    render(<FormBuilder {...base({ syncStatus: 'out_of_sync', onSave })} />)
    fireEvent.click(screen.getByTestId('sync-now'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  })

  it('原因 (syncError) が無くても再送ヘルプは出す', () => {
    render(<FormBuilder {...base({ syncStatus: 'out_of_sync' })} />)
    const rec = screen.getByTestId('sync-recovery')
    expect(rec.textContent).toContain('保存し直すと再送されます')
    expect(within(rec).queryByTestId('sync-recovery-cause')).toBeNull()
  })

  it('idle (同期済み) のときは同期リカバリを出さない', () => {
    render(<FormBuilder {...base({ syncStatus: 'idle' })} />)
    expect(screen.queryByTestId('sync-recovery')).toBeNull()
  })
})

describe('FormBuilder — 公開ページを開いてテスト導線 (③)', () => {
  it('公開済み + publicUrl → 「公開ページを開いてテスト」リンク (新規タブ)', () => {
    render(<FormBuilder {...base({ status: 'published', publicUrl: 'https://demo-forms.formaloo.me/f/abc' })} />)
    const link = screen.getByTestId('open-public-page') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://demo-forms.formaloo.me/f/abc')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('未公開 → 公開すると回答者用ページが作られる案内 (リンクは出さない)', () => {
    render(<FormBuilder {...base({ status: 'draft' })} />)
    expect(screen.getByTestId('public-test-hint').textContent).toContain('公開すると')
    expect(screen.queryByTestId('open-public-page')).toBeNull()
  })

  it('公開済みだが publicUrl 未確定 → URL 準備中の案内 (リンクは出さない)', () => {
    render(<FormBuilder {...base({ status: 'published', publicUrl: null })} />)
    expect(screen.getByTestId('public-url-pending')).toBeTruthy()
    expect(screen.queryByTestId('open-public-page')).toBeNull()
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

describe('FormBuilder — realtime preview (T-C3)', () => {
  const section: HarnessField = {
    id: 'section-preview',
    type: 'section',
    label: '最初の案内',
    required: false,
    position: 0,
    config: { text: '最初の説明' },
  }
  const choice: HarnessField = {
    id: 'choice-preview',
    type: 'choice',
    label: '連絡方法',
    required: false,
    position: 1,
    config: { choices: ['メール', '電話'] },
  }

  it('タイトル・説明・装飾本文・ラベル・必須・選択肢・追加・削除を desktop preview に即時反映する', () => {
    render(<FormBuilder {...base({
      layoutMode: 'desktop',
      formTitle: '旧タイトル',
      formDescription: '旧フォーム説明',
      initialFields: [section, choice],
    })} />)

    const pane = screen.getByTestId('preview-pane')
    expect(within(pane).getByText('旧タイトル')).toBeTruthy()
    expect(within(pane).getByText('旧フォーム説明')).toBeTruthy()
    expect(within(pane).getByText('最初の案内')).toBeTruthy()
    expect(within(pane).getByText('最初の説明')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('フォームタイトル'), { target: { value: '新タイトル' } })
    fireEvent.change(screen.getByLabelText('フォーム説明'), { target: { value: '新フォーム説明' } })
    fireEvent.change(screen.getByLabelText('見出し'), { target: { value: '更新した案内' } })
    fireEvent.change(screen.getByLabelText('説明文'), { target: { value: '更新した装飾本文' } })
    expect(within(pane).getByText('新タイトル')).toBeTruthy()
    expect(within(pane).getByText('新フォーム説明')).toBeTruthy()
    expect(within(pane).getByText('更新した案内')).toBeTruthy()
    expect(within(pane).getByText('更新した装飾本文')).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('canvas')).getByText('連絡方法'))
    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: 'ご希望の連絡方法' } })
    fireEvent.click(screen.getByLabelText('必須'))
    fireEvent.change(screen.getByLabelText('選択肢1'), { target: { value: 'SMS' } })
    expect(within(pane).getByText('ご希望の連絡方法')).toBeTruthy()
    expect(within(pane).getByText('必須')).toBeTruthy()
    expect(within(pane).getByText('SMS')).toBeTruthy()
    expect(within(pane).getByText('電話')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('数値を追加'))
    expect(within(pane).getByText('数値')).toBeTruthy()
    const deleteButtons = within(screen.getByTestId('canvas')).getAllByLabelText('削除')
    fireEvent.click(deleteButtons[deleteButtons.length - 1])
    fireEvent.click(within(screen.getByTestId('canvas')).getByText('はい'))
    expect(within(pane).queryByText('数値')).toBeNull()
  })

  it('canvas の並べ替えを preview の given order に即時反映する', async () => {
    const first: HarnessField = { id: 'first-preview', type: 'text', label: '先頭項目', required: false, position: 0, config: {} }
    const second: HarnessField = { id: 'second-preview', type: 'email', label: '末尾項目', required: false, position: 1, config: {} }
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const top = this.textContent?.includes('末尾項目') ? 100 : 0
      return { x: 0, y: top, top, left: 0, right: 200, bottom: top + 40, width: 200, height: 40, toJSON: () => ({}) }
    })

    try {
      render(<FormBuilder {...base({ layoutMode: 'desktop', initialFields: [first, second] })} />)

      const pane = screen.getByTestId('preview-pane')
      expect(within(pane).getAllByTestId('preview-field').map((node) => node.textContent)).toEqual([
        expect.stringContaining('先頭項目'),
        expect.stringContaining('末尾項目'),
      ])

      const firstHandle = within(screen.getByTestId('canvas')).getAllByLabelText('ドラッグして並べ替え')[0]
      fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' })
      await screen.findByTestId('drag-ghost')
      fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
      fireEvent.keyDown(document, { key: ' ', code: 'Space' })

      await waitFor(() => expect(within(pane).getAllByTestId('preview-field').map((node) => node.textContent)).toEqual([
        expect.stringContaining('末尾項目'),
        expect.stringContaining('先頭項目'),
      ]))
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('Formaloo 再取り込み後の追加・削除・順序を preview にまとめて反映する', async () => {
    const onReimport = vi.fn(async () => ({
      ok: true,
      fields: [
        { id: 'reimport-section', type: 'section' as const, label: '再取込の案内', required: false, position: 7, config: { text: '再取込の本文' } },
        { id: 'reimport-email', type: 'email' as const, label: '再取込メール', required: true, position: 8, config: {} },
      ],
      logic: [],
    }))
    render(<FormBuilder {...base({ layoutMode: 'desktop', initialFields: [choice], onReimport })} />)

    const pane = screen.getByTestId('preview-pane')
    expect(within(pane).getByText('連絡方法')).toBeTruthy()
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))

    expect(await within(pane).findByText('再取込の案内')).toBeTruthy()
    expect(within(pane).getByText('再取込の本文')).toBeTruthy()
    expect(within(pane).getByText('再取込メール')).toBeTruthy()
    expect(within(pane).getByText('必須')).toBeTruthy()
    expect(within(pane).queryByText('連絡方法')).toBeNull()
    const orderedBlocks = Array.from(pane.querySelectorAll('[data-testid="preview-section"], [data-testid="preview-field"]'))
    expect(orderedBlocks.map((node) => node.textContent)).toEqual([
      expect.stringContaining('再取込の案内'),
      expect.stringContaining('再取込メール'),
    ])
  })
})

describe('FormBuilder — preview layout mode (T-C4)', () => {
  const field: HarnessField = { id: 'layout-field', type: 'text', label: '表示確認', required: false, position: 0, config: {} }

  it('desktop は 3 ペインと 375px preview side-pane を既定表示する', () => {
    render(<FormBuilder {...base({ layoutMode: 'desktop', initialFields: [field] })} />)

    expect(screen.queryByTestId('preview-tab-edit')).toBeNull()
    expect(screen.queryByTestId('preview-tab-preview')).toBeNull()
    expect(screen.getByTestId('palette')).toBeTruthy()
    expect(screen.getByTestId('canvas')).toBeTruthy()
    expect(screen.getByTestId('settings')).toBeTruthy()
    const pane = screen.getByTestId('preview-pane')
    expect(within(pane).getByText('表示確認')).toBeTruthy()
    expect((within(pane).getByTestId('preview-frame') as HTMLElement).style.maxWidth).toBe('375px')
  })

  it('mobile は 編集 tab が既定で、プレビュー tab と相互に表示を切り替える', () => {
    render(<FormBuilder {...base({ layoutMode: 'mobile', initialFields: [field] })} />)

    const editTab = screen.getByTestId('preview-tab-edit')
    const previewTab = screen.getByTestId('preview-tab-preview')
    expect(editTab.getAttribute('aria-pressed')).toBe('true')
    expect(previewTab.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('palette')).toBeTruthy()
    expect(screen.queryByTestId('preview-pane')).toBeNull()

    fireEvent.click(previewTab)
    expect(editTab.getAttribute('aria-pressed')).toBe('false')
    expect(previewTab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('palette')).toBeNull()
    const pane = screen.getByTestId('preview-pane')
    expect(within(pane).getByText('表示確認')).toBeTruthy()
    expect((within(pane).getByTestId('preview-frame') as HTMLElement).style.maxWidth).toBe('375px')

    fireEvent.click(editTab)
    expect(screen.getByTestId('palette')).toBeTruthy()
    expect(screen.queryByTestId('preview-pane')).toBeNull()
  })
})

describe('FormBuilder — form-design (Batch D)', () => {
  it('mobile は 編集/デザイン/プレビュー の 3 タブで、デザインタブでパネルを出す', () => {
    render(<FormBuilder {...base({ layoutMode: 'mobile' })} />)
    expect(screen.getByTestId('preview-tab-edit')).toBeTruthy()
    expect(screen.getByTestId('preview-tab-design')).toBeTruthy()
    expect(screen.getByTestId('preview-tab-preview')).toBeTruthy()
    // 初期は編集タブ (design pane 非表示)
    expect(screen.queryByTestId('design-pane')).toBeNull()
    fireEvent.click(screen.getByTestId('preview-tab-design'))
    expect(screen.getByTestId('design-pane')).toBeTruthy()
    expect(screen.getByTestId('design-panel')).toBeTruthy()
  })

  it('desktop はデザインパネルを常設し、initialDesign を保存で carry する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ layoutMode: 'desktop', initialDesign: { themeColor: '#06C755', presetId: 'line-green' }, onSave })} />)
    expect(screen.getByTestId('design-panel')).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { design?: { themeColor?: string }; designImages?: unknown }
    expect(saved.design?.themeColor).toBe('#06C755')
  })

  it('プリセット適用 → 保存で preset の配色を design に載せる', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ layoutMode: 'desktop', onSave })} />)
    fireEvent.click(screen.getByTestId('preset-deep-tide'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { design?: { presetId?: string; themeColor?: string } }
    expect(saved.design?.presetId).toBe('deep-tide')
    expect(saved.design?.themeColor).toBe('#285C66')
  })

  it('プレビューが design の色を反映する (desktop)', () => {
    render(<FormBuilder {...base({ layoutMode: 'desktop', formTitle: '色確認', initialDesign: { themeColor: '#285C66', buttonColor: '#327682' } })} />)
    const pane = screen.getByTestId('preview-pane')
    const header = within(pane).getByTestId('preview-frame').querySelector('header') as HTMLElement
    // themeColor が header の border-top に反映 (hex or rgb)
    const rgb = 'rgb(40, 92, 102)'
    expect(header.style.borderTopColor === '#285C66' || header.style.borderTopColor === rgb).toBe(true)
  })

  it('F2: 再取り込みが pull design を復元し、次 save で pull design を送る', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    const onReimport = vi.fn(async () => ({ ok: true, fields: [], logic: [], design: { themeColor: '#7D4E72', presetId: 'soft-plum' } }))
    render(<FormBuilder {...base({ layoutMode: 'desktop', onSave, onReimport, initialDesign: { themeColor: '#06C755', presetId: 'line-green' } })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(screen.getByText('はい'))
    await waitFor(() => expect(onReimport).toHaveBeenCalled())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = onSave.mock.calls[0][0] as { design?: { themeColor?: string } }
    expect(saved.design?.themeColor).toBe('#7D4E72') // stale #06C755 でなく pull 値
  })

  it('F3: soft-fail(out_of_sync) 後も pending 画像 intent を保持し再送する', async () => {
    const onSave = vi.fn(async () => ({ ok: false })) // soft-fail
    render(<FormBuilder {...base({ layoutMode: 'desktop', onSave })} />)
    const file = new File([new Uint8Array([1, 2, 3])], 'l.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('ロゴを選ぶ'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('image-preview-logo')).toBeTruthy())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as { designImages?: { logo?: { intent?: string } } }).designImages?.logo?.intent).toBe('replace')
    // soft-fail なので pending は消費されず 2 回目 save でも再送される
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect((onSave.mock.calls[1][0] as { designImages?: { logo?: { intent?: string } } }).designImages?.logo?.intent).toBe('replace')
  })

  it('F3: 成功 save は返却 design(新 S3 URL)を adopt し 2 連続 save で旧値へ revert しない', async () => {
    const onSave = vi.fn(async () => ({ ok: true, design: { logoUrl: 'https://s3/NEW.png' } }))
    render(<FormBuilder {...base({ layoutMode: 'desktop', initialDesign: { logoUrl: 'https://s3/OLD.png' }, onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect((onSave.mock.calls[1][0] as { design?: { logoUrl?: string } }).design?.logoUrl).toBe('https://s3/NEW.png')
  })
})
