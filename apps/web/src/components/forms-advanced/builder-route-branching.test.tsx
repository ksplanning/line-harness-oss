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
})

describe('T-D1 — choice source の分岐値は選択肢 select', () => {
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
