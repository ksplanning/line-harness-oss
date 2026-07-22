// @vitest-environment jsdom
/**
 * form-route-branching (T-D1) — builder の jump アクション + page 飛び先 + choice 値 select + form_type 自動切替。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

afterEach(() => cleanup())

const choiceSrc: HarnessField = {
  id: 'q1', type: 'choice', label: 'ルート', required: true, position: 0,
  config: { choices: ['Aルート', 'Cルート'], choiceItems: [{ title: 'Aルート', slug: 'ciA' }, { title: 'Cルート', slug: 'ciC' }] },
}
const pageBreak: HarnessField = { id: 'pb', type: 'page_break', label: '2ページ目', required: false, position: 1, config: {} }
const textTgt: HarnessField = { id: 't1', type: 'text', label: '氏名', required: false, position: 2, config: {} }

function base(overrides = {}) {
  return { formTitle: 'テスト', status: 'draft' as const, layoutMode: 'desktop' as const, initialFields: [], initialLogic: [], onSave: vi.fn(), ...overrides }
}
function selectField(label: string) {
  fireEvent.click(within(screen.getByTestId('canvas')).getByText(label))
}

describe('T-D1 — jump アクション + page 飛び先', () => {
  it('分岐アクション select に「ページへ飛ぶ」が出る', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')
    const actionSel = screen.getByLabelText('分岐アクション') as HTMLSelectElement
    expect(Array.from(actionSel.options).map((o) => o.value)).toEqual(expect.arrayContaining(['show', 'hide', 'jump', 'skip']))
    expect(within(actionSel).getByText('ページへ飛ぶ')).toBeTruthy()
  })

  it('action=jump のとき飛び先 select は page_break を出し、show のときは非装飾 field を出す', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'jump', targetFieldId: 'pb' },
    ] })} />)
    selectField('ルート')
    const tgt = screen.getByLabelText('分岐対象') as HTMLSelectElement
    // jump: 飛び先に page_break が出る
    expect(Array.from(tgt.options).map((o) => o.value)).toContain('pb')
    // jump 飛び先に非装飾 field (氏名) は出さない
    expect(Array.from(tgt.options).map((o) => o.value)).not.toContain('t1')
  })

  it('show/hide のときは page_break を飛び先に出さない (回帰)', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')
    const tgt = screen.getByLabelText('分岐対象') as HTMLSelectElement
    expect(Array.from(tgt.options).map((o) => o.value)).not.toContain('pb')
    expect(Array.from(tgt.options).map((o) => o.value)).toContain('t1')
  })
})

describe('T-D1 — jump 選択で form_type 自動切替 + 可視通知', () => {
  it('simple フォームで action を jump に変えると通知が出て、以後 jump 飛び先が page になる', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialFormType: 'simple', initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')
    expect(screen.queryByTestId('formtype-notice')).toBeNull()
    fireEvent.change(screen.getByLabelText('分岐アクション'), { target: { value: 'jump' } })
    // 可視通知が出る (黙って不発を防ぐ)
    expect(screen.getByTestId('formtype-notice')).toBeTruthy()
    expect(screen.getByTestId('formtype-notice').textContent).toMatch(/1問ずつ表示|切り替え/)
    // 飛び先が page_break に切替わる
    const tgt = screen.getByLabelText('分岐対象') as HTMLSelectElement
    expect(tgt.value).toBe('pb')
  })

  it('multi_step フォームなら jump 選択で通知は出ない', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialFormType: 'multi_step', initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')
    fireEvent.change(screen.getByLabelText('分岐アクション'), { target: { value: 'jump' } })
    expect(screen.queryByTestId('formtype-notice')).toBeNull()
  })

  it('自前配信の一覧形式では jump を追加しても simple のまま保存する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      onSave,
      initialRenderBackend: 'internal',
      initialFields: [choiceSrc, pageBreak, textTgt],
      initialFormType: 'simple',
      initialLogic: [
        { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
      ],
    })} />)
    selectField('ルート')
    fireEvent.change(screen.getByLabelText('分岐アクション'), { target: { value: 'jump' } })
    expect(screen.queryByTestId('formtype-notice')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[0][0] as { formType: string }).formType).toBe('simple')
  })

  it('自前配信では section 全体を show/hide の対象に選べる', () => {
    const onSave = vi.fn()
    const section: HarnessField = {
      id: 'company-section', type: 'section', label: '法人向けセクション', required: false, position: 1, config: {},
    }
    render(<FormBuilder {...base({
      onSave,
      initialRenderBackend: 'internal',
      initialFields: [choiceSrc, section, textTgt],
      initialLogic: [
        { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Cルート', action: 'show', targetFieldId: 't1' },
      ],
    })} />)

    selectField('ルート')
    fireEvent.change(screen.getByLabelText('分岐対象'), { target: { value: 'company-section' } })
    fireEvent.click(screen.getByText('保存'))

    expect((onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic[0].targetFieldId).toBe('company-section')
    expect(screen.getByText(/一覧表示でも同じ分岐/)).toBeTruthy()
  })
})

describe('T-D1 — choice source の分岐値は選択肢 select', () => {
  it('分岐追加直後の先頭選択肢を触らず保存しても表示値と保存値が一致する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialFields: [choiceSrc, textTgt] })} />)
    selectField('ルート')

    fireEvent.click(screen.getByText('＋ 分岐を追加'))

    expect((screen.getByLabelText('分岐の値') as HTMLSelectElement).value).toBe('Aルート')
    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic[0].value).toBe('Aルート')
  })

  it('保存済みの空条件は先頭選択肢に見せず未選択と明示する', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, textTgt], initialLogic: [
      { id: 'empty', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')

    const valueSelect = screen.getByLabelText('分岐の値') as HTMLSelectElement
    expect(valueSelect.value).toBe('')
    expect(within(valueSelect).getByRole('option', { name: '条件値が未選択です' })).toBeTruthy()
  })

  it('保存済みの空条件は明示選択するまで保存しない', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialFields: [choiceSrc, textTgt], initialLogic: [
      { id: 'empty', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'show', targetFieldId: 't1' },
    ] })} />)
    selectField('ルート')

    fireEvent.click(screen.getByText('保存'))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/条件分岐の値を選択してください/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('分岐の値'), { target: { value: 'Aルート' } })
    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic[0].value).toBe('Aルート')
  })

  it('choice source は分岐の値を select で選ぶ (title 表示)', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak, textTgt], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'ciC', action: 'jump', targetFieldId: 'pb' },
    ] })} />)
    selectField('ルート')
    const valSel = screen.getByLabelText('分岐の値') as HTMLSelectElement
    expect(valSel.tagName).toBe('SELECT')
    // pull 由来の slug 'ciC' は title 'Cルート' として選択表示される
    expect(valSel.value).toBe('Cルート')
    expect(Array.from(valSel.options).map((o) => o.value)).toEqual(expect.arrayContaining(['Aルート', 'Cルート']))
  })

  it('選択肢を変えると rule.value に title が入る (保存で slug へ写像)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialFields: [choiceSrc, pageBreak, textTgt], initialFormType: 'multi_step', initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'Aルート', action: 'jump', targetFieldId: 'pb' },
    ] })} />)
    selectField('ルート')
    fireEvent.change(screen.getByLabelText('分岐の値'), { target: { value: 'Cルート' } })
    fireEvent.click(screen.getByText('保存'))
    const savedLogic = (onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic
    expect(savedLogic[0].value).toBe('Cルート')
  })

  it('非 choice source (text) の分岐値は自由入力 input のまま', () => {
    render(<FormBuilder {...base({ initialFields: [textTgt, choiceSrc], initialLogic: [
      { id: 'r1', sourceFieldId: 't1', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'q1' },
    ] })} />)
    selectField('氏名')
    expect((screen.getByLabelText('分岐の値') as HTMLElement).tagName).toBe('INPUT')
  })
})

describe('T-D1 — show/hide ルート活用ヘルプ (R3)', () => {
  it('条件分岐セクションに show/hide 活用の 1 行ヘルプが出る', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, pageBreak] })} />)
    selectField('ルート')
    expect(screen.getByText(/ページ単位で丸ごと分けたい時は/)).toBeTruthy()
  })
})

describe('compound-fix — 同一 source に複数 jump ルール (A/B/C) の builder UX', () => {
  // 現実的な A/B/C フォーム: 各ページに内容 field を持つ (質問+改ページ+内容)。
  const threePages: HarnessField[] = [
    { id: 'q1', type: 'choice', label: 'ルート', required: true, position: 0, config: { choices: ['A', 'B', 'C'], choiceItems: [{ title: 'A', slug: 'ciA' }, { title: 'B', slug: 'ciB' }, { title: 'C', slug: 'ciC' }] } },
    { id: 'pA', type: 'page_break', label: 'Aページ', required: false, position: 1, config: {} },
    { id: 'cA', type: 'text', label: 'A内容', required: false, position: 2, config: {} },
    { id: 'pB', type: 'page_break', label: 'Bページ', required: false, position: 3, config: {} },
    { id: 'cB', type: 'text', label: 'B内容', required: false, position: 4, config: {} },
    { id: 'pC', type: 'page_break', label: 'Cページ', required: false, position: 5, config: {} },
    { id: 'cC', type: 'text', label: 'C内容', required: false, position: 6, config: {} },
  ]
  const abcLogic: HarnessLogicRule[] = [
    { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'pA' },
    { id: 'r2', sourceFieldId: 'q1', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'pB' },
    { id: 'r3', sourceFieldId: 'q1', operator: 'equals', value: 'C', action: 'jump', targetFieldId: 'pC' },
  ]

  it('同一 source field に 3 つの jump ルールが独立行として表示され、それぞれ飛び先 page を選べる', () => {
    render(<FormBuilder {...base({ initialFields: threePages, initialFormType: 'multi_step', initialLogic: abcLogic })} />)
    selectField('ルート')
    const targets = screen.getAllByLabelText('分岐対象') as HTMLSelectElement[]
    expect(targets).toHaveLength(3)
    expect(targets.map((t) => t.value)).toEqual(['pA', 'pB', 'pC'])
    // 全て page_break を飛び先候補に持つ
    for (const t of targets) expect(Array.from(t.options).map((o) => o.value)).toEqual(expect.arrayContaining(['pA', 'pB', 'pC']))
  })

  it('3 ルールをそのまま save すると 3 つの flat rule が onSave に渡る (グルーピングは server 側)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialFields: threePages, initialFormType: 'multi_step', initialLogic: abcLogic })} />)
    fireEvent.click(screen.getByText('保存'))
    const savedLogic = (onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }).logic
    expect(savedLogic).toHaveLength(3)
    expect(savedLogic.every((r) => r.action === 'jump' && r.sourceFieldId === 'q1')).toBe(true)
    expect(savedLogic.map((r) => r.targetFieldId)).toEqual(['pA', 'pB', 'pC'])
  })

  it('分岐を追加ボタンで同一 source に 2 つ目の jump ルールを増やせる', () => {
    render(<FormBuilder {...base({ initialFields: threePages, initialFormType: 'multi_step', initialLogic: [abcLogic[0]] })} />)
    selectField('ルート')
    expect(screen.getAllByLabelText('分岐アクション')).toHaveLength(1)
    fireEvent.click(screen.getByText('＋ 分岐を追加'))
    expect(screen.getAllByLabelText('分岐アクション')).toHaveLength(2)
  })
})
